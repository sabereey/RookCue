import { conflictBasePath } from "../personal/conflict-archives.js";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import { restrictedIdSchema } from "../domain/schema.js";

export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function invalidStoredData(path: string, cause: unknown): DomainError {
  return new DomainError("INVALID_STORED_DATA", `Invalid stored record at ${path}; restore or repair the source file before retrying`, {
    sourcePath: path, cause: cause instanceof Error ? cause.message : String(cause),
  });
}

/** Ancestor aliases are allowed; the selected root and its children cannot be links. */
export async function assertSafePath(path: string, kind: "file" | "directory", owningRoot: string): Promise<boolean> {
  const absolute = resolve(path);
  const root = resolve(owningRoot);
  const child = relative(root, absolute);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new DomainError("UNSAFE_PATH", "Growth source path escapes its selected root", { sourcePath: absolute, root });
  }
  let current = root;
  const parts = child.split(sep).filter(Boolean);
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = join(current, parts[index]!);
    let details;
    try { details = await lstat(current); }
    catch (error) { if (isMissing(error)) return false; throw error; }
    if (details.isSymbolicLink()) {
      throw new DomainError("UNSAFE_PATH", `Symbolic links are not allowed in growth source paths: ${current}`, { sourcePath: current });
    }
    const expectedDirectory = index < parts.length - 1 || kind === "directory";
    if (expectedDirectory ? !details.isDirectory() : !details.isFile()) {
      throw invalidStoredData(current, `Expected a regular ${expectedDirectory ? "directory" : "file"}`);
    }
  }
  return true;
}

export async function readSafeFile(path: string, owningRoot: string): Promise<string | undefined> {
  if (!await assertSafePath(path, "file", owningRoot)) return undefined;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) throw invalidStoredData(path, "Expected a regular file");
    const value = await handle.readFile("utf8");
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw sourceChanged();
    }
    if (!await assertSafePath(path, "file", owningRoot)) throw sourceChanged();
    return value;
  } catch (error) {
    if (isMissing(error)) throw sourceChanged();
    throw error;
  } finally { await handle?.close(); }
}

export async function recordPaths(directory: string, suffix: string | undefined, owningRoot: string, allowConflictArchives = false): Promise<string[]> {
  suffix ??= ".json";
  if (!await assertSafePath(directory, "directory", owningRoot)) return [];
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if (isMissing(error)) throw sourceChanged(); throw error; }
  return names.filter((name) => name.endsWith(suffix) && !name.startsWith("._"))
    .sort().map((name) => {
      const id = name.slice(0, -suffix.length);
      if (!restrictedIdSchema.safeParse(id).success && !(allowConflictArchives && restrictedIdSchema.safeParse(conflictBasePath(name).slice(0, -suffix.length)).success)) throw invalidStoredData(join(directory, name), "Unsafe record identifier");
      return join(directory, name);
    });
}

export type SnapshotFiles = Map<string, string | undefined>;
export type SnapshotFileSet = { roots: string[]; files: string[]; directories: Array<{ path: string; suffix?: string; allowConflictArchives?: boolean }> };

/** Compare the complete relevant path sets and original bytes before parsing. */
export async function readConsistentFiles(set: SnapshotFileSet): Promise<SnapshotFiles> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const first = await collectFiles(set);
      const second = await collectFiles(set);
      if (first.size === second.size && [...first].every(([path, bytes]) => second.has(path) && second.get(path) === bytes)) return second;
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "GROWTH_SOURCE_CHANGED") throw error;
    }
  }
  throw sourceChanged();
}

async function collectFiles(set: SnapshotFileSet): Promise<SnapshotFiles> {
  const records = (await Promise.all(set.directories.map((item) => recordPaths(item.path, item.suffix, sourceRoot(set, item.path), item.allowConflictArchives)))).flat();
  const result: SnapshotFiles = new Map();
  for (const path of [...new Set([...set.files, ...records])].sort()) {
    const raw = await readSafeFile(path, sourceRoot(set, path));
    if (raw === undefined && records.includes(path)) throw sourceChanged();
    result.set(path, raw);
  }
  const finalRecords = (await Promise.all(set.directories.map((item) => recordPaths(item.path, item.suffix, sourceRoot(set, item.path), item.allowConflictArchives)))).flat().sort();
  if (JSON.stringify([...records].sort()) !== JSON.stringify(finalRecords)) throw sourceChanged();
  return result;
}

function sourceRoot(set: SnapshotFileSet, path: string): string {
  const root = set.roots.find((candidate) => {
    const child = relative(resolve(candidate), resolve(path));
    return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
  });
  if (!root) throw new DomainError("UNSAFE_PATH", "Growth source is outside the selected roots", { sourcePath: path });
  return root;
}

export function parseStored<T>(path: string, raw: string, schema: z.ZodType<T>, idField?: keyof T): T {
  try {
    const result = schema.parse(JSON.parse(raw));
    if (idField && result[idField] !== basename(path, ".json")) throw new Error("Record filename does not match payload identifier");
    return result;
  } catch (error) { throw invalidStoredData(path, error); }
}

export function parseStoredLines<T>(path: string, raw: string | undefined, schema: z.ZodType<T>): T[] {
  return (raw ?? "").split(/\r?\n/).filter((line) => line.trim()).map((line) => parseStored(path, line, schema));
}

function sourceChanged(): DomainError {
  return new DomainError("GROWTH_SOURCE_CHANGED", "Growth source files changed while reading; retry after source writes finish", { attempts: 3 });
}
