import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Only disposable roots are used. The previous skill pins the shipped beta.8 runtime.
const previous = process.argv[2] ?? "4613e8c07ffcbdc2ab9fbf0ef7a5880daf2513cb";
if (!/^[a-f0-9]{40}$/.test(previous)) throw new Error("Expected full previous commit SHA");
const repo = process.cwd();
const skillPath = "plugins/growth-memory/skills/growth-memory";
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const root = await mkdtemp(join(tmpdir(), "rookcue-release-install-"));
const bin = join(root, "bin");
await mkdir(bin);
await symlink(process.execPath, join(bin, "node"));
const npm = execFileSync("which", ["npm"], { encoding: "utf8" }).trim();
await symlink(npm, join(bin, "npm"));
const freshSkill = join(root, "new-skill");
await cp(join(repo, skillPath), freshSkill, { recursive: true });
const previousTree = join(root, "previous");
await mkdir(previousTree);
const archive = execFileSync("git", ["archive", previous, "--", skillPath], { maxBuffer: 8 * 1024 * 1024 });
execFileSync("tar", ["-xf", "-", "-C", previousTree], { input: archive });

function run(skill, env, args) {
  const output = execFileSync("/bin/bash", [join(skill, "scripts/rookcue.sh"), ...args], { env, encoding: "utf8", timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  const result = JSON.parse(output); assert.equal(result.ok, true); return result.data;
}
async function environment(name) {
  const home = join(root, name);
  await mkdir(join(home, ".grok"), { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
  return { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
    GROWTH_MEMORY_HOME: join(home, "personal"), ROOKCUE_RUNTIME_HOME: join(home, "runtime"), PATH: `${bin}:/usr/bin:/bin` };
}
async function bytes(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const result = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    result[entry.name] = entry.isDirectory() ? await bytes(path) : (await readFile(path)).toString("base64");
  }
  return result;
}
try {
  const fresh = await environment("fresh");
  assert.equal(run(freshSkill, fresh, ["check"]).status, "setup-required");
  run(freshSkill, fresh, ["install", "--approve-install", "--agents", "grok,claude"]);
  const freshCheck = run(freshSkill, fresh, ["check"]);
  assert.equal(freshCheck.runtime.version, version);
  assert.equal(freshCheck.runtime.kind, "managed");

  const upgrade = await environment("upgrade");
  const oldSkill = join(previousTree, skillPath);
  run(oldSkill, upgrade, ["setup", "--approve-install"]);
  assert.equal(run(oldSkill, upgrade, ["check"]).runtime.version, "0.1.0-beta.8");
  const project = join(upgrade.HOME, "project");
  const cli = (skill, args) => run(skill, upgrade, ["run", "--", ...args, "--project", project, "--json"]);
  cli(oldSkill, ["init", "--personal", upgrade.GROWTH_MEMORY_HOME]);
  const task = cli(oldSkill, ["task", "start", "--title", "Upgrade fixture", "--goal", "Preserve recorded progress"]);
  cli(oldSkill, ["task", "checkpoint", "--task", task.id, "--reason", "interrupt", "--snapshot", JSON.stringify({ query: "fixed query", nextStep: "Continue at cursor 123" })]);
  const before = await bytes(join(project, ".growth-memory"));
  const personalBefore = await bytes(upgrade.GROWTH_MEMORY_HOME);
  run(freshSkill, upgrade, ["install", "--approve-install", "--agents", "grok,claude"]);
  assert.equal(run(freshSkill, upgrade, ["check"]).runtime.version, version);
  assert.deepEqual(await bytes(join(project, ".growth-memory")), before);
  assert.deepEqual(await bytes(upgrade.GROWTH_MEMORY_HOME), personalBefore);
  const recovered = cli(freshSkill, ["context", "show"]);
  assert.equal(recovered.activeTask.id, task.id);
  assert.equal(recovered.latestCheckpoint.snapshot.nextStep, "Continue at cursor 123");
  const pin = JSON.parse(await readFile(join(freshSkill, "scripts/runtime.json"), "utf8"));
  const oldPin = JSON.parse(await readFile(join(oldSkill, "scripts/runtime.json"), "utf8"));
  const runtimes = await readdir(join(upgrade.ROOKCUE_RUNTIME_HOME, "runtimes"));
  assert.ok(runtimes.includes(pin.sourceCommit) && runtimes.includes(oldPin.sourceCommit));
  const evidence = { version, previousVersion: "0.1.0-beta.8", freshInstall: "passed", upgrade: "passed", preservedProjectAndPersonalBytes: true, retainedPreviousRuntime: true };
  const output = join(repo, "release", version, "install-verification.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
} finally { await rm(root, { recursive: true, force: true }); }
