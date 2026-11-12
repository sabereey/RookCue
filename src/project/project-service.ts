import { z } from "zod";

import { DomainError } from "../domain/errors.js";
import { EvidenceResolver } from "../domain/evidence-resolver.js";
import {
  checkpointSchema,
  evidenceRefSchema,
  projectEventSchema,
  taskRecordSchema,
  taskTypeSchema,
  restrictedIdSchema,
  type TaskType,
  type Checkpoint,
  type EvidenceRef,
  type ProjectEvent,
  type TaskRecord,
} from "../domain/schema.js";
import { ProjectRepository } from "../storage/project-repository.js";

export type StartTaskInput = {
  type?: TaskType;
  conceptIds?: string[];
  title: string;
  goal: string;
};

export type RecordEventInput = {
  taskId?: string;
  type: string;
  summary: string;
  evidence: EvidenceRef[];
};

export type EvolutionInput = {
  title: string;
  before: string;
  after: string;
  reason: string;
  impact: string;
  evidence: EvidenceRef[];
};

export type LoadedContext = {
  current: string;
  working: string;
  activeTask?: TaskRecord;
  latestCheckpoint?: Checkpoint;
};

const startTaskInputSchema = z.object({
  type: taskTypeSchema.optional(),
  conceptIds: z.array(restrictedIdSchema).optional(),
  title: z.string().min(1),
  goal: z.string().min(1),
});

const completeTaskSummarySchema = z.string().min(1);

const evolutionInputSchema = z.object({
  title: z.string().min(1),
  before: z.string().min(1),
  after: z.string().min(1),
  reason: z.string().min(1),
  impact: z.string().min(1),
  evidence: z.array(evidenceRefSchema).min(1),
});

export class ProjectService {
  private readonly evidenceResolver: EvidenceResolver;

  constructor(
    private readonly repository: ProjectRepository,
    private readonly options: {
      clock: () => Date;
      id: () => string;
    },
  ) {
    this.evidenceResolver = new EvidenceResolver(repository);
  }

  startTask(input: StartTaskInput): Promise<TaskRecord> {
    return this.repository.withMutationLock(() => this.startTaskUnlocked(input));
  }

  private async startTaskUnlocked(input: StartTaskInput): Promise<TaskRecord> {
    const parsedInput = this.parseInput(
      "INVALID_TASK",
      "Task input is invalid",
      startTaskInputSchema,
      input,
    );
    const state = await this.repository.readState();
    if (state.activeTaskId) {
      throw new DomainError("ACTIVE_TASK_EXISTS", "An active task already exists", {
        activeTaskId: state.activeTaskId,
      });
    }

    const task = taskRecordSchema.parse({
      id: this.options.id(),
      ...parsedInput,
      status: "active",
      startedAt: this.now(),
    });
    const startEvent = this.buildEvent({
      type: "task-started",
      taskId: task.id,
      summary: `Started task ${task.title}`,
      evidence: [{ kind: "task", id: task.id }],
    });

    const previousWorking = await this.repository.readWorking();
    let previousTask: TaskRecord | undefined;
    try {
      previousTask = await this.repository.readTask(task.id);
    } catch (error) {
      if (!this.isNotFound(error)) {
        throw error;
      }
    }

    try {
      await this.repository.saveTask(task);
      await this.repository.appendEvent(startEvent);
      await this.writeWorkingSummary(task);
      return task;
    } catch (error) {
      const rollbackErrors = await this.rollbackTaskMutation({
        taskId: task.id,
        previousTask,
        previousState: state,
        previousWorking,
        rollbackEvent: this.buildEvent({
          type: "task-start-rolled-back",
          summary: `Rolled back failed start for task ${task.id}`,
          evidence: [],
        }),
      });
      this.throwMutationFailure("START_TASK", error, rollbackErrors, { taskId: task.id });
    }
  }

  recordEvent(input: RecordEventInput): Promise<ProjectEvent> {
    return this.repository.withMutationLock(() => this.recordEventUnlocked(input));
  }

  private async recordEventUnlocked(input: RecordEventInput): Promise<ProjectEvent> {
    if (input.taskId) {
      await this.requireTask(input.taskId);
    }

    const evidence = input.evidence.map((item) => evidenceRefSchema.parse(item));
    await this.evidenceResolver.resolveAll(evidence);
    const event = projectEventSchema.parse({
      id: this.options.id(),
      at: this.now(),
      type: input.type,
      taskId: input.taskId,
      summary: input.summary,
      evidence,
    });

    await this.repository.appendEvent(event);

    return event;
  }

  checkpoint(
    taskId: string,
    reason: Checkpoint["reason"],
    snapshot: Record<string, unknown>,
    phase?: Checkpoint["phase"],
  ): Promise<Checkpoint> {
    return this.repository.withMutationLock(() =>
      this.checkpointUnlocked(taskId, reason, snapshot, phase),
    );
  }

  private async checkpointUnlocked(
    taskId: string,
    reason: Checkpoint["reason"],
    snapshot: Record<string, unknown>,
    phase?: Checkpoint["phase"],
  ): Promise<Checkpoint> {
    const task = await this.requireTask(taskId);
    const [previousWorking, previousCheckpoint, previousState] = await Promise.all([
      this.repository.readWorking(),
      this.repository.latestCheckpoint(taskId),
      this.repository.readState(),
    ]);
    const checkpoint = checkpointSchema.parse({
      id: this.options.id(),
      taskId,
      at: this.now(),
      reason,
      phase,
      snapshot,
    });
    const recordedEvent = this.buildEvent({
      type: "checkpoint-recorded",
      taskId,
      summary: `Recorded ${reason} checkpoint for ${task.title}`,
      evidence: [{ kind: "checkpoint", id: checkpoint.id }],
    });
    try {
      await this.repository.saveCheckpoint(checkpoint);
      await this.repository.appendEvent(recordedEvent);
      await this.writeWorkingSummary(task, checkpoint);
      return checkpoint;
    } catch (error) {
      const rollbackErrors = await this.rollbackCheckpoint({
        checkpoint,
        task,
        previousWorking,
        previousCheckpointId: previousCheckpoint?.id,
        previousState,
      });

      if (rollbackErrors.length > 0) {
        throw new DomainError(
          "CHECKPOINT_ROLLBACK_FAILED",
          "Checkpoint failed and rollback also failed",
          {
            taskId,
            checkpointId: checkpoint.id,
            primaryError: this.describeError(error),
            rollbackErrors,
          },
        );
      }

      throw new DomainError("CHECKPOINT_FAILED", "Checkpoint failed; state restored", {
        taskId,
        checkpointId: checkpoint.id,
        primaryError: this.describeError(error),
      });
    }
  }

  completeTask(taskId: string, summary: string): Promise<TaskRecord> {
    return this.repository.withMutationLock(() =>
      this.completeTaskUnlocked(taskId, summary),
    );
  }

  private async completeTaskUnlocked(taskId: string, summary: string): Promise<TaskRecord> {
    const existing = await this.requireTask(taskId);
    const parsedSummary = this.parseInput(
      "INVALID_TASK_EVENT",
      "Task completion summary is invalid",
      completeTaskSummarySchema,
      summary,
    );
    const completed = taskRecordSchema.parse({
      ...existing,
      status: "completed",
      completedAt: this.now(),
    });
    const completionEvent = this.buildEvent({
      type: "task-completed",
      taskId,
      summary: parsedSummary,
      evidence: [{ kind: "task", id: taskId }],
    });

    const [previousState, previousWorking] = await Promise.all([
      this.repository.readState(),
      this.repository.readWorking(),
    ]);

    try {
      await this.repository.saveTask(completed);
      await this.repository.appendEvent(completionEvent);
      await this.repository.writeWorking(this.renderIdleWorkingMemory());
      return completed;
    } catch (error) {
      const rollbackErrors = await this.rollbackTaskMutation({
        taskId,
        previousTask: existing,
        previousState,
        previousWorking,
        rollbackEvent: this.buildEvent({
          type: "task-completion-rolled-back",
          taskId,
          summary: `Rolled back failed completion for task ${taskId}`,
          evidence: [],
        }),
      });
      this.throwMutationFailure("COMPLETE_TASK", error, rollbackErrors, { taskId });
    }
  }

  updateCurrent(markdown: string, evidence: EvidenceRef[]): Promise<void> {
    return this.repository.withMutationLock(() =>
      this.updateCurrentUnlocked(markdown, evidence),
    );
  }

  private async updateCurrentUnlocked(markdown: string, evidence: EvidenceRef[]): Promise<void> {
    const parsedEvidence = this.parseEvidence("current", evidence);
    await this.evidenceResolver.resolveAll(parsedEvidence);
    const event = this.buildEvent({
      type: "current-updated",
      summary: "Updated stable current knowledge",
      evidence: parsedEvidence,
    });

    const previousCurrent = await this.repository.readCurrent();
    try {
      await this.repository.writeCurrent(markdown);
      await this.repository.appendEvent(event);
    } catch (error) {
      const rollbackErrors: string[] = [];
      await this.attemptRollback(rollbackErrors, "current rollback", () =>
        this.repository.writeCurrent(previousCurrent),
      );
      if (rollbackErrors.length === 0) {
        await this.attemptRollback(rollbackErrors, "rollback event append", () =>
          this.repository.appendEvent(
            this.buildEvent({
              type: "current-update-rolled-back",
              summary: "Rolled back failed current knowledge update",
              evidence: [],
            }),
          ),
        );
      }
      this.throwMutationFailure("UPDATE_CURRENT", error, rollbackErrors);
    }
  }

  recordEvolution(input: EvolutionInput): Promise<string> {
    return this.repository.withMutationLock(() => this.recordEvolutionUnlocked(input));
  }

  private async recordEvolutionUnlocked(input: EvolutionInput): Promise<string> {
    const parsedInput = this.parseInput(
      "INVALID_EVOLUTION",
      "Evolution input is invalid",
      evolutionInputSchema,
      input,
    );
    await this.evidenceResolver.resolveAll(parsedInput.evidence);
    const event = this.buildEvent({
      type: "evolution-recorded",
      summary: parsedInput.title,
      evidence: parsedInput.evidence,
    });
    const markdown = this.renderEvolutionMarkdown(parsedInput);
    const slug = this.toSlug(parsedInput.title);
    const path = this.repository.evolutionPath(slug);
    const previousEvolution = await this.repository.readEvolutionIfExists(path);

    try {
      await this.repository.writeEvolution(slug, markdown);
      await this.repository.appendEvent(event);
      return path;
    } catch (error) {
      const rollbackErrors: string[] = [];
      await this.attemptRollback(rollbackErrors, "evolution rollback", () =>
        this.repository.restoreEvolution(path, previousEvolution),
      );
      if (rollbackErrors.length === 0) {
        await this.attemptRollback(rollbackErrors, "rollback event append", () =>
          this.repository.appendEvent(
            this.buildEvent({
              type: "evolution-rolled-back",
              summary: `Rolled back failed evolution entry ${parsedInput.title}`,
              evidence: [],
            }),
          ),
        );
      }
      this.throwMutationFailure("EVOLUTION", error, rollbackErrors, { path });
    }
  }

  async loadContext(): Promise<LoadedContext> {
    const [current, working, state] = await Promise.all([
      this.repository.readCurrent(),
      this.repository.readWorking(),
      this.repository.readState(),
    ]);

    if (!state.activeTaskId) {
      return { current, working };
    }

    const activeTask = await this.repository.readTask(state.activeTaskId);
    const latestCheckpoint = await this.repository.latestCheckpoint(activeTask.id);

    return latestCheckpoint
      ? { current, working, activeTask, latestCheckpoint }
      : { current, working, activeTask };
  }

  private async requireTask(taskId: string): Promise<TaskRecord> {
    try {
      return await this.repository.readTask(taskId);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        throw new DomainError("TASK_NOT_FOUND", `Task ${taskId} does not exist`, {
          taskId,
        });
      }

      throw error;
    }
  }

  private parseEvidence(
    target: "current" | "evolution",
    evidence: EvidenceRef[],
  ): EvidenceRef[] {
    if (evidence.length === 0) {
      throw new DomainError("EVIDENCE_REQUIRED", `${target} requires evidence`, {
        target,
      });
    }

    return evidence.map((item) =>
      this.parseInput("INVALID_EVIDENCE", `${target} evidence is invalid`, evidenceRefSchema, item),
    );
  }

  private async rollbackCheckpoint(input: {
    checkpoint: Checkpoint;
    task: TaskRecord;
    previousWorking: string;
    previousCheckpointId: string | undefined;
    previousState: Awaited<ReturnType<ProjectRepository["readState"]>>;
  }): Promise<string[]> {
    const rollbackErrors: string[] = [];

    try {
      await this.repository.removeCheckpoint(
        input.checkpoint.id,
        input.task.id,
        input.previousCheckpointId,
      );
    } catch (error) {
      rollbackErrors.push(`checkpoint rollback failed: ${this.describeError(error)}`);
    }

    try {
      await this.repository.restoreState(input.previousState);
    } catch (error) {
      rollbackErrors.push(`state rollback failed: ${this.describeError(error)}`);
    }

    try {
      await this.repository.writeWorking(input.previousWorking);
    } catch (error) {
      rollbackErrors.push(`working rollback failed: ${this.describeError(error)}`);
    }

    if (rollbackErrors.length === 0) {
      try {
        await this.repository.appendEvent(
          this.buildEvent({
            type: "checkpoint-rolled-back",
            taskId: input.task.id,
            summary: `Rolled back ${input.checkpoint.reason} checkpoint for ${input.task.title}`,
            evidence: [{ kind: "checkpoint", id: input.checkpoint.id }],
          }),
        );
      } catch (error) {
        rollbackErrors.push(`rollback event append failed: ${this.describeError(error)}`);
      }
    }

    return rollbackErrors;
  }

  private async rollbackTaskMutation(input: {
    taskId: string;
    previousTask: TaskRecord | undefined;
    previousState: Awaited<ReturnType<ProjectRepository["readState"]>>;
    previousWorking: string;
    rollbackEvent: ProjectEvent;
  }): Promise<string[]> {
    const rollbackErrors: string[] = [];
    await this.attemptRollback(rollbackErrors, "task rollback", () =>
      this.repository.restoreTaskRecord(input.taskId, input.previousTask),
    );
    await this.attemptRollback(rollbackErrors, "state rollback", () =>
      this.repository.restoreState(input.previousState),
    );
    await this.attemptRollback(rollbackErrors, "working rollback", () =>
      this.repository.writeWorking(input.previousWorking),
    );
    if (rollbackErrors.length === 0) {
      await this.attemptRollback(rollbackErrors, "rollback event append", () =>
        this.repository.appendEvent(input.rollbackEvent),
      );
    }
    return rollbackErrors;
  }

  private async attemptRollback(
    errors: string[],
    label: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      errors.push(`${label} failed: ${this.describeError(error)}`);
    }
  }

  private throwMutationFailure(
    operation: string,
    primaryError: unknown,
    rollbackErrors: string[],
    details: Record<string, unknown> = {},
  ): never {
    if (rollbackErrors.length > 0) {
      throw new DomainError(
        `${operation}_ROLLBACK_FAILED`,
        `${operation} failed and compensation also failed`,
        {
          ...details,
          primaryError: this.describeError(primaryError),
          rollbackErrors,
        },
      );
    }

    throw new DomainError(`${operation}_FAILED`, `${operation} failed; state restored`, {
      ...details,
      primaryError: this.describeError(primaryError),
    });
  }

  private async writeWorkingSummary(
    task: TaskRecord,
    checkpoint?: Checkpoint,
  ): Promise<void> {
    await this.repository.writeWorking(this.renderWorkingMemory(task, checkpoint));
  }

  private buildEvent(input: Omit<ProjectEvent, "id" | "at">): ProjectEvent {
    return projectEventSchema.parse({
      ...input,
      id: this.options.id(),
      at: this.now(),
    });
  }

  private now(): string {
    return this.options.clock().toISOString();
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private isNotFound(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    );
  }

  private renderWorkingMemory(task: TaskRecord, checkpoint?: Checkpoint): string {
    const lines = [
      "# Working Memory",
      "",
      "## Active Task",
      `- ID: ${task.id}`,
      `- Title: ${task.title}`,
      `- Goal: ${task.goal}`,
      `- Status: ${task.status}`,
      `- Started: ${task.startedAt}`,
    ];

    if (!checkpoint) {
      lines.push("", "## Latest Checkpoint", "None yet.");
      return `${lines.join("\n")}\n`;
    }

    lines.push(
      "",
      "## Latest Checkpoint",
      `- ID: ${checkpoint.id}`,
      `- At: ${checkpoint.at}`,
      `- Reason: ${checkpoint.reason}`,
    );

    if (checkpoint.phase) {
      lines.push(`- Phase: ${checkpoint.phase}`);
    }

    lines.push("", "```json", JSON.stringify(checkpoint.snapshot, null, 2), "```");

    return `${lines.join("\n")}\n`;
  }

  private renderIdleWorkingMemory(): string {
    return "# Working Memory\n\n## Active Task\nNo active task.\n";
  }

  private renderEvolutionMarkdown(input: EvolutionInput): string {
    return [
      `# ${input.title}`,
      "",
      "## Before",
      input.before,
      "",
      "## After",
      input.after,
      "",
      "## Reason",
      input.reason,
      "",
      "## Impact",
      input.impact,
      "",
      "## Evidence",
      ...input.evidence.map((item) => `- ${item.kind}: ${item.id}`),
      "",
    ].join("\n");
  }

  private toSlug(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "evolution";
  }

  private parseInput<T>(
    code: string,
    message: string,
    schema: z.ZodType<T>,
    value: unknown,
  ): T {
    try {
      return schema.parse(value);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new DomainError(code, message, {
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }

      throw error;
    }
  }
}
