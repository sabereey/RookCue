import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = process.cwd();
const source = join(repo, "plugins/growth-memory/skills/growth-memory");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rookcue plugin with spaces "));
  roots.push(root);
  const skill = join(root, "copied skill");
  await cp(source, skill, { recursive: true });
  const bin = join(root, "bin");
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  const npm = spawnSync("/usr/bin/which", ["npm"], { encoding: "utf8" }).stdout.trim();
  await symlink(npm, join(bin, "npm"));
  // Do not inherit /usr/bin/node on Linux in the missing-Node cases.
  for (const name of ["bash", "sh", "dirname", "uname", "curl", "tar", "shasum", "sha256sum", "mkdir", "mktemp", "rm", "rmdir", "mv"]) {
    const path = spawnSync("/usr/bin/which", [name], { encoding: "utf8" }).stdout.trim();
    if (path) await symlink(path, join(bin, name));
  }
  const home = join(root, "runtime home");
  const env = { ...process.env, GROWTH_MEMORY_HOME: join(root, "personal"), ROOKCUE_RUNTIME_HOME: home, PATH: bin, npm_config_cache: join(root, "npm cache") };
  const run = (...args: string[]) => spawnSync("/bin/bash", [join(skill, "scripts/rookcue.sh"), ...args], { env, encoding: "utf8" });
  return { root, skill, bin, home, env, run };
}

async function sourceFixture(f: Awaited<ReturnType<typeof fixture>>, broken: boolean | "hang" = false) {
  const source = join(f.root, "source");
  await mkdir(join(source, "build-tool"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "personal-growth-memory", version: "0.1.0-beta.8", scripts: { build: "node node_modules/build-tool/build.cjs" }, devDependencies: { "build-tool": "file:./build-tool" } }));
  await writeFile(join(source, "build-tool/package.json"), JSON.stringify({ name: "build-tool", version: "1.0.0" }));
  await writeFile(join(source, "build-tool/build.cjs"), broken === "hang" ? 'require("fs").writeFileSync("building",String(process.pid));setInterval(()=>{},1000)' : broken ? 'process.exit(42)' : `const fs=require('fs');fs.mkdirSync('dist/src',{recursive:true});fs.writeFileSync('dist/src/cli.js', 'console.log(process.argv.includes("--version")?"0.1.0-beta.8":"task knowledge review context")');`);
  const lock = spawnSync(join(f.bin, "npm"), ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--offline"], { cwd: source, env: f.env, encoding: "utf8" });
  expect(lock.status, lock.stderr).toBe(0);
  const archive = join(f.root, "fixture.tar.gz");
  const tar = spawnSync(join(f.bin, "tar"), ["-czf", archive, "-C", f.root, "source"], { encoding: "utf8" });
  expect(tar.status, tar.stderr).toBe(0);
  const manifestPath = join(f.skill, "scripts/runtime.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.sourceSha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { archive, target: join(f.home, "runtimes", manifest.sourceCommit) };
}

describe("plugin runtime launcher", () => {
  it("checks an absent runtime from a copied plugin without creating directories", async () => {
    const f = await fixture();
    const result = f.run("check");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.status).toBe("setup-required");
    expect(await readdir(f.root)).not.toContain("runtime home");
  });

  it("refuses setup without installation consent before creating files", async () => {
    const f = await fixture();
    const result = f.run("setup");
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout).error.code).toBe("INSTALL_APPROVAL_REQUIRED");
    expect(await readdir(f.root)).not.toContain("runtime home");
  });

  it.each(["rookcue", "gmem", "growth-memory"])("reuses compatible %s without installation", async alias => {
    const f = await fixture();
    await symlink(join(repo, "dist/src/cli.js"), join(f.bin, alias));
    const result = f.run("check");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ status: "ready", runtime: { kind: "path", executable: join(f.bin, alias) } });
    expect(await readdir(f.root)).not.toContain("runtime home");
  });

  it("skips an incompatible alias and uses a compatible fallback", async () => {
    const f = await fixture();
    await writeFile(join(f.bin, "rookcue"), '#!/bin/sh\nprintf "0.0.1\\n"\n', { mode: 0o755 });
    await symlink(join(repo, "dist/src/cli.js"), join(f.bin, "gmem"));
    expect(JSON.parse(f.run("check").stdout).data.runtime.executable).toBe(join(f.bin, "gmem"));
  });

  it("does not install implicitly when run is requested without a runtime", async () => {
    const f = await fixture();
    const result = f.run("run", "--", "--version");
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout).error.code).toBe("RUNTIME_MISSING");
    expect(await readdir(f.root)).not.toContain("runtime home");
  });

  it("reuses an installed CLI even when npm is absent", async () => {
    const f = await fixture();
    await rm(join(f.bin, "npm"));
    await symlink(join(repo, "dist/src/cli.js"), join(f.bin, "rookcue"));
    const result = f.run("setup", "--approve-install");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.reused).toBe(true);
    expect(await readdir(f.root)).not.toContain("runtime home");
  });

  it("checks a machine without Node and refuses unapproved installation without writes", async () => {
    const f = await fixture();
    await rm(join(f.bin, "node"));
    await rm(join(f.bin, "npm"));
    expect(JSON.parse(f.run("check").stdout).data).toMatchObject({ status: "setup-required", prerequisite: "Node >=22.12.0 with npm" });
    expect(JSON.parse(f.run("setup").stdout).error.code).toBe("INSTALL_APPROVAL_REQUIRED");
    expect(await readdir(f.root)).not.toContain("runtime home");
  });

  it("validates setup arguments before downloading a missing Node", async () => {
    const f = await fixture();
    await rm(join(f.bin, "node"));
    await rm(join(f.bin, "npm"));
    const result = f.run("setup", "--approve-install", "--wrong-option");
    expect(JSON.parse(result.stdout).error.code).toBe("INVALID_ARGUMENT");
    expect(await readdir(f.root)).not.toContain("runtime home");
  });

  it("uses a standalone CLI without installing Node", async () => {
    const f = await fixture();
    await rm(join(f.bin, "node"));
    await rm(join(f.bin, "npm"));
    // Executable protocol fixture for a self-contained native CLI, not a JS CLI.
    await writeFile(join(f.bin, "rookcue"), '#!/bin/sh\ncase "$1" in --version) printf "0.1.0-beta.8\\n";; --help) printf "task knowledge review context\\n";; *) printf "%s\\n" "$2"; exit 7;; esac\n', { mode: 0o755 });
    expect(JSON.parse(f.run("check").stdout).data.status).toBe("ready");
    expect(JSON.parse(f.run("setup", "--approve-install").stdout).data.reused).toBe(true);
    const result = f.run("run", "--", "literal", '中文 $(touch nope) "quoted"');
    expect(result.status).toBe(7);
    expect(result.stdout.trim()).toBe('中文 $(touch nope) "quoted"');
    expect(await readdir(f.root)).not.toContain("runtime home");
  });

  it("rejects a corrupt Node download and cleans its staging directory and lock", async () => {
    const f = await fixture();
    await rm(join(f.bin, "node"));
    await rm(join(f.bin, "npm"));
    await rm(join(f.bin, "curl"));
    await writeFile(join(f.bin, "curl"), '#!/bin/bash\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then printf broken > "$2"; exit 0; fi; shift; done\nexit 1\n', { mode: 0o755 });
    const result = f.run("setup", "--approve-install");
    expect(JSON.parse(result.stdout).error.code).toBe("CHECKSUM_MISMATCH");
    expect(await readdir(f.home)).toEqual([]);
  });

  it("installs build dependencies even in production environments and reuses the completed runtime", async () => {
    const f = await fixture();
    const { archive, target } = await sourceFixture(f);
    Object.assign(f.env, { NODE_ENV: "production", npm_config_omit: "dev" });
    const result = f.run("setup", "--approve-install", "--archive", archive, "--offline");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.reused).toBe(false);
    expect(JSON.parse(await readFile(join(target, "rookcue-install.json"), "utf8")).version).toBe("0.1.0-beta.8");
    expect(f.run("run", "--", "--version").stdout.trim()).toBe("0.1.0-beta.8");
    expect(JSON.parse(f.run("setup", "--approve-install", "--offline").stdout).data.reused).toBe(true);
  }, 15000);

  it("cleans a failed build without publishing a runtime and permits a retry", async () => {
    const f = await fixture();
    const { archive } = await sourceFixture(f, true);
    const result = f.run("setup", "--approve-install", "--archive", archive, "--offline");
    expect(JSON.parse(result.stdout).error.code).toBe("INSTALL_COMMAND_FAILED");
    expect(await readdir(f.home)).toEqual([]);
    await sourceFixture(f);
    const retry = f.run("setup", "--approve-install", "--archive", archive, "--offline");
    expect(retry.status, retry.stderr).toBe(0);
  }, 15000);

  it("cleans an interrupted source download and releases its owned lock", async () => {
    const f = await fixture();
    const hook = join(f.root, "pending-fetch.mjs");
    await writeFile(hook, 'globalThis.fetch=async(_url,options)=>new Promise((resolve,reject)=>{const timer=setInterval(()=>{},1000);options.signal.addEventListener("abort",()=>{clearInterval(timer);reject(new Error("aborted"))})});');
    const child = spawn(process.execPath, ["--import", hook, join(f.skill, "scripts/runtime.mjs"), "setup", "--approve-install"], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    const ended = new Promise(resolve => child.once("exit", resolve));
    try {
      let staged = false;
      for (let i = 0; i < 100; i++) {
        staged = (await readdir(f.home).catch(() => [] as string[])).some(name => name.startsWith("stage-"));
        if (staged) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(staged).toBe(true);
      child.kill("SIGTERM");
      await ended;
      expect(await readdir(f.home)).toEqual([]);
      const archive = join(f.root, "bad.tar.gz");
      await writeFile(archive, "bad");
      expect(JSON.parse(f.run("setup", "--approve-install", "--archive", archive).stdout).error.code).toBe("CHECKSUM_MISMATCH");
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  }, 15000);

  it("cancels the build subprocess tree before removing source staging", async () => {
    const f = await fixture();
    const { archive } = await sourceFixture(f, "hang");
    const child = spawn("/bin/bash", [join(f.skill, "scripts/rookcue.sh"), "setup", "--approve-install", "--archive", archive, "--offline"], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    const ended = new Promise(resolve => child.once("exit", resolve));
    try {
      let buildPid: number | undefined;
      for (let i = 0; i < 250; i++) {
        const stages = (await readdir(f.home).catch(() => [] as string[])).filter(name => name.startsWith("stage-"));
        if (stages[0]) buildPid = Number(await readFile(join(f.home, stages[0], "building"), "utf8").catch(() => "")) || undefined;
        if (buildPid) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(buildPid).toBeDefined();
      child.kill("SIGTERM");
      await ended;
      expect(await readdir(f.home)).toEqual([]);
      expect(() => process.kill(buildPid!, 0)).toThrow();
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  }, 15000);

  it("cancels a private Node download and releases its owned lock", async () => {
    const f = await fixture();
    await rm(join(f.bin, "node"));
    await rm(join(f.bin, "npm"));
    await rm(join(f.bin, "curl"));
    await writeFile(join(f.bin, "curl"), '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o755 });
    const child = spawn("/bin/bash", [join(f.skill, "scripts/rookcue.sh"), "setup", "--approve-install"], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    const ended = new Promise(resolve => child.once("exit", resolve));
    try {
      let staged = false;
      for (let i = 0; i < 100; i++) {
        staged = (await readdir(f.home).catch(() => [] as string[])).some(name => name.startsWith("node-stage-"));
        if (staged) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(staged).toBe(true);
      child.kill("SIGTERM");
      await ended;
      expect(await readdir(f.home)).toEqual([]);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  }, 15000);

  it("rejects a corrupt offline archive and leaves a retryable installation", async () => {
    const f = await fixture();
    const archive = join(f.root, "bad.tar.gz");
    await writeFile(archive, "not the pinned source");
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = f.run("setup", "--approve-install", "--archive", archive, "--offline");
      expect(result.status, result.stderr).not.toBe(0);
      expect(JSON.parse(result.stdout).error.code).toBe("CHECKSUM_MISMATCH");
      const entries = await readdir(f.home);
      expect(entries).not.toContain("install.lock");
      expect(entries.some(name => name.startsWith("stage-"))).toBe(false);
    }
  });

  it("preserves a concurrent install lock instead of stealing it", async () => {
    const f = await fixture();
    await mkdir(join(f.home, "install.lock"), { recursive: true });
    const result = f.run("setup", "--approve-install");
    expect(JSON.parse(result.stdout).error.code).toBe("INSTALL_BUSY");
    expect(await readdir(f.home)).toContain("install.lock");
  });

  it("forwards arguments literally and keeps lookup read-only", async () => {
    const f = await fixture();
    await symlink(join(repo, "dist/src/cli.js"), join(f.bin, "rookcue"));
    const project = join(f.root, "project");
    const personal = join(f.root, "personal");
    const lookup = f.run("run", "--", "knowledge", "search", "--project", project, "--personal", personal, "--query", "old workaround", "--json");
    expect(lookup.status, lookup.stderr).toBe(0);
    expect(await readdir(f.root)).not.toContain("project");
    expect(await readdir(f.root)).not.toContain("personal");
    const title = 'literal $HOME `whoami` $(touch SHOULD_NOT_EXIST) "中文"';
    const result = f.run("run", "--", "task", "start", "--project", project, "--title", title, "--goal", "test argv forwarding", "--json");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.title).toBe(title);
    const error = f.run("run", "--", "knowledge", "show", "--project", project, "--personal", personal, "--concept", "missing", "--json");
    expect(error.status).not.toBe(0);
    expect(JSON.parse(error.stdout).ok).toBe(false);
  });
});
