import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fail = (code, message) => Object.assign(new Error(message), { code });

async function stat(path) {
  try { return await lstat(path); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function onPath(name) {
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try { await access(join(directory, name), constants.X_OK); return true; } catch {}
  }
  return false;
}

async function hasCodexPlugin(configRoot) {
  let config;
  try { config = await readFile(join(configRoot, "config.toml"), "utf8"); } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  // Inspect only plugin tables, leaving host configuration and unrelated values alone.
  const tables = config.split(/^\s*\[/m);
  return tables.some(table => /^plugins\.["']growth-memory@[^"']+["']\]/.test(table)
    && !/^\s*enabled\s*=\s*false\s*(?:#.*)?$/m.test(table));
}

async function linkState(path, current) {
  const entry = await stat(path);
  if (!entry) return "available";
  if (entry.isSymbolicLink() && resolve(dirname(path), await readlink(path)) === current) {
    return await stat(join(path, "SKILL.md")) ? "connected" : "needs-repair";
  }
  return "conflict";
}

async function inspect(runtimeHome) {
  const user = homedir();
  const codexRoot = resolve(process.env.CODEX_HOME || join(user, ".codex"));
  const current = join(runtimeHome, "skills/current");
  const definitions = [
    { id: "codex", root: codexRoot, path: join(user, ".agents/skills/growth-memory"), command: "codex" },
    { id: "grok", root: join(user, ".grok"), path: join(user, ".grok/skills/growth-memory"), command: "grok" },
    { id: "claude", root: resolve(process.env.CLAUDE_CONFIG_DIR || join(user, ".claude")), command: "claude" },
  ];
  const agents = [];
  for (const definition of definitions) {
    const path = definition.path || join(definition.root, "skills/growth-memory");
    let status;
    let detail;
    let detected = false;
    try {
      status = await linkState(path, current);
      detected = Boolean(await stat(definition.root)) || await onPath(definition.command) || status !== "available";
      if (definition.id === "codex" && await hasCodexPlugin(codexRoot)) {
        status = status === "available" ? "plugin-managed" : "conflict";
        detail = "RookCue is enabled as a Codex plugin. Update it through Codex; disable that plugin before migrating to the shared skill.";
      } else if (definition.id === "codex" && await stat(join(codexRoot, "skills/growth-memory"))) {
        status = "conflict";
        detail = `An existing skill at ${join(codexRoot, "skills/growth-memory")} must be reconciled before adding a shared entry.`;
      }
    } catch (error) {
      status = "conflict";
      detected = true;
      detail = `Could not inspect ${definition.id} at ${path}: ${error.message}. Repair this host path and rerun connect.`;
    }
    if (status === "conflict" && !detail) detail = `Preserved existing entry at ${path}. Move or remove it after review, then rerun connect.`;
    agents.push({ id: definition.id, path, detected, status, ...(detail ? { detail } : {}) });
  }
  return { current, agents };
}

async function skillFiles(directory, relative = "") {
  const files = [];
  for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = join(relative, entry.name);
    if (name === "scripts/runtime-home") continue;
    if (entry.isDirectory()) files.push(...await skillFiles(directory, name));
    else if (entry.isFile()) files.push({ name, bytes: await readFile(join(directory, name)) });
    else throw fail("INVALID_SKILL", `Skill contains an unsupported filesystem entry: ${name}`);
  }
  return files;
}

function digest(files) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(JSON.stringify([file.name, file.bytes.length])).update(file.bytes);
  return hash.digest("hex");
}

async function publish(runtimeHome, current) {
  const source = dirname(dirname(fileURLToPath(import.meta.url)));
  const files = await skillFiles(source);
  const revision = digest(files);
  const releases = join(runtimeHome, "skills/releases");
  const target = join(releases, revision);
  const existing = await stat(current);
  if (existing) {
    if (!existing.isSymbolicLink()) throw fail("INSTALL_CONFLICT", `Preserved unrecognized shared skill at ${current}.`);
    const previous = resolve(dirname(current), await readlink(current));
    if (dirname(previous) !== releases || !/^[a-f0-9]{64}$/.test(previous.slice(releases.length + 1))) {
      throw fail("INSTALL_CONFLICT", `Preserved foreign shared skill link at ${current}.`);
    }
  }
  await mkdir(releases, { recursive: true });
  if (await stat(target)) {
    if ((await stat(target)).isSymbolicLink() || digest(await skillFiles(target)) !== revision) {
      throw fail("INSTALL_DAMAGED", `Shared skill revision changed on disk: ${target}`);
    }
  } else {
    const stage = await mkdtemp(join(releases, ".stage-"));
    try {
      for (const file of files) {
        await mkdir(dirname(join(stage, file.name)), { recursive: true });
        await writeFile(join(stage, file.name), file.bytes);
      }
      await writeFile(join(stage, "scripts/runtime-home"), `${runtimeHome}\n`);
      await rename(stage, target);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  const pending = join(runtimeHome, "agents.lock/current");
  await symlink(target, pending);
  await rename(pending, current);
  return revision;
}

export async function configureAgents(action, args, runtimeHome) {
  let selection = "auto";
  if (args.length) {
    if (action !== "connect" || args.length !== 2 || args[0] !== "--agents") throw fail("INVALID_ARGUMENT", "Use agents or connect [--agents auto|codex,grok,claude].");
    selection = args[1];
  }
  const requested = selection.split(",");
  if (selection !== "auto" && requested.some(id => !["codex", "grok", "claude"].includes(id))) throw fail("INVALID_ARGUMENT", "Supported agents: auto, or a comma-separated selection of codex,grok,claude.");
  if (action === "agents") return { status: "inspected", ...await inspect(runtimeHome) };
  if (process.platform === "win32") throw fail("UNSUPPORTED_PLATFORM", "Shared local skill setup currently supports macOS and Linux.");
  const initial = await inspect(runtimeHome);
  const selected = initial.agents.filter(agent => selection === "auto" ? agent.detected : requested.includes(agent.id));
  if (!selected.length) return { status: "no-agents", agents: [], detail: "No supported local agent was detected. Select one with --agents codex,grok,claude, or rerun after installing an agent." };
  await mkdir(runtimeHome, { recursive: true });
  const lock = join(runtimeHome, "agents.lock");
  try { await mkdir(lock); } catch (error) {
    if (error.code === "EEXIST") throw fail("INSTALL_BUSY", `Another agent setup owns ${lock}; inspect owner.json before retrying.`);
    throw error;
  }
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const { current, agents } = await inspect(runtimeHome);
    const results = agents.filter(agent => selected.some(item => item.id === agent.id));
    const revision = await publish(runtimeHome, current);
    for (const agent of results) {
      if (agent.status === "needs-repair") agent.status = "connected";
      if (agent.status !== "available") continue;
      try {
        await mkdir(dirname(agent.path), { recursive: true });
        await symlink(current, agent.path);
        agent.status = "connected";
      } catch (error) {
        agent.status = "conflict";
        agent.detail = `Could not connect ${agent.path}: ${error.message}. Correct this path and rerun connect.`;
      }
    }
    return { status: results.some(agent => agent.status === "conflict") ? "needs-attention" : "connected", current, revision, agents: results, nextStep: "Start a new agent session and invoke growth-memory. Run agents to inspect filesystem connections; host loading must be checked in the host." };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
