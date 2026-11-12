import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  parseReleaseTarget,
  releaseAssetName,
} from "./build-binary.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export function parseChecksumLine(line) {
  const match = /^([0-9a-f]{64})  (\S+)$/.exec(line);
  if (!match) {
    throw new Error(`Invalid checksum line: ${line}`);
  }

  return { digest: match[1], file: match[2] };
}

function targetFromArgs(argv) {
  const targetIndex = argv.indexOf("--target");
  const inlineTarget = argv.find((arg) => arg.startsWith("--target="));
  const value = inlineTarget?.slice("--target=".length) ?? argv[targetIndex + 1];
  if (!value) {
    throw new Error("Missing release target. Use --target <platform-arch>.");
  }

  return parseReleaseTarget(value);
}

function run(binaryPath, args) {
  const result = spawnSync(binaryPath, args, {
    encoding: "utf8",
    env: { PATH: "" },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(
    result.status,
    0,
    `${basename(binaryPath)} ${args.join(" ")} failed:\n${result.stderr}`,
  );
  return result.stdout;
}

async function main() {
  const target = targetFromArgs(process.argv.slice(2));
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const version = packageJson.version;
  assert.equal(typeof version, "string", "package.json version is required");

  const binaryName = releaseAssetName(target);
  const outputDir = join(repoRoot, "release", version, `${target.platform}-${target.arch}`);
  const binaryPath = join(outputDir, binaryName);
  const checksumPath = join(outputDir, "SHA256SUMS");
  const checksumLines = (await readFile(checksumPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map(parseChecksumLine);
  const checksum = checksumLines.find((line) => line.file === binaryName);
  assert.ok(checksum, `SHA256SUMS is missing ${binaryName}`);

  const digest = createHash("sha256")
    .update(await readFile(binaryPath))
    .digest("hex");
  assert.equal(digest, checksum.digest, `SHA256 mismatch for ${binaryName}`);

  assert.equal(run(binaryPath, ["--version"]).trim(), version);
  assert.match(
    run(binaryPath, ["--help"]),
    /^Usage: growth-memory \[options\] \[command\]/m,
  );

  const root = await mkdtemp(join(tmpdir(), "gmem-binary-verify-"));
  const projectRoot = join(root, "project");
  const personalRoot = join(root, "personal");
  try {
    run(binaryPath, ["init", "--project", projectRoot, "--personal", personalRoot, "--json"]);
    run(binaryPath, [
      "task",
      "start",
      "--project",
      projectRoot,
      "--title",
      "Binary smoke",
      "--goal",
      "Verify SEA",
      "--json",
    ]);
    run(binaryPath, ["status", "--project", projectRoot, "--personal", personalRoot, "--json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  console.log(`Verified ${binaryPath}`);
  console.log(`SHA256 ${digest}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
