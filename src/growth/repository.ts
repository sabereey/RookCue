import { isBoundConflictArchive } from "../personal/conflict-archives.js";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import {
  capabilityStateSchema, checkpointSchema, conceptRecordSchema, knowledgeDecisionReceiptSchema,
  personalReviewStateSchema, projectEventSchema, reviewSessionSchema, taskRecordSchema,
} from "../domain/schema.js";
import { writeJsonAtomic } from "../storage/files.js";
import { PersonalRepository } from "../storage/personal-repository.js";
import { ProjectRepository } from "../storage/project-repository.js";
import { assertSeparateStorageRoots, safeChildPath } from "../storage/paths.js";
import {
  assertSafePath, invalidStoredData, parseStored, parseStoredLines,
  readConsistentFiles, readSafeFile, type SnapshotFiles, type SnapshotFileSet,
} from "../storage/snapshot-files.js";
import {
  capturedReviewSchema, growthObservationSchema, projectIdentitySchema,
  type CapturedReview, type GrowthObservation, type GrowthSnapshot,
} from "./schema.js";

export type CaptureSkippedReview = {
  taskId: string;
  reviewId: string;
  taskStatus: "active" | "abandoned";
  reason: "task-not-completed";
};
export type CaptureResult = { captured: CapturedReview[]; reused: string[]; skipped: CaptureSkippedReview[] };

export class GrowthRepository {
  public readonly paths;
  public readonly observationDirectory: string;
  public readonly capturedReviewDirectory: string;
  public readonly identityPath: string;

  constructor(
    public readonly projectRepository: ProjectRepository,
    public readonly personalRepository: PersonalRepository,
    private readonly options: { clock: () => Date; id: () => string },
  ) {
    this.paths = { project: projectRepository.paths.project, personal: personalRepository.paths.personal };
    this.observationDirectory = join(this.paths.personal.base, "growth", "observations");
    this.capturedReviewDirectory = join(this.paths.personal.base, "growth", "reviews");
    this.identityPath = join(this.paths.project.base, "project-identity.json");
  }

  async readSnapshot(): Promise<GrowthSnapshot> {
    await assertSeparateStorageRoots(this.paths);
    const files = await readConsistentFiles(this.fileSet());
    const identity = optionalRecord(files, this.identityPath, projectIdentitySchema);
    return {
      ...this.projectRecords(files),
      concepts: records(files, this.paths.personal.concepts, conceptRecordSchema, "id", true),
      capabilities: optionalRecord(files, this.paths.personal.capabilities, capabilityStateSchema) ?? { version: 1, records: [] },
      observations: records(files, this.observationDirectory, growthObservationSchema, "id", true),
      capturedReviews: records(files, this.capturedReviewDirectory, capturedReviewSchema, "id", true),
      personalReviewStates: records(files, this.paths.personal.reviews, personalReviewStateSchema, "reviewId", true),
      decisionReceipts: [...files].filter(([path]) => dirname(path) === this.paths.personal.reviews && path.endsWith(".decisions.jsonl"))
        .flatMap(([path, raw]) => parseStoredLines(path, raw, knowledgeDecisionReceiptSchema)),
      projectRoot: dirname(this.paths.project.base),
      ...(identity ? { sourceId: identity.sourceId } : {}),
    };
  }

  async capture(): Promise<CaptureResult> {
    await assertSeparateStorageRoots(this.paths);
    await this.assertSafeMutationRoot(this.paths.project.base);
    const prepared = await this.projectRepository.withMutationLock(async () => {
      await this.assertSafeMutationRoot(this.paths.project.base);
      let identity = optionalRecord(await readConsistentFiles({ roots: [dirname(this.paths.project.base)], files: [this.identityPath], directories: [] }), this.identityPath, projectIdentitySchema);
      if (!identity) {
        const result = projectIdentitySchema.safeParse({ version: 1, sourceId: this.options.id() });
        if (!result.success) throw new DomainError("INVALID_IDENTIFIER", "Generated project source ID is unsafe", { issues: result.error.issues });
        identity = result.data;
        await assertSafePath(this.identityPath, "file", dirname(this.paths.project.base));
        await writeJsonAtomic(this.identityPath, identity);
      }
      const files = await readConsistentFiles(this.projectFileSet());
      const snapshotIdentity = optionalRecord(files, this.identityPath, projectIdentitySchema);
      if (!snapshotIdentity || snapshotIdentity.sourceId !== identity.sourceId) {
        throw new DomainError("GROWTH_SOURCE_CHANGED", "Project source identity changed during capture; retry after project writes finish");
      }
      const source = this.projectRecords(files);
      const capturedAt = this.options.clock().toISOString();
      const records: CapturedReview[] = [];
      const skipped: CaptureSkippedReview[] = [];
      for (const review of source.reviews.filter((item) => item.status === "completed")) {
        const task = source.tasks.find((item) => item.id === review.taskId);
        if (!task || review.phase !== "complete") {
          throw new DomainError("GROWTH_INVALID_SOURCE", "Completed review requires a real task and complete phase; repair project records before capture", { reviewId: review.id, taskId: review.taskId });
        }
        if (task.status !== "completed") {
          skipped.push({ taskId: task.id, reviewId: review.id, taskStatus: task.status, reason: "task-not-completed" });
          continue;
        }
        records.push(capturedReviewSchema.parse({
          version: 1,
          id: createHash("sha256").update(JSON.stringify([identity.sourceId, review.id])).digest("hex"),
          sourceId: identity.sourceId, taskId: task.id, reviewId: review.id,
          taskType: task.type ?? "general", conceptIds: [...new Set(task.conceptIds ?? [])].sort(),
          signals: [...new Set(review.recommendation?.signals ?? [])].sort(), level: review.level,
          templateIds: [...new Set(review.entries.flatMap((entry) => entry.templateId ? [entry.templateId] : []))].sort(),
          taskCompletedAt: task.completedAt ?? null, completedAt: review.completedAt ?? null, capturedAt,
        }));
      }
      return { records, skipped };
    });
    // Project and personal locks never overlap. Validate every source join above
    // before acquiring a personal lock (which itself creates the personal root).
    if (prepared.records.length === 0) return { captured: [], reused: [], skipped: prepared.skipped };
    await this.assertSafeMutationRoot(this.paths.personal.base);
    return this.personalRepository.withMutationLock(async () => {
      const captured: CapturedReview[] = [];
      const reused: string[] = [];
      const pending: CapturedReview[] = [];
      for (const record of prepared.records) {
        const path = this.capturePath(record.id);
        const raw = await readSafeFile(path, this.paths.personal.base);
        if (raw === undefined) { pending.push(record); continue; }
        const existing = parseStored(path, raw, capturedReviewSchema, "id");
        // Missing and null legacy task dates both mean unknown; known dates stay immutable.
        const { capturedAt: oldTime, taskCompletedAt: oldCompletion, ...oldIntrinsic } = existing;
        const { capturedAt: newTime, taskCompletedAt: newCompletion, ...newIntrinsic } = record;
        if (JSON.stringify({ ...oldIntrinsic, taskCompletedAt: oldCompletion ?? null }) !== JSON.stringify({ ...newIntrinsic, taskCompletedAt: newCompletion ?? null })) {
          throw new DomainError("GROWTH_CAPTURE_CONFLICT", "Captured review already exists with different source data; retain both sources and resolve their identity conflict", { id: record.id });
        }
        reused.push(existing.id);
      }
      for (const record of pending) {
        try {
          const path = this.capturePath(record.id);
          await assertSafePath(path, "file", this.paths.personal.base);
          await writeJsonAtomic(path, record);
          captured.push(record);
        } catch (error) {
          throw new DomainError("GROWTH_CAPTURE_PARTIAL", "Review capture stopped; retry to reuse completed records", {
            completedIds: [...reused, ...captured.map((item) => item.id)],
            failedId: record.id, cause: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { captured, reused, skipped: prepared.skipped };
    });
  }

  async saveObservation(input: GrowthObservation): Promise<void> {
    const result = growthObservationSchema.safeParse(input);
    if (!result.success) throw new DomainError("INVALID_GROWTH_OBSERVATION", "Growth observation is invalid", { issues: result.error.issues });
    const record = result.data;
    const path = safeChildPath(this.observationDirectory, `${record.id}.json`);
    await assertSafePath(path, "file", this.paths.personal.base);
    await this.assertSafeMutationRoot(this.paths.personal.base);
    await this.personalRepository.withMutationLock(async () => {
      const raw = await readSafeFile(path, this.paths.personal.base);
      if (raw !== undefined) {
        const existing = parseStored(path, raw, growthObservationSchema, "id");
        if (JSON.stringify(existing) !== JSON.stringify(record)) throw new DomainError("GROWTH_OPERATION_CONFLICT", "Operation ID already belongs to a different observation", { id: record.id });
        return;
      }
      await assertSafePath(path, "file", this.paths.personal.base);
      await writeJsonAtomic(path, record);
    });
  }

  private capturePath(id: string): string { return safeChildPath(this.capturedReviewDirectory, `${id}.json`); }

  private async assertSafeMutationRoot(root: string): Promise<void> {
    const owningRoot = root === this.paths.project.base ? dirname(root) : this.paths.personal.base;
    await assertSafePath(root, "directory", owningRoot);
    await assertSafePath(join(root, ".mutation.lock"), "directory", owningRoot);
  }

  private projectRecords(files: SnapshotFiles) {
    return {
      tasks: records(files, this.paths.project.tasks, taskRecordSchema, "id"),
      reviews: records(files, this.paths.project.reviews, reviewSessionSchema, "id"),
      checkpoints: records(files, this.paths.project.checkpoints, checkpointSchema, "id"),
      events: parseStoredLines(this.paths.project.events, files.get(this.paths.project.events), projectEventSchema),
    };
  }

  private projectFileSet(): SnapshotFileSet {
    return { roots: [dirname(this.paths.project.base)], files: [this.identityPath, this.paths.project.events], directories: [
      { path: this.paths.project.tasks }, { path: this.paths.project.reviews }, { path: this.paths.project.checkpoints },
    ] };
  }

  private fileSet(): SnapshotFileSet {
    const project = this.projectFileSet();
    return { roots: [this.paths.personal.base, ...project.roots], files: [...project.files, this.paths.personal.capabilities], directories: [...project.directories,
      { path: this.paths.personal.concepts, allowConflictArchives: true }, { path: this.paths.personal.reviews, allowConflictArchives: true },
      { path: this.paths.personal.reviews, suffix: ".decisions.jsonl" },
      { path: this.observationDirectory, allowConflictArchives: true }, { path: this.capturedReviewDirectory, allowConflictArchives: true },
    ] };
  }
}

function optionalRecord<T>(files: SnapshotFiles, path: string, schema: z.ZodType<T>): T | undefined {
  const raw = files.get(path);
  return raw === undefined ? undefined : parseStored(path, raw, schema);
}

function records<T>(files: SnapshotFiles, directory: string, schema: z.ZodType<T>, idField: keyof T, personal = false): T[] {
  return [...files].filter(([path]) => dirname(path) === directory && path.endsWith(".json"))
    .map(([path, raw]) => {
      if (raw === undefined) throw invalidStoredData(path, "Record disappeared");
      const result = parseStored(path, raw, schema);
      if (personal && raw !== undefined && isBoundConflictArchive(path, String(result[idField]))) {
        return undefined;
      }
      return parseStored(path, raw, schema, idField);
    }).filter((item): item is T => item !== undefined);
}
