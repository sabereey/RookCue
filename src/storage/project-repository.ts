import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { DomainError } from "../domain/errors.js";
import {
  checkpointSchema,
  projectEventSchema,
  restrictedIdSchema,
  reviewSessionSchema,
  taskRecordSchema,
  type Checkpoint,
  type ProjectEvent,
  type ReviewSession,
  type TaskRecord,
} from "../domain/schema.js";
import {
  appendJsonLine,
  readJson,
  readJsonLines,
  writeJsonAtomic,
  writeTextAtomic,
} from "./files.js";
import { assertSeparateStorageRoots, safeChildPath, type AssetPaths } from "./paths.js";
import { withRootLock } from "./root-lock.js";
import { parseStored, readConsistentFiles } from "./snapshot-files.js";

const projectStateSchema = z.object({
  version: z.literal(1),
  activeTaskId: restrictedIdSchema.optional(),
  latestCheckpointByTaskId: z.record(restrictedIdSchema, restrictedIdSchema).default({}),
  latestReviewByTaskId: z.record(restrictedIdSchema, restrictedIdSchema).default({}),
});

export type ProjectState = z.infer<typeof projectStateSchema>;

function createDefaultState(): ProjectState {
  return {
    version: 1,
    latestCheckpointByTaskId: {},
    latestReviewByTaskId: {},
  };
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export class ProjectRepository {
  constructor(
    public readonly paths: AssetPaths,
    private readonly options: {
      clock?: () => Date;
    } = {},
  ) {}

  async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    await assertSeparateStorageRoots(this.paths);
    return withRootLock(this.paths.project.base, operation);
  }

  async saveTask(task: TaskRecord): Promise<void> {
    await assertSeparateStorageRoots(this.paths);
    const parsed = taskRecordSchema.parse(task);
    await writeJsonAtomic(this.taskPath(parsed.id), parsed);

    const state = await this.readState();
    await this.writeState(
      parsed.status === "active"
        ? { ...state, activeTaskId: parsed.id }
        : this.clearActiveTaskIfMatching(state, parsed.id),
    );
  }

  async listTasks(): Promise<TaskRecord[]> {
    return this.listRecords(this.paths.project.tasks, taskRecordSchema);
  }

  async listReviews(): Promise<ReviewSession[]> {
    return this.listRecords(this.paths.project.reviews, reviewSessionSchema);
  }

  async listCheckpoints(): Promise<Checkpoint[]> {
    return this.listRecords(this.paths.project.checkpoints, checkpointSchema);
  }

  private async listRecords<T extends { id: string }>(directory: string, schema: z.ZodType<T>): Promise<T[]> {
    const files = await readConsistentFiles({ roots: [dirname(this.paths.project.base)], files: [], directories: [{ path: directory }] });
    return [...files].map(([path, raw]) => parseStored(path, raw!, schema, "id"));
  }

  async readTask(taskId: string): Promise<TaskRecord> {
    return readJson(this.taskPath(taskId), taskRecordSchema);
  }

  async restoreTaskRecord(taskId: string, task?: TaskRecord): Promise<void> {
    await assertSeparateStorageRoots(this.paths);
    const path = this.taskPath(taskId);
    if (task) {
      await writeJsonAtomic(path, taskRecordSchema.parse(task));
      return;
    }
    await rm(path, { force: true });
  }

  async readCheckpoint(checkpointId: string): Promise<Checkpoint> {
    return readJson(this.checkpointPath(checkpointId), checkpointSchema);
  }

  async readEvent(eventId: string): Promise<ProjectEvent | undefined> {
    const parsedId = this.parseIdentifier(eventId);
    return (await this.readEvents()).find((event) => event.id === parsedId);
  }

  async appendEvent(event: ProjectEvent): Promise<void> {
    await assertSeparateStorageRoots(this.paths);
    const parsed = projectEventSchema.parse(event);
    await appendJsonLine(this.paths.project.events, parsed);
  }

  readEvents(): Promise<ProjectEvent[]> {
    return readJsonLines(this.paths.project.events, projectEventSchema);
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await assertSeparateStorageRoots(this.paths);
    const parsed = checkpointSchema.parse(checkpoint);
    await writeJsonAtomic(this.checkpointPath(parsed.id), parsed);

    const state = await this.readState();
    await this.writeState({
      ...state,
      latestCheckpointByTaskId: {
        ...state.latestCheckpointByTaskId,
        [parsed.taskId]: parsed.id,
      },
    });
  }

  async removeCheckpoint(
    checkpointId: string,
    taskId: string,
    previousCheckpointId?: string,
  ): Promise<void> {
    await assertSeparateStorageRoots(this.paths);
    const checkpoint = await this.readCheckpointIfExists(checkpointId);

    if (checkpoint && checkpoint.taskId !== taskId) {
      throw new DomainError(
        "CHECKPOINT_TASK_MISMATCH",
        `Checkpoint ${checkpointId} does not belong to task ${taskId}`,
        {
          checkpointId,
          expectedTaskId: taskId,
          actualTaskId: checkpoint.taskId,
        },
      );
    }

    await rm(this.checkpointPath(checkpointId), { force: true });

    const state = await this.readState();
    if (state.latestCheckpointByTaskId[taskId] !== checkpointId) {
      return;
    }

    const latestCheckpointByTaskId = { ...state.latestCheckpointByTaskId };
    if (previousCheckpointId) {
      latestCheckpointByTaskId[taskId] = previousCheckpointId;
    } else {
      delete latestCheckpointByTaskId[taskId];
    }

    await this.writeState({
      ...state,
      latestCheckpointByTaskId,
    });
  }

  async latestCheckpoint(taskId: string): Promise<Checkpoint | undefined> {
    const state = await this.readState();
    const checkpointId = state.latestCheckpointByTaskId[taskId];

    if (!checkpointId) {
      return undefined;
    }

    try {
      return await readJson(this.checkpointPath(checkpointId), checkpointSchema);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return undefined;
      }

      throw error;
    }
  }

  async saveReview(review: ReviewSession): Promise<void> {
    await assertSeparateStorageRoots(this.paths);
    const parsed = reviewSessionSchema.parse(review);
    await writeJsonAtomic(this.reviewPath(parsed.id), parsed);

    const state = await this.readState();
    await this.writeState({
      ...state,
      latestReviewByTaskId: {
        ...state.latestReviewByTaskId,
        [parsed.taskId]: parsed.id,
      },
    });
  }

  async readReview(reviewId: string): Promise<ReviewSession> {
    return readJson(this.reviewPath(reviewId), reviewSessionSchema);
  }

  async writeCurrent(markdown: string): Promise<void> {
    await assertSeparateStorageRoots(this.paths);
    return writeTextAtomic(this.paths.project.current, markdown);
  }

  async readCurrent(): Promise<string> {
    return this.readTextOrDefault(this.paths.project.current, "");
  }

  async writeWorking(markdown: string): Promise<void> {
    await assertSeparateStorageRoots(this.paths);
    return writeTextAtomic(this.paths.project.working, markdown);
  }

  async readWorking(): Promise<string> {
    return this.readTextOrDefault(
      this.paths.project.working,
      "# Working Memory\n\n## Active Task\nNo active task.\n",
    );
  }

  async writeEvolution(slug: string, markdown: string): Promise<string> {
    await assertSeparateStorageRoots(this.paths);
    const filePath = this.evolutionPath(slug);
    await writeTextAtomic(filePath, markdown);
    return filePath;
  }

  evolutionPath(slug: string): string {
    const timestamp = this.timestampForFileName();
    return safeChildPath(
      this.paths.project.evolution,
      `${timestamp}-${this.parseIdentifier(slug)}.md`,
    );
  }

  async readEvolutionIfExists(filePath: string): Promise<string | undefined> {
    this.assertEvolutionPath(filePath);
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async restoreEvolution(filePath: string, markdown?: string): Promise<void> {
    await assertSeparateStorageRoots(this.paths);
    this.assertEvolutionPath(filePath);
    if (markdown === undefined) {
      await rm(filePath, { force: true });
      return;
    }
    await writeTextAtomic(filePath, markdown);
  }

  async readState(): Promise<ProjectState> {
    try {
      return await readJson(this.paths.project.state, projectStateSchema);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return createDefaultState();
      }

      throw error;
    }
  }

  async restoreState(state: ProjectState): Promise<void> {
    await assertSeparateStorageRoots(this.paths);
    await writeJsonAtomic(this.paths.project.state, projectStateSchema.parse(state));
  }

  private async writeState(state: ProjectState): Promise<void> {
    await this.restoreState(state);
  }

  private clearActiveTaskIfMatching(
    state: ProjectState,
    taskId: string,
  ): ProjectState {
    if (state.activeTaskId !== taskId) {
      return state;
    }

    return {
      version: state.version,
      latestCheckpointByTaskId: state.latestCheckpointByTaskId,
      latestReviewByTaskId: state.latestReviewByTaskId,
    };
  }

  private taskPath(taskId: string): string {
    return safeChildPath(this.paths.project.tasks, `${this.parseIdentifier(taskId)}.json`);
  }

  private checkpointPath(checkpointId: string): string {
    return safeChildPath(
      this.paths.project.checkpoints,
      `${this.parseIdentifier(checkpointId)}.json`,
    );
  }

  private reviewPath(reviewId: string): string {
    return safeChildPath(this.paths.project.reviews, `${this.parseIdentifier(reviewId)}.json`);
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

  private assertEvolutionPath(filePath: string): void {
    const resolvedPath = resolve(filePath);
    const fileName = resolvedPath.slice(resolve(this.paths.project.evolution).length + 1);
    if (safeChildPath(this.paths.project.evolution, fileName) !== resolvedPath) {
      throw new DomainError("UNSAFE_PATH", "Evolution path escapes its owning root", {
        filePath,
      });
    }
  }

  private async readCheckpointIfExists(checkpointId: string): Promise<Checkpoint | undefined> {
    try {
      return await readJson(this.checkpointPath(checkpointId), checkpointSchema);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return undefined;
      }

      throw error;
    }
  }

  private async readTextOrDefault(filePath: string, fallback: string): Promise<string> {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return fallback;
      }

      throw error;
    }
  }

  private timestampForFileName(): string {
    return (this.options.clock?.() ?? new Date()).toISOString().replace(/:/g, "-");
  }
}
