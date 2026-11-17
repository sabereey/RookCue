import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { releaseSourceIdentity } from "./release-context.mjs";
import { sourcePathIncluded } from "./package-binary.mjs";

const root = process.cwd();
const { sourceSHA, version } = await releaseSourceIdentity(root);
execFileSync(process.execPath, ["scripts/release/version.mjs", "check"], { stdio: "inherit" });
const output = join(root, "release", version, "packages");
await mkdir(output, { recursive: true });
const files = execFileSync("git", ["ls-tree", "-r", "--name-only", sourceSHA], { encoding: "utf8" }).trim().split("\n").filter(sourcePathIncluded);
execFileSync("git", ["archive", "--format=tar.gz", `--prefix=rookcue-${version}/`, `--output=${join(output, `rookcue-${version}-source.tar.gz`)}`, sourceSHA, "--", ...files]);
execFileSync("git", ["archive", "--format=tar.gz", `--prefix=rookcue-${version}/`, `--output=${join(output, `rookcue-${version}-plugin.tar.gz`)}`, sourceSHA, "--", "plugins/growth-memory", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]);
console.log(JSON.stringify({ version, sourceSHA, output }));
