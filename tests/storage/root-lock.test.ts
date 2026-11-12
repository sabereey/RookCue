import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { withLocalRootLock, withRootLock } from "../../src/storage/root-lock.js";

const createdPaths: string[] = [];
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("storage/root-lock", () => {
  it("recovers a stale lock on a shared root by age", async () => {
    const root = await mkdtemp(join(tmpdir(), "growth-memory-lock-"));
    createdPaths.push(root);
    const lockPath = join(root, ".mutation.lock");
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid }));

    await expect(withRootLock(root, async () => "entered", { staleMs: 0, timeoutMs: 100 }))
      .resolves.toBe("entered");
  });

  it("serializes mutations across separate Node processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "growth-memory-lock-"));
    createdPaths.push(root);
    const logPath = join(root, "sequence.log");

    await Promise.all([
      startLockProcess(root, logPath, "one").completed,
      startLockProcess(root, logPath, "two").completed,
    ]);

    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(lines).toSatisfy((items: string[]) =>
      [
        ["enter:one", "exit:one", "enter:two", "exit:two"],
        ["enter:two", "exit:two", "enter:one", "exit:one"],
      ].some((expected) => JSON.stringify(expected) === JSON.stringify(items)),
    );
  });

  it("lets competing processes recover a lock immediately after its owner is killed", async () => {
    const root = await mkdtemp(join(tmpdir(), "growth-memory-lock-"));
    createdPaths.push(root);
    const logPath = join(root, "sequence.log");
    const owner = startLockProcess(root, logPath, "killed", "10000");

    try {
      await expect.poll(() => readFile(logPath, "utf8")).toBe("enter:killed\n");
      const exited = once(owner.child, "exit");
      owner.child.kill("SIGKILL");
      await expect(exited).resolves.toEqual([null, "SIGKILL"]);

      await Promise.all([
        startLockProcess(root, logPath, "one", "100", "2000").completed,
        startLockProcess(root, logPath, "two", "100", "2000").completed,
      ]);

      expect((await readFile(logPath, "utf8")).trim().split("\n")).toSatisfy((items: string[]) =>
        [
          ["enter:killed", "enter:one", "exit:one", "enter:two", "exit:two"],
          ["enter:killed", "enter:two", "exit:two", "enter:one", "exit:one"],
        ].some((expected) => JSON.stringify(expected) === JSON.stringify(items)),
      );
      expect(await readdir(root)).toEqual(["sequence.log"]);
    } finally {
      owner.child.kill();
      await owner.completed.catch(() => {});
    }
  });

  it("recovers a stale empty lock directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "growth-memory-lock-"));
    createdPaths.push(root);
    await mkdir(join(root, ".mutation.lock"));

    await expect(withLocalRootLock(root, async () => "entered", { staleMs: 0, timeoutMs: 100 }))
      .resolves.toBe("entered");
    expect(await readdir(root)).toEqual([]);
  });

  it("preserves a legacy lock with a fixed owner filename", async () => {
    const root = await mkdtemp(join(tmpdir(), "growth-memory-lock-"));
    createdPaths.push(root);
    const lockPath = join(root, ".mutation.lock");
    await mkdir(lockPath);
    const ownerPath = join(lockPath, "owner.json");
    const owner = JSON.stringify({ pid: process.pid });
    await writeFile(ownerPath, owner);

    await expect(withLocalRootLock(root, async () => {}, { staleMs: 0, timeoutMs: 100 }))
      .rejects.toMatchObject({ code: "ROOT_LOCK_TIMEOUT" });
    await expect(readFile(ownerPath, "utf8")).resolves.toBe(owner);
  });

  it("preserves a symlink at the lock path and its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "growth-memory-lock-"));
    createdPaths.push(root);
    const lockPath = join(root, ".mutation.lock");
    const target = join(root, "target");
    await mkdir(target);
    await symlink(target, lockPath, "dir");

    await expect(withLocalRootLock(root, async () => {}, { staleMs: 0, timeoutMs: 100 }))
      .rejects.toMatchObject({ code: "ROOT_LOCK_TIMEOUT" });
    expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
    expect(await readdir(target)).toEqual([]);
  });

  it("waits for a live owner even when the lock is older than the stale threshold", async () => {
    const root = await mkdtemp(join(tmpdir(), "growth-memory-lock-"));
    createdPaths.push(root);
    const logPath = join(root, "sequence.log");
    const owner = startLockProcess(root, logPath, "live", "10000");

    try {
      await expect.poll(() => readFile(logPath, "utf8")).toBe("enter:live\n");
      await expect(withLocalRootLock(root, async () => {}, { staleMs: 0, timeoutMs: 100 }))
        .rejects.toMatchObject({ code: "ROOT_LOCK_TIMEOUT" });
    } finally {
      owner.child.kill();
      await owner.completed.catch(() => {});
    }
  });
});

function startLockProcess(root: string, logPath: string, id: string, ...options: string[]) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/root-lock-process.ts", root, logPath, id, ...options],
    { cwd: repoRoot, stdio: "pipe" },
  );
  const completed = new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`lock process ${id} exited ${code}: ${stderr}`));
    });
  });
  void completed.catch(() => {});
  return { child, completed };
}
