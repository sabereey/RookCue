import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  DomainError,
  type EvidenceRef,
  ProjectRepository,
  ProjectService,
  resolvePaths,
} from "../../src/index.js";

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

async function createFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "growth-memory-project-"));
  createdPaths.push(projectRoot);

  const paths = resolvePaths(projectRoot, join(projectRoot, ".personal-growth-memory"));
  const clock = () => new Date("2026-06-18T08:00:00.000Z");
  const repository = new ProjectRepository(paths, { clock });
  let idCounter = 0;

  const service = new ProjectService(repository, {
    clock,
    id: () => `id-${++idCounter}`,
  });

  return { paths, repository, service };
}

async function createFixtureWithRepository(
  createRepository: (paths: ReturnType<typeof resolvePaths>, clock: () => Date) => ProjectRepository,
) {
  const projectRoot = await mkdtemp(join(tmpdir(), "growth-memory-project-"));
  createdPaths.push(projectRoot);

  const paths = resolvePaths(projectRoot, join(projectRoot, ".personal-growth-memory"));
  const clock = () => new Date("2026-06-18T08:00:00.000Z");
  const repository = createRepository(paths, clock);
  let idCounter = 0;
  const service = new ProjectService(repository, {
    clock,
    id: () => `id-${++idCounter}`,
  });

  return { paths, repository, service };
}

describe("project/project-service", () => {
  it("serializes concurrent starts so only one task becomes active", async () => {
    const { repository, service } = await createFixture();

    const results = await Promise.allSettled([
      service.startTask({ title: "First", goal: "Win the root lock" }),
      service.startTask({ title: "Second", goal: "Observe the active task" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(repository.readEvents()).resolves.toHaveLength(1);
    expect((await repository.readState()).activeTaskId).toBeDefined();
  });

  it("restores a failed task start and records rollback evidence", async () => {
    class StartEventFailingRepository extends ProjectRepository {
      private failed = false;

      override async appendEvent(event: Parameters<ProjectRepository["appendEvent"]>[0]) {
        if (!this.failed && event.type === "task-started") {
          this.failed = true;
          throw new Error("start event append failed");
        }
        await super.appendEvent(event);
      }
    }

    const { repository, service } = await createFixtureWithRepository(
      (paths, clock) => new StartEventFailingRepository(paths, { clock }),
    );

    await expect(
      service.startTask({ title: "Start rollback", goal: "Restore all state" }),
    ).rejects.toMatchObject({ code: "START_TASK_FAILED" });
    expect((await repository.readState()).activeTaskId).toBeUndefined();
    await expect(repository.readWorking()).resolves.not.toContain("Start rollback");
    await expect(repository.readTask("id-1")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(repository.readEvents()).resolves.toMatchObject([
      { type: "task-start-rolled-back" },
    ]);
  });

  it("restores an active task when completion evidence append fails", async () => {
    class CompleteEventFailingRepository extends ProjectRepository {
      private failed = false;

      override async appendEvent(event: Parameters<ProjectRepository["appendEvent"]>[0]) {
        if (!this.failed && event.type === "task-completed") {
          this.failed = true;
          throw new Error("completion event append failed");
        }
        await super.appendEvent(event);
      }
    }

    const { repository, service } = await createFixtureWithRepository(
      (paths, clock) => new CompleteEventFailingRepository(paths, { clock }),
    );
    const task = await service.startTask({ title: "Complete rollback", goal: "Stay active" });

    await expect(service.completeTask(task.id, "Attempt completion")).rejects.toMatchObject({
      code: "COMPLETE_TASK_FAILED",
    });
    await expect(repository.readTask(task.id)).resolves.toMatchObject({ status: "active" });
    expect((await repository.readState()).activeTaskId).toBe(task.id);
    await expect(repository.readWorking()).resolves.toContain("Complete rollback");
    await expect(repository.readEvents()).resolves.toMatchObject([
      { type: "task-started" },
      { type: "task-completion-rolled-back" },
    ]);
  });

  it("restores current knowledge when its evidence event append fails", async () => {
    class CurrentEventFailingRepository extends ProjectRepository {
      private failed = false;

      override async appendEvent(event: Parameters<ProjectRepository["appendEvent"]>[0]) {
        if (!this.failed && event.type === "current-updated") {
          this.failed = true;
          throw new Error("current event append failed");
        }
        await super.appendEvent(event);
      }
    }

    const { repository, service } = await createFixtureWithRepository(
      (paths, clock) => new CurrentEventFailingRepository(paths, { clock }),
    );
    await repository.writeCurrent("Trusted current");

    await expect(
      service.updateCurrent("Uncommitted current", [{ kind: "commit", id: "commit-1" }]),
    ).rejects.toMatchObject({ code: "UPDATE_CURRENT_FAILED" });
    await expect(repository.readCurrent()).resolves.toBe("Trusted current");
    await expect(repository.readEvents()).resolves.toMatchObject([
      { type: "current-update-rolled-back" },
    ]);
  });

  it("removes an evolution file when its evidence event append fails", async () => {
    class EvolutionEventFailingRepository extends ProjectRepository {
      private failed = false;

      override async appendEvent(event: Parameters<ProjectRepository["appendEvent"]>[0]) {
        if (!this.failed && event.type === "evolution-recorded") {
          this.failed = true;
          throw new Error("evolution event append failed");
        }
        await super.appendEvent(event);
      }
    }

    const { paths, repository, service } = await createFixtureWithRepository(
      (assetPaths, clock) => new EvolutionEventFailingRepository(assetPaths, { clock }),
    );

    await expect(
      service.recordEvolution({
        title: "Evolution rollback",
        before: "Before",
        after: "After",
        reason: "Reason",
        impact: "Impact",
        evidence: [{ kind: "commit", id: "commit-2" }],
      }),
    ).rejects.toMatchObject({ code: "EVOLUTION_FAILED" });
    await expect(
      readFile(
        join(
          paths.project.evolution,
          "2026-06-18T08-00-00.000Z-evolution-rollback.md",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(repository.readEvents()).resolves.toMatchObject([
      { type: "evolution-rolled-back" },
    ]);
  });

  it("tracks task lifecycle and clears working memory on completion", async () => {
    const { paths, repository, service } = await createFixture();

    const task = await service.startTask({
      title: "Memory recovery",
      goal: "Restore interrupted work",
    });
    await service.recordEvent({
      taskId: task.id,
      type: "decision",
      summary: "Use baseline plus delta",
      evidence: [],
    });
    const checkpoint = await service.checkpoint(task.id, "interrupt", {
      next: "write recovery test",
    });
    const completed = await service.completeTask(
      task.id,
      "Recovery now merges checkpoint delta",
    );

    expect(completed.status).toBe("completed");
    expect(await repository.latestCheckpoint(task.id)).toEqual(checkpoint);
    await expect(repository.readEvents()).resolves.toMatchObject([
      {
        type: "task-started",
        taskId: task.id,
        summary: "Started task Memory recovery",
        evidence: [{ kind: "task", id: task.id }],
      },
      { type: "decision" },
      { type: "checkpoint-recorded" },
      { type: "task-completed" },
    ]);
    await expect(readFile(paths.project.working, "utf8")).resolves.toContain(
      "No active task",
    );
  });

  it("does not rewrite current knowledge when updateCurrent input is invalid", async () => {
    const { repository, service } = await createFixture();
    await service.updateCurrent("Stable knowledge", [{ kind: "commit", id: "commit-1" }]);

    await expect(
      service.updateCurrent("Untrusted knowledge", [{ kind: "commit", id: "" }]),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(repository.readCurrent()).resolves.toBe("Stable knowledge");
    await expect(repository.readEvents()).resolves.toHaveLength(1);
  });

  it("rejects fabricated project evidence before updating current knowledge", async () => {
    const { repository, service } = await createFixture();

    await expect(
      service.updateCurrent("Fabricated knowledge", [
        { kind: "task", id: "missing-task" },
      ]),
    ).rejects.toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
    await expect(repository.readCurrent()).resolves.toBe("");
    await expect(repository.readEvents()).resolves.toEqual([]);
  });

  it("rejects traversal identifiers at the repository boundary", async () => {
    const { repository } = await createFixture();

    await expect(repository.readTask("../../escaped")).rejects.toMatchObject({
      code: "INVALID_IDENTIFIER",
    });
  });

  it("does not write evolution files when recordEvolution input is invalid", async () => {
    const { paths, repository, service } = await createFixture();

    await expect(
      service.recordEvolution({
        title: "Delta changed",
        before: "Before",
        after: "After",
        reason: "Reason",
        impact: "Impact",
        evidence: [{ kind: "commit", id: "" }],
      }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(repository.readEvents()).resolves.toHaveLength(0);
    await expect(readFile(join(paths.project.evolution, "2026-06-18T08-00-00.000Z-delta-changed.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves evolution evidence before writing the entry", async () => {
    const { paths, repository, service } = await createFixture();

    await expect(
      service.recordEvolution({
        title: "Fabricated evolution",
        before: "Before",
        after: "After",
        reason: "Reason",
        impact: "Impact",
        evidence: [{ kind: "checkpoint", id: "missing-checkpoint" }],
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
    await expect(repository.readEvents()).resolves.toEqual([]);
    await expect(
      readFile(
        join(
          paths.project.evolution,
          "2026-06-18T08-00-00.000Z-fabricated-evolution.md",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not complete the task when completeTask input is invalid", async () => {
    const { repository, service } = await createFixture();
    const task = await service.startTask({
      title: "Memory recovery",
      goal: "Restore interrupted work",
    });

    await expect(
      service.completeTask(task.id, ""),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(repository.readTask(task.id)).resolves.toMatchObject({ status: "active" });
    await expect(repository.readWorking()).resolves.toContain("Memory recovery");
    await expect(repository.readEvents()).resolves.toHaveLength(1);
  });

  it("loads stable current knowledge separately from active work and checkpoints", async () => {
    const { service } = await createFixture();
    const stableEvidence: EvidenceRef[] = [{ kind: "commit", id: "commit-1" }];

    await service.updateCurrent("Stable knowledge only", stableEvidence);
    const task = await service.startTask({
      title: "Memory recovery",
      goal: "Restore interrupted work",
    });
    const taskEvidence: EvidenceRef[] = [{ kind: "task", id: task.id }];
    await service.recordEvent({
      taskId: task.id,
      type: "decision",
      summary: "Use baseline plus delta",
      evidence: taskEvidence,
    });
    const checkpoint = await service.checkpoint(task.id, "interrupt", {
      next: "write recovery test",
    });

    const context = await service.loadContext();

    expect(context.current).toBe("Stable knowledge only");
    expect(context.working).toContain("Memory recovery");
    expect(context.working).toContain("write recovery test");
    expect(context.working).not.toContain("Stable knowledge only");
    expect(context.activeTask).toEqual(task);
    expect(context.latestCheckpoint).toEqual(checkpoint);
  });

  it("writes deterministic evolution files and records evidence on success", async () => {
    const { paths, repository, service } = await createFixture();
    const evidence: EvidenceRef[] = [{ kind: "commit", id: "commit-7" }];

    const resultPath = await service.recordEvolution({
      title: "Sharper Task Boundaries",
      before: "Tasks mixed stable and working state.",
      after: "Stable current knowledge remains separate from working notes.",
      reason: "Recovery should not overwrite trusted knowledge.",
      impact: "Context loading can present both tracks cleanly.",
      evidence,
    });

    expect(resultPath).toBe(
      join(
        paths.project.evolution,
        "2026-06-18T08-00-00.000Z-sharper-task-boundaries.md",
      ),
    );
    await expect(readFile(resultPath, "utf8")).resolves.toContain(
      "## Evidence\n- commit: commit-7",
    );
    await expect(repository.readEvents()).resolves.toMatchObject([
      {
        type: "evolution-recorded",
        summary: "Sharper Task Boundaries",
        evidence,
      },
    ]);
  });

  it("rolls back checkpoint state and appends a compensating event when working memory update fails", async () => {
    class WorkingWriteFailingRepository extends ProjectRepository {
      private writeCount = 0;

      override async writeWorking(markdown: string): Promise<void> {
        this.writeCount += 1;
        if (this.writeCount === 2 && markdown.includes('"next": "write recovery test"')) {
          throw new Error("working write failed");
        }
        await super.writeWorking(markdown);
      }
    }

    const { repository, service } = await createFixtureWithRepository(
      (paths, clock) => new WorkingWriteFailingRepository(paths, { clock }),
    );
    const task = await service.startTask({
      title: "Memory recovery",
      goal: "Restore interrupted work",
    });
    const priorWorking = await repository.readWorking();

    await expect(
      service.checkpoint(task.id, "interrupt", {
        next: "write recovery test",
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_FAILED" });

    await expect(repository.latestCheckpoint(task.id)).resolves.toBeUndefined();
    await expect(repository.readWorking()).resolves.toBe(priorWorking);
    await expect(repository.readEvents()).resolves.toMatchObject([
      { type: "task-started" },
      { type: "checkpoint-recorded" },
      { type: "checkpoint-rolled-back" },
    ]);
  });

  it("surfaces primary and rollback failures explicitly when checkpoint compensation fails", async () => {
    class RollbackFailingRepository extends ProjectRepository {
      private writeCount = 0;

      override async writeWorking(markdown: string): Promise<void> {
        this.writeCount += 1;
        if (this.writeCount === 2 && markdown.includes('"next": "write recovery test"')) {
          throw new Error("working write failed");
        }
        await super.writeWorking(markdown);
      }

      override async removeCheckpoint(): Promise<void> {
        throw new Error("checkpoint rollback failed");
      }
    }

    const { service } = await createFixtureWithRepository(
      (paths, clock) => new RollbackFailingRepository(paths, { clock }),
    );
    const task = await service.startTask({
      title: "Memory recovery",
      goal: "Restore interrupted work",
    });

    await expect(
      service.checkpoint(task.id, "interrupt", {
        next: "write recovery test",
      }),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_ROLLBACK_FAILED",
      details: {
        primaryError: "working write failed",
        rollbackErrors: expect.arrayContaining([
          "checkpoint rollback failed: checkpoint rollback failed",
        ]),
      },
    });
  });
});
