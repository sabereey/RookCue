import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import {
  parseReleaseTarget,
  releaseAssetName,
} from "../../scripts/release/build-binary.mjs";
// The release scripts are executable JavaScript and only the builder has a declaration file.
// @ts-expect-error -- Task 3 intentionally limits the verifier to its executable script.
import { parseChecksumLine } from "../../scripts/release/verify-binary.mjs";

it("accepts only supported release targets", () => {
  expect(parseReleaseTarget("darwin-arm64")).toEqual({
    platform: "darwin",
    arch: "arm64",
  });
  expect(() => parseReleaseTarget("linux-arm64")).toThrow(
    "Unsupported release target",
  );
});

it("uses stable public artifact names", () => {
  expect(releaseAssetName({ platform: "darwin", arch: "arm64" })).toBe(
    "gmem-darwin-arm64",
  );
  expect(releaseAssetName({ platform: "win32", arch: "x64" })).toBe(
    "gmem-win32-x64.exe",
  );
});

it("parses only conventional SHA-256 release lines", () => {
  const digest = "a".repeat(64);

  expect(parseChecksumLine(`${digest}  gmem-darwin-arm64`)).toEqual({
    digest,
    file: "gmem-darwin-arm64",
  });
  expect(() => parseChecksumLine(`${"a".repeat(63)}  gmem-darwin-arm64`)).toThrow(
    "Invalid checksum line",
  );
  expect(() => parseChecksumLine(`${"A".repeat(64)}  gmem-darwin-arm64`)).toThrow(
    "Invalid checksum line",
  );
  expect(() => parseChecksumLine(`${digest} gmem-darwin-arm64`)).toThrow(
    "Invalid checksum line",
  );
  expect(() => parseChecksumLine(`${digest}   gmem-darwin-arm64`)).toThrow(
    "Invalid checksum line",
  );
  expect(() => parseChecksumLine(`${digest}  `)).toThrow("Invalid checksum line");
  expect(() => parseChecksumLine("bad-line")).toThrow("Invalid checksum line");
});

it("builds a CommonJS bundle for the Node 24 SEA payload", async () => {
  const script = await readFile(
    new URL("../../scripts/release/build-binary.mjs", import.meta.url),
    "utf8",
  );

  expect(script).toContain('mainFormat: "commonjs"');
  expect(script).toContain('"--format=cjs"');
  expect(script).toContain('join(workDir, "gmem.cjs")');
});

it("verifies native help through the empty-PATH runner", async () => {
  const script = await readFile(
    new URL("../../scripts/release/verify-binary.mjs", import.meta.url),
    "utf8",
  );

  expect(script).toContain('run(binaryPath, ["--help"])');
  expect(script).toContain("^Usage: growth-memory \\[options\\] \\[command\\]");
});
