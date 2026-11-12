import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const script = new URL("../../scripts/release/package-binary.mjs", import.meta.url).pathname;
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function git(root: string, ...args: string[]) { return execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim(); }
async function put(root: string, path: string, bytes: string | Buffer) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); }
async function fixture(lan = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gmem-package-"))); roots.push(root);
  const license = await readFile(new URL("../../third_party/node/v24.12.0/LICENSE", import.meta.url)).catch(() => Buffer.from("missing Node license"));
  const files: Record<string, string | Buffer> = {
    ".gitignore": "/release/\nnode_modules/\n.superpowers/\n.growth-memory/\n",
    "package.json": JSON.stringify({ version: "0.1.0-beta.6" }),
    "package-lock.json": JSON.stringify({ version: "0.1.0-beta.6", packages: { "": { version: "0.1.0-beta.6" } } }),
    "plugins/growth-memory/.codex-plugin/plugin.json": JSON.stringify({ version: "0.1.0-beta.6" }),
    "tsconfig.json": "{}", "vitest.config.ts": "export default {};", "src/cli.ts": "// fixture source\n",
    "tests/cli/workflow.test.ts": "// fixture test\n", "scripts/release/build-binary.mjs": "// fixture builder\n",
    "README.md": "Fixture README", "LICENSE": "Fixture project license", "NOTICE": "Fixture notice",
    "THIRD_PARTY_NOTICES.md": "Fixture third-party notices", "docs/binary-build.md": "Fixture build instructions",
    "third_party/node/v24.12.0/LICENSE": license,
    "third_party/node/v24.12.0/provenance.json": JSON.stringify({ version: "24.12.0", sha256: "537308465103a306d0e3eecf42632b4ff1b48aaaec044e9fc10a78c81fd00b34", source: "https://raw.githubusercontent.com/nodejs/node/v24.12.0/LICENSE" }),
    "docs/superpowers/secret.md": "INTERNAL COORDINATOR", "src/.growth-memory/private.json": "PRIVATE MEMORY",
  };
  if (lan) {
    files["scripts/release/verify-peer-lan.sh"] = "#!/bin/bash\n# Two-Mac fixture\n";
    files["docs/lan-two-mac-acceptance.md"] = "Two-Mac instructions\n";
  }
  for (const [path, bytes] of Object.entries(files)) await put(root, path, bytes);
  git(root, "init", "-q"); git(root, "add", ".");
  git(root, "add", "--force", "src/.growth-memory/private.json");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  const sourceSHA = git(root, "rev-parse", "HEAD");
  const output = "release/0.1.0-beta.6/darwin-arm64";
  const binary = "#!/bin/sh\nprintf '0.1.0-beta.6\\n'\n";
  await put(root, `${output}/gmem-darwin-arm64`, binary); await chmod(join(root, output, "gmem-darwin-arm64"), 0o755);
  const provenance = { sourceSHA, version: "0.1.0-beta.6", target: "darwin-arm64", nodeVersion: "24.12.0", binarySHA256: digest(binary), nodeLicenseSHA256: digest(license) };
  await put(root, `${output}/provenance.json`, JSON.stringify(provenance));
  await put(root, "node_modules/private", "DO NOT SHIP"); await put(root, ".superpowers/private", "DO NOT SHIP"); await put(root, ".growth-memory/private", "DO NOT SHIP");
  return { root, output, provenance };
}
function pack(root: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `const {prepareReleasePackage}=await import(${JSON.stringify(script)}); await prepareReleasePackage({repoRoot:process.argv[1],target:"darwin-arm64"});`, root], { encoding: "utf8" });
}

// Catches builder/packager import cycles that exit with unsettled top-level await instead of validation.
it("runs the real builder entry point and rejects dirty source before any native work", async () => {
  const f = await fixture();
  await cp(new URL("../../scripts/release/", import.meta.url), join(f.root, "scripts/release"), { recursive: true });
  git(f.root, "add", "."); git(f.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "actual release scripts");
  await put(f.root, "src/cli.ts", "changed source");
  const result = spawnSync(process.execPath, [join(f.root, "scripts/release/build-binary.mjs"), "--target", `${process.platform}-${process.arch}`], { encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Dirty source tree");
  expect(result.stderr).not.toContain("unsettled top-level await");
});

// Catches missing source, silently included private data, unchecked material bytes and wrong archive layout.
it("assembles inspectable exact-commit source and checksums for every delivered material", async () => {
  const f = await fixture(); const result = pack(f.root); expect(result.status, result.stderr).toBe(0);
  const archive = join(f.root, "release/0.1.0-beta.6/packages/gmem-0.1.0-beta.6-darwin-arm64.tar.gz");
  const extracted = join(f.root, "extracted"); await mkdir(extracted); execFileSync("tar", ["-xzf", archive, "-C", extracted]);
  const base = join(extracted, "gmem-0.1.0-beta.6-darwin-arm64");
  const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n").filter(p => !p.endsWith("/")).map(p => p.split("/").at(-1)).sort();
  expect(listing).toEqual(["INSTALL.md", "LICENSE", "NODE-LICENSE.txt", "NOTICE", "SHA256SUMS", "SOURCE.md", "THIRD_PARTY_NOTICES.md", "gmem-darwin-arm64", "provenance.json", "source.tar.gz"].sort());
  const installGuide = await readFile(join(base, "INSTALL.md"), "utf8");
  expect(installGuide).toContain("install -m 755 gmem-darwin-arm64 ~/.local/bin/rookcue");
  expect(installGuide).toContain("ln -sfn rookcue ~/.local/bin/gmem");
  expect(installGuide).toContain("ln -sfn rookcue ~/.local/bin/growth-memory");
  const lines = (await readFile(join(base, "SHA256SUMS"), "utf8")).trim().split("\n"); expect(lines).toHaveLength(9);
  for (const line of lines) { const [hash, file] = line.split("  "); expect(digest(await readFile(join(base, file!)))).toBe(hash); }
  const source = join(base, "source.tar.gz"); const sourceListing = execFileSync("tar", ["-tzf", source], { encoding: "utf8" });
  for (const required of ["package-lock.json", "tsconfig.json", "vitest.config.ts", "src/cli.ts", "tests/cli/workflow.test.ts", "scripts/release/build-binary.mjs", "third_party/node/v24.12.0/LICENSE", "docs/binary-build.md"]) expect(sourceListing).toContain(required);
  expect(sourceListing).not.toMatch(/(?:^|\/)(?:\.git|\.superpowers|\.growth-memory|node_modules)(?:\/|$)|docs\/superpowers|^gmem-[^/]+\/release\//m);
  const sourceOut = join(f.root, "source-out"); await mkdir(sourceOut); execFileSync("tar", ["-xzf", source, "-C", sourceOut]);
  const archivedCli = execFileSync("tar", ["-tzf", source], { encoding: "utf8" }).trim().split("\n").find(p => p.endsWith("src/cli.ts"))!;
  expect(await readFile(join(sourceOut, archivedCli), "utf8")).toBe(git(f.root, "show", `${f.provenance.sourceSHA}:src/cli.ts`) + "\n");
  expect(JSON.parse(await readFile(join(base, "provenance.json"), "utf8"))).toMatchObject(f.provenance);
});

it("includes and checksums the macOS two-device handoff when the source provides it", async () => {
  const f = await fixture(true);
  const result = pack(f.root);
  expect(result.status, result.stderr).toBe(0);
  const archive = join(f.root, "release/0.1.0-beta.6/packages/gmem-0.1.0-beta.6-darwin-arm64.tar.gz");
  const output = join(f.root, "extracted");
  await mkdir(output);
  execFileSync("tar", ["-xzf", archive, "-C", output]);
  const base = join(output, "gmem-0.1.0-beta.6-darwin-arm64");
  const checksums = await readFile(join(base, "SHA256SUMS"), "utf8");
  for (const [source, file] of [
    ["scripts/release/verify-peer-lan.sh", "verify-peer-lan.sh"],
    ["docs/lan-two-mac-acceptance.md", "LAN-ACCEPTANCE.md"],
  ] as const) {
    const delivered = await readFile(join(base, file));
    expect(delivered.equals(await readFile(join(f.root, source)))).toBe(true);
    expect(checksums).toContain(`${digest(delivered)}  ${file}\n`);
  }
});

// Each corruption must fail before a distributable is emitted.
it.each([
  ["dirty-source", /Dirty source tree/], ["different-commit", /build\/source commit mismatch/],
  ["runtime-license", /Runtime\/license mismatch/], ["binary-digest", /Binary digest/],
  ["license-bytes", /Node license bytes/], ["metadata-version", /Binary build version/],
] as const)("refuses %s", async (reason, expectedError) => {
  const f = await fixture();
  if (reason === "dirty-source") await put(f.root, "src/cli.ts", "changed source");
  if (reason === "different-commit") f.provenance.sourceSHA = "a".repeat(40);
  if (reason === "runtime-license") f.provenance.nodeVersion = "24.18.0";
  if (reason === "binary-digest") await put(f.root, `${f.output}/gmem-darwin-arm64`, "tampered binary");
  if (reason === "license-bytes") {
    await put(f.root, "third_party/node/v24.12.0/LICENSE", "truncated"); git(f.root, "add", "."); git(f.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "bad license"); f.provenance.sourceSHA = git(f.root, "rev-parse", "HEAD");
  }
  if (reason === "metadata-version") f.provenance.version = "0.1.0";
  await put(f.root, `${f.output}/provenance.json`, JSON.stringify(f.provenance));
  const result = pack(f.root); expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(expectedError);
  await expect(readFile(join(f.root, "release/0.1.0-beta.6/packages/gmem-0.1.0-beta.6-darwin-arm64.tar.gz"))).rejects.toThrow();
});
