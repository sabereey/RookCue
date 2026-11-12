import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { DomainError } from "../domain/errors.js";

type RootLockOptions = {
  retryMs?: number;
  staleMs?: number;
  timeoutMs?: number;
};

const heldRoots = new AsyncLocalStorage<Set<string>>();
const processQueues = new Map<string, Promise<void>>();
const hostKey = createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
const ownerPattern = new RegExp(`^owner-${hostKey}-([1-9]\\d{0,9})-[a-f0-9-]{36}$`);

export function withRootLock<T>(
  root: string,
  operation: () => Promise<T>,
  options: RootLockOptions = {},
): Promise<T> {
  return withFileLock(root, operation, options, acquireFileLock);
}

/** Recover abandoned lock owners using process liveness on this machine. */
export function withLocalRootLock<T>(
  root: string,
  operation: () => Promise<T>,
  options: RootLockOptions = {},
): Promise<T> {
  return withFileLock(root, operation, options, acquireLocalFileLock);
}

async function withFileLock<T>(
  root: string,
  operation: () => Promise<T>,
  options: RootLockOptions,
  acquire: (root: string, options: RootLockOptions) => Promise<() => Promise<void>>,
): Promise<T> {
  const key = resolve(root);
  if (heldRoots.getStore()?.has(key)) {
    return operation();
  }

  return withProcessQueue(key, async () => {
    const releaseFileLock = await acquire(key, options);
    const nextHeld = new Set(heldRoots.getStore() ?? []);
    nextHeld.add(key);
    try {
      return await heldRoots.run(nextHeld, operation);
    } finally {
      await releaseFileLock();
    }
  });
}

async function acquireFileLock(
  root: string,
  options: RootLockOptions,
): Promise<() => Promise<void>> {
  const retryMs = options.retryMs ?? 10;
  const staleMs = options.staleMs ?? 300_000;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const lockPath = join(root, ".mutation.lock");
  const startedAt = Date.now();
  await mkdir(root, { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isCode(error, "EEXIST")) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }

      if (await isStale(lockPath, staleMs)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new DomainError("ROOT_LOCK_TIMEOUT", "Timed out waiting for root mutation lock", {
          root,
          timeoutMs,
        });
      }
      await delay(retryMs);
    }
  }
}

async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const details = await stat(lockPath);
    return Date.now() - details.mtimeMs >= staleMs;
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}

async function acquireLocalFileLock(
  root: string,
  options: RootLockOptions,
): Promise<() => Promise<void>> {
  const retryMs = options.retryMs ?? 10;
  const staleMs = options.staleMs ?? 300_000;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const lockPath = join(root, ".mutation.lock");
  const startedAt = Date.now();
  await mkdir(root, { recursive: true });

  const owner = ownerName();
  const stagingPath = `${lockPath}.preparing-${owner}`;
  await mkdir(stagingPath, { mode: 0o700 });
  try {
    await writeFile(join(stagingPath, owner), "", { flag: "wx" });
    while (true) {
      if (await publishLock(stagingPath, lockPath)) {
        return async () => {
          await retireLock(lockPath, owner);
        };
      }

      if (await recoverAbandonedLock(lockPath, staleMs)) {
        continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new DomainError("ROOT_LOCK_TIMEOUT", "Timed out waiting for root mutation lock", {
          root,
          timeoutMs,
        });
      }
      await delay(retryMs);
    }
  } catch (error) {
    await removePrivateLock(stagingPath);
    throw error;
  }
}

async function publishLock(stagingPath: string, lockPath: string): Promise<boolean> {
  try {
    // Reserving the path first also excludes an older client initializing its own lock.
    await mkdir(lockPath);
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  }

  try {
    // A rename can replace the empty reservation, but cannot replace an occupied lock.
    await rename(stagingPath, lockPath);
    return true;
  } catch (error) {
    if (isCode(error, "EEXIST") || isCode(error, "ENOTEMPTY")) return false;
    throw error;
  }
}

async function recoverAbandonedLock(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const details = await lstat(lockPath);
    if (!details.isDirectory()) return false;
    const entries = await readdir(lockPath, { withFileTypes: true });
    if (entries.length === 0 && Date.now() - details.mtimeMs >= staleMs) {
      try {
        await rmdir(lockPath);
        return true;
      } catch (error) {
        if (isCode(error, "ENOTEMPTY") || isCode(error, "EEXIST")) return false;
        throw error;
      }
    }

    const [owner] = entries;
    if (entries.length !== 1 || !owner?.isFile()) return false;
    const match = owner.name.match(ownerPattern);
    // Legacy owner.json and markers from other hosts have no locally fenceable owner.
    if (!match || !isDeadProcess(Number(match[1]))) return false;
    return await retireLock(lockPath, owner.name);
  } catch (error) {
    if (isCode(error, "ENOENT")) return true;
    if (isCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function retireLock(lockPath: string, owner: string): Promise<boolean> {
  const claimant = ownerName();
  try {
    if (!(await lstat(lockPath)).isDirectory()) return false;
    // Claim the exact generation while keeping the directory occupied. If this process
    // dies after the claim, a later contender can recover the claimant's marker.
    await rename(join(lockPath, owner), join(lockPath, claimant));
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return false;
    throw error;
  }

  const retiredPath = `${lockPath}.retired-${claimant}`;
  await rename(lockPath, retiredPath);
  await removePrivateLock(retiredPath);
  return true;
}

async function removePrivateLock(path: string): Promise<void> {
  // Temporary paths cannot block acquisition. A cleanup error should not obscure
  // an acquisition failure or report failure after the lock has been released.
  await rm(path, { recursive: true, force: true }).catch(() => {});
}

function ownerName(): string {
  return `owner-${hostKey}-${process.pid}-${randomUUID()}`;
}

function isDeadProcess(pid: number): boolean {
  if (pid > 2_147_483_647) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isCode(error, "ESRCH");
  }
}

async function withProcessQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = processQueues.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.then(() => gate);
  processQueues.set(key, tail);
  await previous;

  try {
    return await operation();
  } finally {
    release();
    if (processQueues.get(key) === tail) {
      processQueues.delete(key);
    }
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
