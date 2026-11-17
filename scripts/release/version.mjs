import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const pluginPath = "plugins/growth-memory/.codex-plugin/plugin.json";
const runtimePath = "plugins/growth-memory/skills/growth-memory/scripts/runtime.json";
const shellPath = "plugins/growth-memory/skills/growth-memory/scripts/runtime-version";
const read = async path => JSON.parse(await readFile(path, "utf8"));
const write = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + "\n");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
function validVersion(version) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/.test(version);
}
const sourceUrl = sha => `https://codeload.github.com/sabereey/RookCue/tar.gz/${sha}`;

async function check(tag) {
  const pkg = await read("package.json");
  const lock = await read("package-lock.json");
  const plugin = await read(pluginPath);
  const pin = await read(runtimePath);
  const shell = (await readFile(shellPath, "utf8")).trim();
  if (!validVersion(pkg.version) || [lock.version, lock.packages?.[""]?.version, plugin.version, pin.version, shell].some(version => version !== pkg.version)) throw new Error("Release metadata version mismatch");
  if (tag && tag !== `v${pkg.version}`) throw new Error("Release tag/version mismatch");
  if (!/^[a-f0-9]{40}$/.test(pin.sourceCommit) || !/^[a-f0-9]{64}$/.test(pin.sourceSha256) || pin.sourceUrl !== sourceUrl(pin.sourceCommit)) throw new Error("Invalid immutable runtime pin");
  return { version: pkg.version, pin };
}

function checkSource(sha, version) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Use a full source commit SHA");
  const pkg = JSON.parse(git("show", `${sha}:package.json`));
  if (pkg.version !== version) throw new Error("Pinned source version mismatch");
  // Manifest-only finalization may differ; runtime inputs must be identical.
  const changed = git("diff", "--name-only", sha, "--", "src", "package.json", "package-lock.json", "tsconfig.json");
  if (changed) throw new Error(`Pinned runtime source differs from checkout: ${changed}`);
}

async function download(sha) {
  const response = await fetch(sourceUrl(sha), { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Pinned source download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

try {
  const [action, value, ...rest] = process.argv.slice(2);
  if (rest.length) throw new Error("Unexpected release arguments");
  if (action === "bump") {
    if (!value || !validVersion(value)) throw new Error("Use a version such as 0.1.0-beta.9 (without v)");
    const paths = ["package.json", "package-lock.json", pluginPath, runtimePath];
    const data = await Promise.all(paths.map(read));
    for (const item of data) item.version = value;
    data[1].packages[""].version = value;
    for (let i = 0; i < paths.length; i++) await write(paths[i], data[i]);
    await writeFile(shellPath, value + "\n");
    console.log(`Version set to ${value}; commit/push runtime source, then run release:pin.`);
  } else if (action === "check") {
    console.log(JSON.stringify(await check(value)));
  } else if (action === "pin" || action === "verify-pin") {
    if (action === "verify-pin" && value) throw new Error("verify-pin takes no arguments");
    const { version, pin } = await check();
    const sha = action === "pin" ? value : pin.sourceCommit;
    checkSource(sha, version);
    const hash = sha256(await download(sha));
    if (action === "pin") await write(runtimePath, { version, sourceCommit: sha, sourceUrl: sourceUrl(sha), sourceSha256: hash });
    else if (hash !== pin.sourceSha256) throw new Error("Pinned archive checksum mismatch");
    console.log(JSON.stringify({ version, sourceCommit: sha, sourceSha256: hash }));
  } else throw new Error("Use bump VERSION | check [TAG] | pin SOURCE_SHA | verify-pin");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
