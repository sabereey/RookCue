import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { DomainError } from "../domain/errors.js";

function storedDataError(sourcePath: string, message: string, cause?: unknown): DomainError {
  return new DomainError("INVALID_STORED_DATA", message, {
    sourcePath,
    ...(cause instanceof Error ? { cause: cause.message } : {}),
  });
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function writeJsonAtomic<T>(
  filePath: string,
  value: T,
): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(
  filePath: string,
  value: string,
): Promise<void> {
  await ensureParentDirectory(filePath);
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  let renamed = false;

  try {
    await writeFile(tempPath, value, "utf8");
    await rename(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await rm(tempPath, { force: true });
    }
  }
}

export async function writeBufferAtomic(
  filePath: string,
  value: Buffer,
): Promise<void> {
  await ensureParentDirectory(filePath);
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  let renamed = false;

  try {
    await writeFile(tempPath, value);
    await rename(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await rm(tempPath, { force: true });
    }
  }
}

export async function readJson<TSchema extends z.ZodTypeAny>(
  filePath: string,
  schema: TSchema,
): Promise<z.infer<TSchema>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return schema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw storedDataError(
        filePath,
        `Stored JSON failed validation at ${filePath}`,
        error,
      );
    }
    if (error instanceof SyntaxError) {
      throw storedDataError(filePath, `Stored JSON is invalid at ${filePath}`, error);
    }
    throw error;
  }
}

export async function appendJsonLine<T>(filePath: string, value: T): Promise<void> {
  await ensureParentDirectory(filePath);
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export async function readJsonLines<TSchema extends z.ZodTypeAny>(
  filePath: string,
  schema: TSchema,
): Promise<Array<z.infer<TSchema>>> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (raw.trim().length === 0) {
      return [];
    }

    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines.map((line) => {
      const parsed = JSON.parse(line) as unknown;
      return schema.parse(parsed);
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw storedDataError(
        filePath,
        `Stored JSONL failed validation at ${filePath}`,
        error,
      );
    }
    if (error instanceof SyntaxError) {
      throw storedDataError(filePath, `Stored JSONL is invalid at ${filePath}`, error);
    }
    if (isFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
