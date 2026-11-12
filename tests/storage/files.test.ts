import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  appendJsonLine,
  readJson,
  readJsonLines,
  resolvePaths,
  toLogicalPath,
  writeJsonAtomic,
} from "../../src/index.js";
import { isPersonalKnowledgeAsset } from "../../src/personal/personal-asset-paths.js";

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

describe("storage/files", () => {
  it("resolves separate project and personal roots with native paths", () => {
    const root = join(tmpdir(), "growth-memory-path-fixtures");
    const projectRoot = join(root, "project");
    const personalRoot = join(root, "personal");
    const paths = resolvePaths(projectRoot, personalRoot);

    expect(paths.project.current).toBe(
      join(projectRoot, ".growth-memory", "current.md"),
    );
    expect(paths.personal.capabilities).toBe(
      join(personalRoot, "capabilities.json"),
    );
  });

  it("canonicalizes Windows relative paths before personal asset classification", () => {
    const nativeRelativePath = win32.join("concepts", "review-path-candidate-1.json");
    const logicalPath = toLogicalPath(nativeRelativePath);

    expect(logicalPath).toBe("concepts/review-path-candidate-1.json");
    expect(isPersonalKnowledgeAsset(logicalPath)).toBe(true);
  });

  it("atomically replaces JSON state", async () => {
    const root = await mkdtemp(join(tmpdir(), "growth-memory-"));
    createdPaths.push(root);
    const file = join(root, "state.json");

    await writeJsonAtomic(file, { version: 1 });
    await writeJsonAtomic(file, { version: 2 });

    await expect(
      readJson(file, z.object({ version: z.number() })),
    ).resolves.toEqual({ version: 2 });
  });

  it("appends and validates JSONL evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "growth-memory-"));
    createdPaths.push(root);
    const file = join(root, "events.jsonl");

    await appendJsonLine(file, { id: "e1" });
    await appendJsonLine(file, { id: "e2" });

    await expect(
      readJsonLines(file, z.object({ id: z.string() })),
    ).resolves.toEqual([{ id: "e1" }, { id: "e2" }]);
  });

  it("reports malformed stored JSON with its source path", async () => {
    const root = await mkdtemp(join(tmpdir(), "growth-memory-"));
    createdPaths.push(root);
    const file = join(root, "broken.json");
    await writeFile(file, '{"version":', "utf8");

    await expect(readJson(file, z.object({ version: z.number() }))).rejects.toMatchObject({
      code: "INVALID_STORED_DATA",
      details: { sourcePath: file },
    });
  });

  it("reports malformed stored JSONL with its source path", async () => {
    const root = await mkdtemp(join(tmpdir(), "growth-memory-"));
    createdPaths.push(root);
    const file = join(root, "broken.jsonl");
    await writeFile(file, '{"id":"valid"}\n{"id":\n', "utf8");

    await expect(readJsonLines(file, z.object({ id: z.string() }))).rejects.toMatchObject({
      code: "INVALID_STORED_DATA",
      details: { sourcePath: file },
    });
  });
});
