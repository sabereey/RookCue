import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  DomainError,
  ProjectRepository,
  ProjectService,
  ReviewService,
  recommendReview,
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

async function readDirectorySafe(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  }
}

async function createFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "growth-memory-review-"));
  createdPaths.push(projectRoot);

  const paths = resolvePaths(projectRoot, join(projectRoot, ".personal-growth-memory"));
  const clock = () => new Date("2026-06-18T09:00:00.000Z");
  const repository = new ProjectRepository(paths, { clock });
  let idCounter = 0;
  const id = () => `id-${++idCounter}`;

  const projectService = new ProjectService(repository, { clock, id });
  const reviewService = new ReviewService(repository, projectService, { clock, id });
  const task = await projectService.startTask({
    title: "Deep review protocol",
    goal: "Preserve human reconstruction and recovery",
  });

  return { paths, repository, reviewService, projectService, task, clock, id };
}

async function createFixtureWithRepository(
  createRepository: (paths: ReturnType<typeof resolvePaths>, clock: () => Date) => ProjectRepository,
) {
  const projectRoot = await mkdtemp(join(tmpdir(), "growth-memory-review-"));
  createdPaths.push(projectRoot);

  const paths = resolvePaths(projectRoot, join(projectRoot, ".personal-growth-memory"));
  const clock = () => new Date("2026-06-18T09:00:00.000Z");
  const repository = createRepository(paths, clock);
  let idCounter = 0;
  const id = () => `id-${++idCounter}`;
  const projectService = new ProjectService(repository, { clock, id });
  const reviewService = new ReviewService(repository, projectService, { clock, id });

  return { paths, repository, projectService, reviewService, clock, id };
}

async function acceptSelectedLevel(reviewService: ReviewService, reviewId: string, level: "quick" | "deep") {
  await reviewService.addEntry(reviewId, {
    actor: "human",
    kind: "decision",
    content: `I accept the ${level} review level for this task.`,
    evidence: [],
  });
}

describe("review/review-service", () => {
  it("enforces the deep review path from reconstruction through transfer", async () => {
    const { reviewService, task } = await createFixture();
    const recommendation = recommendReview(["architecture-change", "ai-heavy"]);
    const review = await reviewService.start({
      taskId: task.id,
      level: "deep",
      recommendation,
      selectedBy: "human",
    });

    expect(review.phase).toBe("context");
    expect(review.recommendation).toEqual(recommendation);
    expect(review.selectedBy).toBe("human");
    await expect(reviewService.advance(review.id)).rejects.toMatchObject({
      code: "REVIEW_LEVEL_DECISION_REQUIRED",
    });

    await acceptSelectedLevel(reviewService, review.id, "deep");
    await expect(reviewService.advance(review.id)).resolves.toMatchObject({
      phase: "reconstruct",
      status: "active",
    });

    await expect(reviewService.advance(review.id)).rejects.toMatchObject({
      code: "RECONSTRUCTION_REQUIRED",
    });

    await reviewService.addEntry(review.id, {
      actor: "human",
      kind: "response",
      content: "Baseline plus checkpoint delta",
      evidence: [],
    });
    await expect(reviewService.advance(review.id)).resolves.toMatchObject({
      phase: "challenge",
    });

    await reviewService.addEntry(review.id, {
      actor: "ai",
      kind: "question",
      content: "What fails if the delta overwrites the baseline?",
      evidence: [],
    });
    await expect(reviewService.advance(review.id)).rejects.toMatchObject({
      code: "CHALLENGE_ANSWER_REQUIRED",
    });

    await reviewService.addEntry(review.id, {
      actor: "human",
      kind: "response",
      content: "Stable current knowledge must stay separate from unfinished working notes.",
      evidence: [],
    });
    await expect(reviewService.advance(review.id)).resolves.toMatchObject({
      phase: "correct",
    });

    await expect(
      reviewService.addEntry(review.id, {
        actor: "ai",
        kind: "correction",
        content: "Merge recovery deltas into working memory instead of current knowledge.",
        evidence: [],
      }),
    ).rejects.toMatchObject({ code: "CORRECTION_EVIDENCE_REQUIRED" });

    await reviewService.addEntry(review.id, {
      actor: "ai",
      kind: "correction",
      content: "Keep baseline facts in current.md and checkpoint deltas in working.md.",
      evidence: [{ kind: "commit", id: "commit-7" }],
    });
    await expect(reviewService.advance(review.id)).resolves.toMatchObject({
      phase: "transfer",
    });

    await expect(
      reviewService.addEntry(review.id, {
        actor: "ai",
        kind: "transfer-answer",
        content: "Always preserve the baseline.",
        evidence: [],
      }),
    ).rejects.toMatchObject({ code: "REVIEW_ENTRY_NOT_ALLOWED" });
    await expect(reviewService.advance(review.id)).rejects.toMatchObject({
      code: "TRANSFER_ANSWER_REQUIRED",
    });

    await reviewService.addEntry(review.id, {
      actor: "human",
      kind: "transfer-answer",
      content: "When recovery work is incomplete, keep trusted facts separate from active deltas.",
      evidence: [],
    });
    await expect(reviewService.advance(review.id)).resolves.toMatchObject({
      phase: "complete",
      status: "completed",
    });
  });

  it("requires a human to provide the initial reconstruction and selection", async () => {
    const { reviewService, task } = await createFixture();
    const recommendation = recommendReview(["failure-or-rework"]);
    const review = await reviewService.start({
      taskId: task.id,
      level: "deep",
      recommendation,
      selectedBy: "human",
    });

    await expect(reviewService.advance(review.id)).rejects.toMatchObject({
      code: "REVIEW_LEVEL_DECISION_REQUIRED",
    });

    await expect(
      reviewService.addEntry(review.id, {
        actor: "ai",
        kind: "response",
        content: "I reconstructed the baseline for you.",
        evidence: [],
      }),
    ).rejects.toMatchObject({ code: "HUMAN_RECONSTRUCTION_REQUIRED" });

    await expect(
      reviewService.start({
        taskId: task.id,
        level: "deep",
        recommendation,
        selectedBy: "ai",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("requires an AI question before the human challenge answer", async () => {
    const { reviewService, task } = await createFixture();
    const review = await reviewService.start({
      taskId: task.id,
      level: "deep",
      recommendation: recommendReview(["architecture-change"]),
      selectedBy: "human",
    });
    await acceptSelectedLevel(reviewService, review.id, "deep");
    await reviewService.advance(review.id);
    await reviewService.addEntry(review.id, {
      actor: "human",
      kind: "response",
      content: "I reconstructed the task.",
      evidence: [],
    });
    await reviewService.advance(review.id);

    await expect(
      reviewService.addEntry(review.id, {
        actor: "human",
        kind: "response",
        content: "This answer bypasses the AI question.",
        evidence: [],
      }),
    ).rejects.toMatchObject({ code: "CHALLENGE_QUESTION_REQUIRED" });
  });

  it("rejects a human correction during a deep review", async () => {
    const { reviewService, task } = await createFixture();
    const review = await reviewService.start({
      taskId: task.id,
      level: "deep",
      recommendation: recommendReview(["architecture-change"]),
      selectedBy: "human",
    });
    await acceptSelectedLevel(reviewService, review.id, "deep");
    await reviewService.advance(review.id);
    await reviewService.addEntry(review.id, {
      actor: "human",
      kind: "response",
      content: "I reconstructed the task.",
      evidence: [],
    });
    await reviewService.advance(review.id);
    await reviewService.addEntry(review.id, {
      actor: "ai",
      kind: "question",
      content: "What is the failure mode?",
      evidence: [],
    });
    await reviewService.addEntry(review.id, {
      actor: "human",
      kind: "response",
      content: "The evidence chain breaks.",
      evidence: [],
    });
    await reviewService.advance(review.id);

    await expect(
      reviewService.addEntry(review.id, {
        actor: "human",
        kind: "correction",
        content: "I bypassed the AI correction gate.",
        evidence: [{ kind: "commit", id: "commit-bypass" }],
      }),
    ).rejects.toMatchObject({ code: "REVIEW_ENTRY_NOT_ALLOWED" });
  });

  it("stores interruption checkpoints, records events, updates working memory, and resumes the exact active phase from context", async () => {
    const { repository, reviewService, task } = await createFixture();
    const review = await reviewService.start({
      taskId: task.id,
      level: "deep",
      recommendation: recommendReview(["transferable-learning", "ai-heavy"]),
      selectedBy: "human",
    });

    const interrupted = await reviewService.interrupt(review.id);
    const checkpoint = await repository.latestCheckpoint(task.id);

    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.phase).toBe("context");
    expect(checkpoint).toMatchObject({
      reason: "review",
      phase: "context",
      snapshot: {
        reviewId: review.id,
        phase: "context",
        entryIds: expect.any(Array),
      },
    });
    await expect(repository.readEvents()).resolves.toMatchObject([
      { type: "task-started" },
      { type: "checkpoint-recorded", taskId: task.id },
    ]);
    await expect(repository.readWorking()).resolves.toContain(
      `"reviewId": "${review.id}"`,
    );

    const resumed = await reviewService.resume(review.id);

    expect(resumed.status).toBe("active");
    expect(resumed.phase).toBe("context");
    expect(resumed.status).not.toBe("completed");
    await expect(repository.readReview(review.id)).resolves.toMatchObject({
      id: review.id,
      phase: "context",
      status: "active",
    });
  });

  it("uses the quick review path and avoids automatic personal knowledge candidates", async () => {
    const { paths, repository, reviewService, task } = await createFixture();
    const review = await reviewService.start({
      taskId: task.id,
      level: "quick",
      recommendation: recommendReview(["ai-heavy"]),
      selectedBy: "human",
    });

    expect(review.phase).toBe("context");

    await expect(reviewService.advance(review.id)).rejects.toMatchObject({
      code: "REVIEW_LEVEL_DECISION_REQUIRED",
    });

    await acceptSelectedLevel(reviewService, review.id, "quick");
    await expect(reviewService.advance(review.id)).resolves.toMatchObject({
      phase: "correct",
      status: "active",
    });

    await expect(reviewService.advance(review.id)).rejects.toMatchObject({
      code: "QUICK_REVIEW_CONFIRMATION_REQUIRED",
    });

    await reviewService.addEntry(review.id, {
      actor: "human",
      kind: "response",
      content: "The change is correct and the conclusion is ready to keep.",
      evidence: [],
    });
    await expect(reviewService.advance(review.id)).resolves.toMatchObject({
      phase: "complete",
      status: "completed",
    });

    await expect(repository.readReview(review.id)).resolves.toMatchObject({
      level: "quick",
      recommendation: recommendReview(["ai-heavy"]),
      selectedBy: "human",
    });
    await expect(readDirectorySafe(paths.personal.concepts)).resolves.toEqual([]);
  });

  it("restores the active review and compensates checkpoint side effects when interrupt checkpoint fails", async () => {
    class WorkingWriteFailingRepository extends ProjectRepository {
      private writeCount = 0;

      override async writeWorking(markdown: string): Promise<void> {
        this.writeCount += 1;
        if (this.writeCount === 2) {
          throw new Error("working write failed");
        }
        await super.writeWorking(markdown);
      }
    }

    const { repository, projectService, reviewService } = await createFixtureWithRepository(
      (paths, clock) => new WorkingWriteFailingRepository(paths, { clock }),
    );
    const task = await projectService.startTask({
      title: "Deep review protocol",
      goal: "Preserve human reconstruction and recovery",
    });
    const review = await reviewService.start({
      taskId: task.id,
      level: "deep",
      recommendation: recommendReview(["ai-heavy"]),
      selectedBy: "human",
    });

    await expect(reviewService.interrupt(review.id)).rejects.toMatchObject({
      code: "INTERRUPT_CHECKPOINT_FAILED",
    });
    await expect(repository.readReview(review.id)).resolves.toMatchObject({
      id: review.id,
      phase: "context",
      status: "active",
    });
    await expect(repository.latestCheckpoint(task.id)).resolves.toBeUndefined();
    await expect(repository.readWorking()).resolves.toContain("## Active Task");
    await expect(repository.readWorking()).resolves.not.toContain(`"reviewId": "${review.id}"`);
    await expect(repository.readEvents()).resolves.toMatchObject([
      { type: "task-started" },
      { type: "checkpoint-recorded" },
      { type: "checkpoint-rolled-back" },
    ]);
  });

  it("rejects skip reviews because they do not create sessions", async () => {
    const { reviewService, task } = await createFixture();

    await expect(
      reviewService.start({
        taskId: task.id,
        level: "skip",
        selectedBy: "human",
      }),
    ).rejects.toMatchObject({ code: "SKIP_REVIEW_NOT_ALLOWED" });
  });
});
