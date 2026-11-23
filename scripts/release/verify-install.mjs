import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Only disposable roots are used. Keep the upgrade baseline on the previous release.
const previous = process.argv[2] ?? "7cb55464302322a82392a4515573592a8cba47d1";
if (!/^[a-f0-9]{40}$/.test(previous)) throw new Error("Expected full previous commit SHA");
const repo = process.cwd();
const skillPath = "plugins/growth-memory/skills/growth-memory";
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const previousVersion = JSON.parse(execFileSync("git", ["show", `${previous}:package.json`], { encoding: "utf8" })).version;
assert.notEqual(previousVersion, version, "The upgrade test needs a different baseline version");
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

function invoke(skill, env, args) {
  const child = spawnSync("/bin/bash", [join(skill, "scripts/rookcue.sh"), ...args], {
    env, encoding: "utf8", timeout: 600000, maxBuffer: 16 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  assert.ok(child.stdout, child.stderr);
  return { status: child.status, result: JSON.parse(child.stdout) };
}
function run(skill, env, args) {
  const { status, result } = invoke(skill, env, args);
  assert.equal(status, 0, JSON.stringify(result));
  assert.equal(result.ok, true);
  return result.data;
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
  const hosts = "codex,grok,claude";
  const install = ["install", "--approve-install", "--agents", hosts];
  const codexSkill = join(upgrade.HOME, ".agents/skills/growth-memory");
  const grokSkill = join(upgrade.HOME, ".grok/skills/growth-memory");
  const claudeSkill = join(upgrade.CLAUDE_CONFIG_DIR, "skills/growth-memory");
  const sharedSkills = [codexSkill, grokSkill, claudeSkill];
  run(oldSkill, upgrade, install);
  const oldRevision = await realpath(grokSkill);
  for (const skill of sharedSkills) {
    assert.equal(await realpath(skill), oldRevision);
    assert.equal(run(skill, upgrade, ["check"]).runtime.version, previousVersion);
  }
  const project = join(upgrade.HOME, "project");
  const cliArgs = args => ["run", "--", ...args, "--project", project, "--json"];
  const cli = (skill, args) => run(skill, upgrade, cliArgs(args));
  const old = (...args) => cli(grokSkill, args);
  old("init", "--personal", upgrade.GROWTH_MEMORY_HOME);
  const reviewedTask = old("task", "start", "--title", "Verify fixture digest", "--goal", "Preserve the approved lesson");
  old("task", "complete", "--task", reviewedTask.id, "--summary", "Fixture verified the digest before extraction");
  const review = old("review", "start", "--task", reviewedTask.id, "--level", "quick");
  old("review", "respond", "--review", review.id, "--phase", "context", "--text", "Fixture: choose quick review.");
  old("review", "advance", "--review", review.id);
  old("review", "respond", "--review", review.id, "--phase", "correct", "--text", "Fixture: verify the digest before extraction.", "--evidence", `task:${reviewedTask.id}`);
  old("review", "advance", "--review", review.id);
  const [candidate] = old("knowledge", "propose", "--review", review.id, "--candidate", JSON.stringify({
    principle: "Verify the fixture digest before extraction.", boundary: "Use for archives with a trusted digest.",
    evidence: [{ kind: "task", id: reviewedTask.id }],
  }), "--personal", upgrade.GROWTH_MEMORY_HOME);
  old("knowledge", "decide", "--candidate", candidate.id, "--decision", "approve", "--actor", "human",
    "--source", "Synthetic upgrade test input approving the exact fixture candidate.", "--personal", upgrade.GROWTH_MEMORY_HOME);
  const concept = old("knowledge", "promote", "--candidate", candidate.id, "--confidence", "0.8", "--personal", upgrade.GROWTH_MEMORY_HOME);
  const task = old("task", "start", "--title", "Upgrade fixture", "--goal", "Preserve recorded progress");
  const checkpoint = old("task", "checkpoint", "--task", task.id, "--reason", "interrupt", "--snapshot",
    JSON.stringify({ query: "fixed query", nextStep: "Continue at cursor 123" }));
  const before = await bytes(join(project, ".growth-memory"));
  const personalBefore = await bytes(upgrade.GROWTH_MEMORY_HOME);
  run(freshSkill, upgrade, install);
  const newRevision = await realpath(grokSkill);
  assert.notEqual(newRevision, oldRevision);
  for (const skill of sharedSkills) {
    assert.equal(await realpath(skill), newRevision);
    assert.equal(run(skill, upgrade, ["check"]).runtime.version, version);
  }
  assert.deepEqual(await bytes(join(project, ".growth-memory")), before);
  assert.deepEqual(await bytes(upgrade.GROWTH_MEMORY_HOME), personalBefore);
  const recovered = cli(codexSkill, ["context", "show"]);
  assert.equal(recovered.activeTask.id, task.id);
  assert.equal(recovered.latestCheckpoint.id, checkpoint.id);
  assert.equal(recovered.latestCheckpoint.snapshot.nextStep, "Continue at cursor 123");
  const lesson = cli(grokSkill, ["knowledge", "show", "--concept", concept.id, "--personal", upgrade.GROWTH_MEMORY_HOME]);
  assert.deepEqual(lesson, concept);

  const saveArgs = (base, snapshot) => ["task", "checkpoint", "--task", task.id, "--reason", "interrupt",
    "--if-checkpoint", base, "--snapshot", JSON.stringify(snapshot)];
  const advanced = cli(codexSkill, saveArgs(checkpoint.id, { ...checkpoint.snapshot, checked: 20 }));
  const stale = invoke(grokSkill, upgrade, cliArgs(saveArgs(checkpoint.id, { ...checkpoint.snapshot, duplicates: [7] })));
  assert.equal(stale.status, 2);
  assert.equal(stale.result.error.code, "CHECKPOINT_CONFLICT");
  assert.equal(stale.result.error.details.latestCheckpointId, advanced.id);
  const latest = cli(grokSkill, ["context", "show"]).latestCheckpoint;
  assert.deepEqual(latest, advanced);
  const combined = cli(grokSkill, saveArgs(latest.id, { ...latest.snapshot, duplicates: [7] }));
  const final = cli(codexSkill, ["context", "show"]);
  assert.equal(final.activeTask.id, task.id);
  assert.equal(final.activeTask.status, "active");
  assert.equal(final.latestCheckpoint.id, combined.id);
  assert.deepEqual(final.latestCheckpoint.snapshot, { query: "fixed query", nextStep: "Continue at cursor 123", checked: 20, duplicates: [7] });
  const pin = JSON.parse(await readFile(join(freshSkill, "scripts/runtime.json"), "utf8"));
  const oldPin = JSON.parse(await readFile(join(oldSkill, "scripts/runtime.json"), "utf8"));
  const runtimes = await readdir(join(upgrade.ROOKCUE_RUNTIME_HOME, "runtimes"));
  assert.ok(runtimes.includes(pin.sourceCommit) && runtimes.includes(oldPin.sourceCommit));
  const evidence = {
    version, previousVersion, freshInstall: "passed", upgrade: "passed",
    preservedProjectAndPersonalBytes: true, approvedLessonReadable: true,
    retainedPreviousRuntime: true, upgradedSharedHosts: hosts.split(","), checkpointConflictRecovery: "passed",
  };
  const output = join(repo, "release", version, "install-verification.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
} finally { await rm(root, { recursive: true, force: true }); }
