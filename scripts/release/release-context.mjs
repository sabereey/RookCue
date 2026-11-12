import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const NODE_VERSION = "24.12.0";
export const NODE_LICENSE_SHA256 = "537308465103a306d0e3eecf42632b4ff1b48aaaec044e9fc10a78c81fd00b34";
const json = async path => JSON.parse(await readFile(path, "utf8"));

/** Pure library entry: importing build/package helpers never invokes either executable. */
export async function releaseSourceIdentity(repoRoot) {
  const git = (...args) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Dirty source tree: commit source and release materials before building or packaging");
  const sourceSHA = git("rev-parse", "HEAD");
  const metadata = await json(join(repoRoot, "package.json"));
  const lock = await json(join(repoRoot, "package-lock.json"));
  const plugin = await json(join(repoRoot, "plugins/growth-memory/.codex-plugin/plugin.json"));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version) || lock.version !== metadata.version || lock.packages?.[""]?.version !== metadata.version || plugin.version !== metadata.version) throw new Error("Release metadata version mismatch");
  return { sourceSHA, version: metadata.version };
}

export async function validateNodeLicense(repoRoot, actualNodeVersion) {
  if (actualNodeVersion !== NODE_VERSION) throw new Error(`Runtime/license mismatch: require Node ${NODE_VERSION}, got ${actualNodeVersion}`);
  const license = await readFile(join(repoRoot, `third_party/node/v${NODE_VERSION}/LICENSE`));
  const metadata = await json(join(repoRoot, `third_party/node/v${NODE_VERSION}/provenance.json`));
  if (createHash("sha256").update(license).digest("hex") !== NODE_LICENSE_SHA256 || metadata.sha256 !== NODE_LICENSE_SHA256 || metadata.version !== NODE_VERSION || metadata.source !== `https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`) throw new Error("Node license bytes/provenance mismatch");
  return { license, nodeLicenseSHA256: NODE_LICENSE_SHA256 };
}
