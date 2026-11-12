import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { releaseSourceIdentity, validateNodeLicense } from "./release-context.mjs";

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const supportedTargets = new Map([
  ["darwin-arm64", { platform: "darwin", arch: "arm64" }],
  ["darwin-x64", { platform: "darwin", arch: "x64" }],
  ["linux-x64", { platform: "linux", arch: "x64" }],
  ["win32-x64", { platform: "win32", arch: "x64" }],
]);

export function parseReleaseTarget(value) {
  const target = supportedTargets.get(value);
  if (!target) {
    throw new Error(`Unsupported release target: ${value}`);
  }
  return target;
}

export function releaseAssetName({ platform, arch }) {
  return `gmem-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

async function main() {
  const requested = process.argv.at(-1);
  if (!requested || requested === process.argv[0] || requested === process.argv[1]) {
    throw new Error("Missing release target. Use --target <platform-arch>.");
  }

  const target = parseReleaseTarget(requested.replace("--target=", ""));
  if (target.platform !== process.platform || target.arch !== process.arch) {
    throw new Error(
      `Native build required: requested ${requested}, running ${process.platform}-${process.arch}`,
    );
  }
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error("Node 24 or newer is required to build the SEA binary");
  }

  const identity = await releaseSourceIdentity(repoRoot);
  const { nodeLicenseSHA256 } = await validateNodeLicense(repoRoot, process.versions.node);

  const packageJson = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  );
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json version is required for release output paths");
  }

  const targetKey = `${target.platform}-${target.arch}`;
  const workDir = join(repoRoot, "release", "work");
  const outputDir = join(repoRoot, "release", packageJson.version, targetKey);
  const bundlePath = join(workDir, "gmem.cjs");
  const blobPath = join(workDir, "gmem.blob");
  const configPath = join(workDir, "sea-config.json");
  const binaryPath = join(outputDir, releaseAssetName(target));
  const checksumPath = join(outputDir, "SHA256SUMS");
  const provenancePath = join(outputDir, "provenance.json");

  await mkdir(workDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await rm(blobPath, { force: true });
  await rm(configPath, { force: true });
  await rm(binaryPath, { force: true });
  await rm(checksumPath, { force: true });
  await rm(provenancePath, { force: true });

  try {
    await writeFile(
      configPath,
      JSON.stringify(
        {
          main: bundlePath,
          mainFormat: "commonjs",
          output: blobPath,
          disableExperimentalSEAWarning: true,
        },
        null,
        2,
      ),
    );

    execFileSync(
      require.resolve("esbuild/bin/esbuild"),
      [
        "src/cli.ts",
        "--bundle",
        "--platform=node",
        "--format=cjs",
        "--target=node24",
        `--outfile=${bundlePath}`,
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
    execFileSync(process.execPath, ["--experimental-sea-config", configPath], {
      cwd: repoRoot,
      stdio: "inherit",
    });

    if (process.platform === "darwin") {
      const lipoArchitecture = target.arch === "x64" ? "x86_64" : target.arch;
      const lipoInfo = execFileSync("lipo", ["-info", process.execPath], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (lipoInfo.includes("Non-fat file")) {
        await copyFile(process.execPath, binaryPath);
      } else {
        execFileSync(
          "lipo",
          ["-thin", lipoArchitecture, process.execPath, "-output", binaryPath],
          { cwd: repoRoot, stdio: "inherit" },
        );
      }
      execFileSync("codesign", ["--remove-signature", binaryPath], {
        cwd: repoRoot,
        stdio: "inherit",
      });
    } else {
      await copyFile(process.execPath, binaryPath);
    }

    const postjectArgs = [
      require.resolve("postject/dist/cli.js"),
      binaryPath,
      "NODE_SEA_BLOB",
      blobPath,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ];
    if (process.platform === "darwin") {
      postjectArgs.push("--macho-segment-name", "NODE_SEA");
    }
    execFileSync(
      process.execPath,
      postjectArgs,
      { cwd: repoRoot, stdio: "inherit" },
    );
    if (process.platform === "darwin") {
      execFileSync("codesign", ["--sign", "-", binaryPath], {
        cwd: repoRoot,
        stdio: "inherit",
      });
    }

    const digest = createHash("sha256")
      .update(await readFile(binaryPath))
      .digest("hex");
    await writeFile(checksumPath, `${digest}  ${basename(binaryPath)}\n`);
    const after = await releaseSourceIdentity(repoRoot);
    if (after.sourceSHA !== identity.sourceSHA || after.version !== identity.version) {
      throw new Error("Source commit/version changed during native build");
    }
    await writeFile(provenancePath, JSON.stringify({
      ...identity,
      target: targetKey,
      nodeVersion: process.versions.node,
      binarySHA256: digest,
      nodeLicenseSHA256,
    }, null, 2) + "\n");
  } finally {
    await rm(configPath, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
