import { bindsPersonalRecord, isBoundConflictArchive } from "../personal/conflict-archives.js";
import { invalidStoredData } from "./snapshot-files.js";
import { validatePersonalAsset } from "../personal/personal-asset-paths.js";
import { assertSafePath, readSafeFile } from "./snapshot-files.js";
import type { Dirent } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import {
  capabilityStateSchema,
  conceptRecordSchema,
  knowledgeDecisionReceiptSchema,
  personalReviewStateSchema,
  type CapabilityState,
  type ConceptRecord,
  type KnowledgeDecisionReceipt,
  type PersonalReviewState,
} from "../domain/schema.js";
import {
  appendJsonLine,
  readJson,
  readJsonLines,
  writeBufferAtomic,
  writeJsonAtomic,
  writeTextAtomic,
} from "./files.js";
import { restrictedIdSchema } from "../domain/schema.js";
import { DomainError } from "../domain/errors.js";
import { assertSeparateStorageRoots, safeChildPath, toLogicalPath, type AssetPaths } from "./paths.js";
import { withLocalRootLock } from "./root-lock.js";

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function createDefaultCapabilityState(): CapabilityState {
  return {
    version: 1,
    records: [],
  };
}

export class PersonalRepository {
  constructor(
    public readonly paths: AssetPaths,
    private readonly options: {
      clock?: () => Date;
    } = {},
  ) {}

  async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const root = this.paths.personal.base;
    await assertSafePath(root, "directory", root);
    await assertSafePath(join(root, ".mutation.lock"), "directory", root);
    return withLocalRootLock(root, async () => {
      await assertSafePath(root, "directory", root);
      return operation();
    });
  }

  async saveReviewState(reviewState: PersonalReviewState): Promise<void> {
    return this.withMutationLock(async () => {
      await assertSeparateStorageRoots(this.paths);
      return writeJsonAtomic(
        this.reviewStatePath(reviewState.reviewId),
        personalReviewStateSchema.parse(reviewState),
      );
    });
  }

  async readReviewState(reviewId: string): Promise<PersonalReviewState> {
    const state = await readJson(this.reviewStatePath(reviewId), personalReviewStateSchema);
    if (state.reviewId !== reviewId) throw invalidStoredData(this.reviewStatePath(reviewId), 'Archive aliases are not active review state');
    return state;
  }

  async appendDecisionReceipt(receipt: KnowledgeDecisionReceipt): Promise<void> {
    return this.withMutationLock(async () => {
      await assertSeparateStorageRoots(this.paths);
      const parsed = knowledgeDecisionReceiptSchema.parse(receipt);
      return appendJsonLine(this.decisionReceiptPathFromCandidate(parsed.candidateId), parsed);
    });
  }

  readDecisionReceipts(candidateId: string): Promise<KnowledgeDecisionReceipt[]> {
    return readJsonLines(
      this.decisionReceiptPathFromCandidate(candidateId),
      knowledgeDecisionReceiptSchema,
    );
  }

  saveConcept(concept: ConceptRecord): Promise<void> {
    return this.withMutationLock(async () => {
      return writeJsonAtomic(
        this.conceptJsonPath(concept.id),
        conceptRecordSchema.parse(concept),
      );
    });
  }

  async readConcept(conceptId: string): Promise<ConceptRecord> {
    const record = await readJson(this.conceptJsonPath(conceptId), conceptRecordSchema);
    if (record.id !== conceptId) throw invalidStoredData(this.conceptJsonPath(conceptId), 'Archive aliases are not active concepts');
    return record;
  }

  async listConcepts(): Promise<ConceptRecord[]> {
    let entries: string[];

    try {
      entries = await readdir(this.paths.personal.concepts);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return [];
      }

      throw error;
    }

    const conceptIds = entries
      .filter((entry) => entry.endsWith(".json") && !entry.startsWith("._"))
      .map((entry) => basename(entry, ".json"))
      .sort();

    const records = await Promise.all(conceptIds.map(async (id) => {
      const path = safeChildPath(this.paths.personal.concepts, `${id}.json`);
      const record = await readJson(path, conceptRecordSchema);
      if (isBoundConflictArchive(path, record.id)) return undefined;
      if (!bindsPersonalRecord(path, record.id)) throw invalidStoredData(path, 'Record filename does not match payload identifier');
      return record;
    }));
    return records.filter((record): record is ConceptRecord => record !== undefined);
  }

  async listPersonalFiles(): Promise<string[]> {
    return this.listFilesRelative(this.paths.personal.base, "");
  }

  async readPersonalFile(relativePath: string): Promise<Buffer> {
    const path = safeChildPath(this.paths.personal.base, relativePath);
    await assertSafePath(path, "file", this.paths.personal.base);
    let content: Buffer;
    if (relativePath.startsWith("growth/")) {
      const raw = await readSafeFile(path, this.paths.personal.base);
      if (raw === undefined) throw Object.assign(new Error(`Personal asset not found: ${relativePath}`), { code: "ENOENT" });
      content = Buffer.from(raw);
    } else content = await readFile(path);
    validatePersonalAsset(relativePath, content);
    return content;
  }

  async writePersonalFile(relativePath: string, content: Buffer): Promise<void> {
    return this.withMutationLock(async () => {
      const path = safeChildPath(this.paths.personal.base, relativePath);
      await this.assertReviewNamespaceOwnership(path);
      await assertSafePath(path, "file", this.paths.personal.base);
      validatePersonalAsset(relativePath, content);
      await writeBufferAtomic(path, content);
    });
  }

  async removePersonalFile(relativePath: string): Promise<void> {
    return this.withMutationLock(async () => {
      const path = safeChildPath(this.paths.personal.base, relativePath);
      await this.assertReviewNamespaceOwnership(path);
      return rm(path, { force: true });
    });
  }

  writeConceptMarkdown(conceptId: string, markdown: string): Promise<void> {
    return this.withMutationLock(async () => {
      return writeTextAtomic(this.conceptMarkdownPath(conceptId), markdown);
    });
  }

  writePractice(reviewId: string, markdown: string): Promise<void> {
    return this.withMutationLock(async () => {
      return writeTextAtomic(this.practicePath(reviewId), markdown);
    });
  }

  async readPractice(reviewId: string): Promise<string> {
    try {
      return await readFile(this.practicePath(reviewId), "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return "";
      }

      throw error;
    }
  }

  async readCapabilities(): Promise<CapabilityState> {
    try {
      return await readJson(this.paths.personal.capabilities, capabilityStateSchema);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return createDefaultCapabilityState();
      }

      throw error;
    }
  }

  async saveCapabilities(state: CapabilityState): Promise<void> {
    return this.withMutationLock(async () => {
      return writeJsonAtomic(
        this.paths.personal.capabilities,
        capabilityStateSchema.parse(state),
      );
    });
  }

  private async assertReviewNamespaceOwnership(path: string): Promise<void> {
    // Reserve every case spelling, including absent paths on case-insensitive filesystems.
    const namespace = toLogicalPath(relative(this.paths.personal.base, path)).split("/")[0];
    if (namespace?.toLowerCase() === "reviews") await assertSeparateStorageRoots(this.paths);
  }

  private reviewStatePath(reviewId: string): string {
    return safeChildPath(
      this.paths.personal.reviews,
      `${this.parseIdentifier(reviewId)}.json`,
    );
  }

  private conceptMarkdownPath(conceptId: string): string {
    return safeChildPath(
      this.paths.personal.concepts,
      `${this.parseIdentifier(conceptId)}.md`,
    );
  }

  private conceptJsonPath(conceptId: string): string {
    return safeChildPath(
      this.paths.personal.concepts,
      `${this.parseIdentifier(conceptId)}.json`,
    );
  }

  private practicePath(reviewId: string): string {
    return safeChildPath(
      this.paths.personal.practice,
      `${this.parseIdentifier(reviewId)}.md`,
    );
  }

  private decisionReceiptPathFromCandidate(candidateId: string): string {
    const parsedCandidateId = this.parseIdentifier(candidateId);
    const match = /^(.*)-candidate-[1-3]$/.exec(parsedCandidateId);
    const reviewId = match?.[1];
    if (!reviewId) {
      throw new DomainError("INVALID_CANDIDATE_ID", "Candidate ID is not review-derived", {
        candidateId,
      });
    }
    return safeChildPath(this.paths.personal.reviews, `${reviewId}.decisions.jsonl`);
  }

  private async listFilesRelative(root: string, prefix: string): Promise<string[]> {
    let entries: Dirent[];

    try {
      entries = await readdir(prefix ? safeChildPath(root, prefix) : root, {
        withFileTypes: true,
      });
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return [];
      }

      throw error;
    }

    const files = await Promise.all(
      entries
        .filter((entry) => !entry.name.startsWith("._"))
        .map(async (entry) => {
          const relativePath = toLogicalPath(prefix ? join(prefix, entry.name) : entry.name);
          if (entry.isSymbolicLink() && (relativePath === "growth" || relativePath.startsWith("growth/"))) {
            await assertSafePath(safeChildPath(root, relativePath), "file", root);
          }
          if (entry.isDirectory()) {
            return this.listFilesRelative(root, relativePath);
          }
          if (entry.isFile()) {
            return [relativePath];
          }
          return [];
        }),
    );

    return files.flat().sort();
  }

  private parseIdentifier(value: string): string {
    const result = restrictedIdSchema.safeParse(value);
    if (!result.success) {
      throw new DomainError("INVALID_IDENTIFIER", "Identifier is not safe for persistence", {
        value,
        issues: result.error.issues,
      });
    }
    return result.data;
  }
}
