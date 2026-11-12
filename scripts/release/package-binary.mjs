import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReleaseTarget, releaseAssetName } from "./build-binary.mjs";
import { NODE_LICENSE_SHA256 as nodeLicenseSHA256, releaseSourceIdentity, validateNodeLicense } from "./release-context.mjs";
export { releaseSourceIdentity, validateNodeLicense } from "./release-context.mjs";

const defaultRoot = fileURLToPath(new URL("../../", import.meta.url));
const rootFiles = new Set([
  "package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", ".gitignore",
  "README.md", "QUICKSTART.md", "AGENT_INTEGRATION.md", "LICENSE", "NOTICE",
  "THIRD_PARTY_NOTICES.md", "LICENSE_POLICY.md", ".agents/plugins/marketplace.json",
  "SECURITY.md", "docs/binary-build.md", "docs/phase-2-beta-upgrade.md",
  "docs/lan-direct-sync.md", "docs/lan-two-mac-acceptance.md",
]);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const json = async path => JSON.parse(await readFile(path, "utf8"));
function git(root, ...args) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); }

export function sourcePathIncluded(path) {
  if (path.startsWith("release/") || path.split("/").some(part => [".git", ".superpowers", ".growth-memory", "node_modules", "dist", ".DS_Store"].includes(part) || part.startsWith("._"))) return false;
  return rootFiles.has(path) || ["src/", "tests/", "scripts/release/", "plugins/growth-memory/", "third_party/node/v24.12.0/"].some(prefix => path.startsWith(prefix));
}

export async function prepareReleasePackage({ repoRoot = defaultRoot, target }) {
  if (!["darwin-arm64", "linux-x64"].includes(target)) throw new Error(`Unsupported packaged release target: ${target}`);
  const identity = await releaseSourceIdentity(repoRoot);
  const binaryName = releaseAssetName(parseReleaseTarget(target));
  const buildDir = join(repoRoot, "release", identity.version, target);
  const provenance = await json(join(buildDir, "provenance.json"));
  if (provenance.sourceSHA !== identity.sourceSHA) throw new Error("Binary build/source commit mismatch");
  if (provenance.version !== identity.version || provenance.target !== target) throw new Error("Binary build version/target mismatch");
  const { license } = await validateNodeLicense(repoRoot, provenance.nodeVersion);
  if (provenance.nodeLicenseSHA256 !== nodeLicenseSHA256) throw new Error("Binary build/license provenance mismatch");
  const binaryPath = join(buildDir, binaryName);
  const stat = await lstat(binaryPath);
  if (!stat.isFile() || !(stat.mode & 0o111) || sha256(await readFile(binaryPath)) !== provenance.binarySHA256) throw new Error("Binary digest or executable material mismatch");
  const reportedVersion = execFileSync(binaryPath, ["--version"], { env: { PATH: "" }, encoding: "utf8" }).trim();
  if (reportedVersion !== identity.version) throw new Error("Actual binary version mismatch");

  // Archive immutable Git objects, never the working directory. Only named reproducibility materials enter source.
  const sourceFiles = git(repoRoot, "ls-tree", "-r", "--name-only", identity.sourceSHA).trim().split("\n").filter(sourcePathIncluded);
  for (const required of ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "src/cli.ts", "scripts/release/build-binary.mjs", "docs/binary-build.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "third_party/node/v24.12.0/LICENSE"]) {
    if (!sourceFiles.includes(required)) throw new Error(`Corresponding source is missing ${required}`);
  }
  const work = await mkdtemp(join(tmpdir(), "gmem-distribution-"));
  const packageName = `gmem-${identity.version}-${target}`;
  const stage = join(work, packageName);
  const destination = join(repoRoot, "release", identity.version, "packages");
  try {
    await mkdir(stage);
    const sourceArchive = join(stage, "source.tar.gz");
    execFileSync("git", ["-C", repoRoot, "archive", "--format=tar.gz", `--prefix=gmem-${identity.version}-source/`, `--output=${sourceArchive}`, identity.sourceSHA, "--", ...sourceFiles]);
    // Confirm the actual listing against the intended set, including file type (no symlink material).
    const listing = execFileSync("tar", ["-tzf", sourceArchive], { encoding: "utf8" }).split("\n").filter(path => path && !path.endsWith("/"));
    const archived = listing.map(path => path.slice(`gmem-${identity.version}-source/`.length)).sort();
    if (JSON.stringify(archived) !== JSON.stringify([...sourceFiles].sort())) throw new Error("Actual source archive listing mismatch");
    const modes = git(repoRoot, "ls-tree", "-r", identity.sourceSHA, "--", ...sourceFiles).trim().split("\n");
    if (modes.some(line => !line.startsWith("100644 ") && !line.startsWith("100755 "))) throw new Error("Unsupported source material type (symlink/submodule)");
    await copyFile(binaryPath, join(stage, binaryName));
    for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) await copyFile(join(repoRoot, file), join(stage, file));
    await writeFile(join(stage, "NODE-LICENSE.txt"), license);
    await writeFile(join(stage, "provenance.json"), JSON.stringify({ ...provenance, sourceArchiveSHA256: sha256(await readFile(sourceArchive)) }, null, 2) + "\n");
    await writeFile(join(stage, "SOURCE.md"), `# Corresponding source\n\nVersion: ${identity.version}\nSource commit: ${identity.sourceSHA}\nCore repository: https://github.com/sabereey/rookcue\n\nThe included source.tar.gz contains the corresponding application source, tests, lockfile, build scripts and licenses from this exact commit. The included source can be built independently of the repository.\n\nExtract source.tar.gz; follow docs/binary-build.md. Install Node ${provenance.nodeVersion} for ${target}, run npm ci, npm run typecheck, npm test, and npm run build:binary -- --target ${target}. If rebuilding outside Git, initialize and commit this extracted source first; provenance then identifies your local rebuild commit. A build is reproducible from the included materials; byte-for-byte binary reproducibility is not claimed (native signing can vary). Node's complete bundled component notices are in NODE-LICENSE.txt.\n`);
    await writeFile(join(stage, "INSTALL.md"), `# Install ${identity.version} (${target})\n\nVerify the outer archive SHA-256 against the release checksum before extracting. From this extracted directory, run shasum -a 256 -c SHA256SUMS (macOS) or sha256sum -c SHA256SUMS (Linux). Preserve all source and license materials.\n\nRun ./${binaryName} --version; expected ${identity.version}. Keep a backup of the current executable and personal/project data before any upgrade. After verification, run mkdir -p ~/.local/bin, then install -m 755 ${binaryName} ~/.local/bin/gmem and ensure ~/.local/bin is on PATH. The macOS binary is ad-hoc signed, without Developer ID notarization; a concrete first-launch OS block requires a separate user decision.\n\nBefore a first capability mutation, update every writing device to runtime ${identity.version}. Growth reads preserve legacy v1 bytes; an explicit capability update creates v2/history once. Old writers cannot write v2; restore the whole prior backup for downgrade. See source archive docs/phase-2-beta-upgrade.md. Install the matching ${identity.version} companion plugin and start a fresh Codex session.\n`);
    const materials = [binaryName, "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "NODE-LICENSE.txt", "provenance.json", "SOURCE.md", "INSTALL.md", "source.tar.gz"];
    const lanHandoff = [
      ["scripts/release/verify-peer-lan.sh", "verify-peer-lan.sh"],
      ["docs/lan-two-mac-acceptance.md", "LAN-ACCEPTANCE.md"],
    ];
    if (target === "darwin-arm64" && lanHandoff.every(([source]) => sourceFiles.includes(source))) {
      for (const [source, file] of lanHandoff) {
        await copyFile(join(repoRoot, source), join(stage, file));
        materials.push(file);
      }
    }
    const checksums = await Promise.all(materials.map(async file => `${sha256(await readFile(join(stage, file)))}  ${file}\n`));
    await writeFile(join(stage, "SHA256SUMS"), checksums.join(""));
    // Detect a source edit/commit switch during preparation before emitting the archive.
    if (JSON.stringify(await releaseSourceIdentity(repoRoot)) !== JSON.stringify(identity)) throw new Error("Source commit changed during package preparation");
    const archive = join(work, `${packageName}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", work, packageName], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const bytes = await readFile(archive);
    await mkdir(destination, { recursive: true });
    // Copy to the destination filesystem before atomic rename.
    const output = join(destination, `${packageName}.tar.gz`);
    const pending = `${output}.tmp`;
    await copyFile(archive, pending); await rename(pending, output);
    return { path: output, sha256: sha256(bytes), size: bytes.length, sourceSHA: identity.sourceSHA };
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const target = args.find(arg => arg.startsWith("--target="))?.slice(9) ?? args[args.indexOf("--target") + 1];
  if (!target) throw new Error("Missing release target. Use --target <platform-arch>.");
  console.log(JSON.stringify(await prepareReleasePackage({ target })));
}
