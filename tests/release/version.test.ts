import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const script = join(process.cwd(), "scripts/release/version.mjs");
const manifest = "plugins/growth-memory/skills/growth-memory/scripts/runtime.json";
const plugin = "plugins/growth-memory/.codex-plugin/plugin.json";
const shellVersion = "plugins/growth-memory/skills/growth-memory/scripts/runtime-version";
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rookcue-version-")); roots.push(root);
  const version = "0.1.0-beta.8";
  for (const [path, data] of Object.entries({
    "package.json": { version }, "package-lock.json": { version, packages: { "": { version } } },
    [plugin]: { version }, [manifest]: { version, sourceCommit: "a".repeat(40), sourceUrl: `https://codeload.github.com/sabereey/RookCue/tar.gz/${"a".repeat(40)}`, sourceSha256: "b".repeat(64) },
  })) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), JSON.stringify(data)); }
  await writeFile(join(root, shellVersion), version + "\n");
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
  return { root, run };
}
it("bumps every product identity together without silently repinning source", async () => {
  const f = await fixture();
  const result = f.run("bump", "0.1.0-beta.9"); expect(result.status, result.stderr).toBe(0);
  for (const path of ["package.json", "package-lock.json", plugin, manifest]) expect(JSON.parse(await readFile(join(f.root, path), "utf8")).version).toBe("0.1.0-beta.9");
  expect(JSON.parse(await readFile(join(f.root, "package-lock.json"), "utf8")).packages[""].version).toBe("0.1.0-beta.9");
  expect(JSON.parse(await readFile(join(f.root, manifest), "utf8")).sourceCommit).toBe("a".repeat(40));
  expect(await readFile(join(f.root, shellVersion), "utf8")).toBe("0.1.0-beta.9\n");
  expect(f.run("check", "v0.1.0-beta.9").status).toBe(0);
  expect(f.run("check", "v0.1.0-beta.8").status).not.toBe(0);
});
it.each(["package-lock.json", plugin, manifest, shellVersion])("rejects version drift in %s", async path => {
  const f = await fixture();
  expect(f.run("check").status).toBe(0);
  const file = join(f.root, path);
  await writeFile(file, (await readFile(file, "utf8")).replaceAll("0.1.0-beta.8", "0.1.0-beta.7"));
  expect(f.run("check").status).not.toBe(0);
});
it.each(["v1.0.0", "1.0", "01.0.0", "1.0.0-beta.01", "1.0.0;echo bad"])("rejects malformed versions without modifying files: %s", async version => {
  const f = await fixture(); const before = await readFile(join(f.root, "package.json"), "utf8");
  expect(f.run("bump", version).status).not.toBe(0);
  expect(await readFile(join(f.root, "package.json"), "utf8")).toBe(before);
});

async function pinnedFixture() {
  const f = await fixture();
  await mkdir(join(f.root, "src"));
  await writeFile(join(f.root, "src/cli.ts"), "// committed runtime\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", f.root, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "runtime input");
  const sha = git("rev-parse", "HEAD");
  const pin = JSON.parse(await readFile(join(f.root, manifest), "utf8"));
  pin.sourceCommit = sha; pin.sourceUrl = `https://codeload.github.com/sabereey/RookCue/tar.gz/${sha}`;
  await writeFile(join(f.root, manifest), JSON.stringify(pin));
  return f;
}

it("rejects a prior-version runtime pin before downloading", async () => {
  const f = await pinnedFixture();
  expect(f.run("bump", "0.1.0-beta.9").status).toBe(0);
  const result = f.run("verify-pin");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Pinned source version mismatch");
});

it.each(["src/cli.ts", "package-lock.json"])("rejects changed runtime input %s before downloading", async path => {
  const f = await pinnedFixture();
  const file = join(f.root, path);
  await writeFile(file, (await readFile(file, "utf8")) + "\n");
  const result = f.run("verify-pin");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Pinned runtime source differs from checkout");
});
