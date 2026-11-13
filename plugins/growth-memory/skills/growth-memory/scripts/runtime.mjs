import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

const manifest = JSON.parse(await readFile(new URL("./runtime.json", import.meta.url), "utf8"));
const home = resolve(process.env.ROOKCUE_RUNTIME_HOME || join(homedir(), ".local/share/rookcue"));
const target = join(home, "runtimes", manifest.sourceCommit);
const childEnv = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ""}` };
const fail = (code, message) => Object.assign(new Error(message), { code });
const json = value => process.stdout.write(`${JSON.stringify(value)}\n`);

async function executable(name) {
  for (const entry of (process.env.PATH || "").split(delimiter)) {
    // Do not run a similarly named file from an implicit working directory.
    if (!isAbsolute(entry)) continue;
    const candidate = join(entry, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
}

function probe(runtime) {
  const options = { encoding: "utf8", timeout: 8000, env: childEnv, maxBuffer: 1024 * 1024 };
  const version = spawnSync(runtime.executable, [...runtime.args, "--version"], options);
  if (version.status !== 0 || version.stdout.trim() !== manifest.version) return false;
  const help = spawnSync(runtime.executable, [...runtime.args, "--help"], options);
  return help.status === 0 && ["task", "knowledge", "review", "context"].every(word => help.stdout.includes(word));
}

async function discover() {
  for (const name of ["rookcue", "gmem", "growth-memory"]) {
    const path = await executable(name);
    if (!path) continue;
    const runtime = { kind: "path", executable: path, args: [], version: manifest.version };
    if (probe(runtime)) return runtime;
  }
  try {
    const receipt = JSON.parse(await readFile(join(target, "rookcue-install.json"), "utf8"));
    const runtime = { kind: "managed", executable: process.execPath, args: [join(target, "dist/src/cli.js")], version: manifest.version };
    if (receipt.sourceCommit === manifest.sourceCommit && receipt.sourceSha256 === manifest.sourceSha256 && probe(runtime)) return runtime;
  } catch {}
}

async function command(executable, args, cwd, signal) {
  if (signal.aborted) throw fail("INSTALL_INTERRUPTED", "Installation was cancelled; retry when ready.");
  await new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(executable, args, { cwd, env: childEnv, detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
    let failure;
    let forceKill;
    const kill = signal => {
      try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const stop = () => {
      kill("SIGTERM");
      forceKill = setTimeout(() => kill("SIGKILL"), 3000);
      forceKill.unref();
    };
    const timeout = setTimeout(() => { failure = new Error("command timed out"); stop(); }, 300000);
    signal.addEventListener("abort", stop, { once: true });
    // Setup stdout remains a single JSON envelope; stream diagnostics to stderr.
    child.stdout.on("data", data => process.stderr.write(data));
    child.stderr.on("data", data => process.stderr.write(data));
    child.once("error", error => { failure = error; });
    child.once("close", code => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(fail("INSTALL_INTERRUPTED", "Installation was cancelled; retry when ready."));
      else if (failure || code !== 0) reject(fail("INSTALL_COMMAND_FAILED", `${executable} failed: ${failure?.message || `exit ${code}`}`));
      else resolve();
    });
  });
}

async function install(options) {
  const existing = await discover();
  if (existing) return { status: "ready", runtime: existing, reused: true };
  const lock = join(home, "install.lock");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const assertRunning = () => { if (controller.signal.aborted) throw fail("INSTALL_INTERRUPTED", "Installation was cancelled; retry when ready."); };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let ownsLock = false;
  let stage;
  try {
    await mkdir(home, { recursive: true });
    assertRunning();
    try { await mkdir(lock); ownsLock = true; } catch (error) {
      if (error.code === "EEXIST") throw fail("INSTALL_BUSY", "Another installation owns install.lock. Inspect its owner.json; do not delete a live lock.");
      throw error;
    }
    await writeFile(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    assertRunning();
    const reused = await discover();
    if (reused) return { status: "ready", runtime: reused, reused: true };
    try {
      await access(target);
      throw fail("INSTALL_DAMAGED", "The pinned runtime directory already exists but failed validation. Preserve it and select a separate ROOKCUE_RUNTIME_HOME for repair.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    stage = await mkdtemp(join(home, "stage-"));
    const archive = join(stage, "source.tar.gz");
    let bytes;
    if (options.archive) {
      bytes = await readFile(resolve(options.archive));
    } else {
      if (options.offline) throw fail("ARCHIVE_REQUIRED", "Offline setup requires --archive pointing to the pinned source archive.");
      const response = await fetch(manifest.sourceUrl, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]) });
      if (!response.ok) throw fail("DOWNLOAD_FAILED", `Source download returned HTTP ${response.status}.`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.sourceSha256) {
      throw fail("CHECKSUM_MISMATCH", "Source archive checksum does not match the plugin's pinned release. Nothing was installed.");
    }
    await writeFile(archive, bytes);
    await command("tar", ["-xzf", archive, "--strip-components=1", "-C", stage], stage, controller.signal);
    await rm(archive);
    const pkg = JSON.parse(await readFile(join(stage, "package.json"), "utf8"));
    if (pkg.name !== "personal-growth-memory" || pkg.version !== manifest.version) throw fail("SOURCE_IDENTITY_MISMATCH", "Pinned source metadata does not match this plugin.");
    const npm = await executable("npm");
    if (!npm) throw fail("NPM_MISSING", "A compatible Node installation with npm is required. Use the bundled launcher setup to prepare it.");
    await command(npm, ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund", ...(options.offline ? ["--offline"] : [])], stage, controller.signal);
    await command(npm, ["run", "build", "--ignore-scripts"], stage, controller.signal);
    const runtime = { kind: "managed", executable: process.execPath, args: [join(stage, "dist/src/cli.js")], version: manifest.version };
    if (!probe(runtime)) throw fail("RUNTIME_VERIFY_FAILED", "Built runtime did not pass version/help checks.");
    assertRunning();
    await writeFile(join(stage, "rookcue-install.json"), `${JSON.stringify({ ...manifest, installedAt: new Date().toISOString() })}\n`);
    await mkdir(dirname(target), { recursive: true });
    await rename(stage, target);
    stage = undefined;
    return { status: "ready", runtime: { ...runtime, args: [join(target, "dist/src/cli.js")] }, reused: false };
  } catch (error) {
    assertRunning();
    throw error;
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    if (ownsLock) await rm(lock, { recursive: true, force: true });
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

try {
  const [action, ...args] = process.argv.slice(2);
  if (action === "check") {
    if (args.length) throw fail("INVALID_ARGUMENT", "check takes no arguments.");
    const runtime = await discover();
    json({ ok: true, data: runtime ? { status: "ready", runtime } : { status: "setup-required", version: manifest.version, source: manifest.sourceUrl, installRoot: home } });
  } else if (action === "setup") {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--approve-install") options.approved = true;
      else if (args[i] === "--offline") options.offline = true;
      else if (args[i] === "--archive" && args[i + 1]) options.archive = args[++i];
      else throw fail("INVALID_ARGUMENT", "Use setup [--approve-install] [--archive PATH] [--offline].");
    }
    if (!options.approved) throw fail("INSTALL_APPROVAL_REQUIRED", "Explain the downloads and install location, obtain user consent, then pass --approve-install.");
    json({ ok: true, data: await install(options) });
  } else if (action === "run") {
    if (args[0] !== "--" || args.length < 2) throw fail("INVALID_ARGUMENT", "Use run -- <CLI arguments>.");
    const runtime = await discover();
    if (!runtime) throw fail("RUNTIME_MISSING", "Run the read-only check, then request installation consent. run never installs automatically.");
    const result = spawnSync(runtime.executable, [...runtime.args, ...args.slice(1)], { env: childEnv, stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } else throw fail("INVALID_ARGUMENT", "Expected check, setup, or run.");
} catch (error) {
  json({ ok: false, error: { code: error.code || "SETUP_FAILED", message: error.message } });
  process.exitCode = 1;
}
