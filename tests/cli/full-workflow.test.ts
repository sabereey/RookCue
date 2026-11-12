import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import {
  capabilityStateSchema,
  checkpointSchema,
  conceptRecordSchema,
  projectEventSchema,
  reviewSessionSchema,
  taskRecordSchema,
} from "../../src/domain/schema.js";

type CliEnvelope<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        details: Record<string, unknown>;
      };
    };

type WorkflowRoots = {
  cleanup?: string;
  personalRoot: string;
  projectRoot: string;
  smokeRoot: string;
};

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

function parseEnvelope<T>(stdout: string): CliEnvelope<T> {
  const trimmed = stdout.trim();
  expect(trimmed).not.toHaveLength(0);
  const lines = trimmed.split(/\r?\n/);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "") as CliEnvelope<T>;
}

function expectOk<T>(stdout: string): T {
  const envelope = parseEnvelope<T>(stdout);
  expect(envelope.ok).toBe(true);
  if (!envelope.ok) {
    throw new Error(envelope.error.message);
  }
  return envelope.data;
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["dist/src/cli.js", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_UPDATE_NOTIFIER: "1",
    },
  });
}

async function resolveRoots(): Promise<WorkflowRoots> {
  const smokeRoot = process.env.SMOKE_ROOT;
  if (smokeRoot) {
    return {
      smokeRoot,
      projectRoot: join(smokeRoot, "project"),
      personalRoot: join(smokeRoot, "personal"),
    };
  }

  const cleanup = await mkdtemp(join(tmpdir(), "growth-memory-full-workflow-"));
  createdPaths.push(cleanup);
  return {
    cleanup,
    smokeRoot: cleanup,
    projectRoot: join(cleanup, "project"),
    personalRoot: join(cleanup, "personal"),
  };
}

async function assertFileExists(path: string): Promise<void> {
  const details = await stat(path);
  expect(details.isFile()).toBe(true);
}

async function readStructuredJson<T>(
  path: string,
  parse: (value: unknown) => T,
): Promise<T> {
  const raw = await readFile(path, "utf8");
  return parse(JSON.parse(raw) as unknown);
}

async function readStructuredJsonLines<T>(
  path: string,
  parse: (value: unknown) => T,
): Promise<T[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => parse(JSON.parse(line) as unknown));
}

describe("cli/full-workflow", () => {
  it("exercises the documented end-to-end workflow and materializes project and personal assets", async () => {
    const { projectRoot, personalRoot } = await resolveRoots();
    const projectBase = join(projectRoot, ".growth-memory");

    const init = runCli([
      "init",
      "--project",
      projectRoot,
      "--personal",
      personalRoot,
      "--json",
    ]);
    expect(init.status).toBe(0);
    const initData = expectOk<{ roots: { personal: string; project: string } }>(init.stdout);
    expect(initData.roots).toEqual({
      project: projectBase,
      personal: personalRoot,
    });

    const started = runCli([
      "task",
      "start",
      "--project",
      projectRoot,
      "--title",
      "Document agent workflow",
      "--goal",
      "Verify the complete system",
      "--json",
    ]);
    expect(started.status).toBe(0);
    const task = expectOk<{ id: string; status: string }>(started.stdout);
    expect(task.status).toBe("active");

    const evidenceEvent = runCli([
      "task",
      "event",
      "--project",
      projectRoot,
      "--task",
      task.id,
      "--type",
      "evidence-collected",
      "--summary",
      "Captured CLI output for the workflow transcript.",
      "--evidence",
      `task:${task.id}`,
      "--json",
    ]);
    expect(evidenceEvent.status).toBe(0);
    const event = expectOk<{ id: string; type: string }>(evidenceEvent.stdout);
    expect(event.type).toBe("evidence-collected");

    const checkpoint = runCli([
      "task",
      "checkpoint",
      "--project",
      projectRoot,
      "--task",
      task.id,
      "--reason",
      "interrupt",
      "--snapshot",
      JSON.stringify({
        blocker: "quota pause",
        nextStep: "resume review after the transcript is stable",
      }),
      "--json",
    ]);
    expect(checkpoint.status).toBe(0);
    const taskCheckpoint = expectOk<{ id: string; reason: string }>(checkpoint.stdout);
    expect(taskCheckpoint.reason).toBe("interrupt");

    const complete = runCli([
      "task",
      "complete",
      "--project",
      projectRoot,
      "--task",
      task.id,
      "--summary",
      "Completed the evidence-backed workflow draft and queued it for deep review.",
      "--json",
    ]);
    expect(complete.status).toBe(0);
    const completedTask = expectOk<{ completedAt: string; status: string }>(complete.stdout);
    expect(completedTask.status).toBe("completed");
    expect(completedTask.completedAt).toMatch(/T/);

    const recommendation = runCli([
      "review",
      "recommend",
      "--project",
      projectRoot,
      "--task",
      task.id,
      "--signal",
      "architecture-change",
      "transferable-learning",
      "ai-heavy",
      "--json",
    ]);
    expect(recommendation.status).toBe(0);
    const recommended = expectOk<{
      level: string;
      score: number;
      signals: string[];
    }>(recommendation.stdout);
    expect(recommended).toMatchObject({
      level: "deep",
      score: 6,
      signals: ["architecture-change", "transferable-learning", "ai-heavy"],
    });

    const reviewStart = runCli([
      "review",
      "start",
      "--project",
      projectRoot,
      "--task",
      task.id,
      "--level",
      "deep",
      "--json",
    ]);
    expect(reviewStart.status).toBe(0);
    const review = expectOk<{ id: string; phase: string; status: string }>(reviewStart.stdout);
    expect(review.phase).toBe("context");
    expect(review.status).toBe("active");

    const contextEntry = runCli([
      "review",
      "respond",
      "--project",
      projectRoot,
      "--review",
      review.id,
      "--phase",
      "context",
      "--text",
      "I accept the deep review level for this task.",
      "--json",
    ]);
    expect(contextEntry.status).toBe(0);
    const contextData = expectOk<{ review: { phase: string } }>(contextEntry.stdout);
    expect(contextData.review.phase).toBe("context");

    const toReconstruct = runCli([
      "review",
      "advance",
      "--project",
      projectRoot,
      "--review",
      review.id,
      "--json",
    ]);
    expect(toReconstruct.status).toBe(0);
    const reconstructReview = expectOk<{ phase: string }>(toReconstruct.stdout);
    expect(reconstructReview.phase).toBe("reconstruct");

    const reconstructEntry = runCli([
      "review",
      "respond",
      "--project",
      projectRoot,
      "--review",
      review.id,
      "--phase",
      "reconstruct",
      "--text",
      "The reliable path is init, task evidence, checkpoint, complete, then deep review.",
      "--evidence",
      `task:${task.id}`,
      `event:${event.id}`,
      "--json",
    ]);
    expect(reconstructEntry.status).toBe(0);
    const reconstructData = expectOk<{ review: { phase: string } }>(reconstructEntry.stdout);
    expect(reconstructData.review.phase).toBe("reconstruct");

    const toChallenge = runCli([
      "review",
      "advance",
      "--project",
      projectRoot,
      "--review",
      review.id,
      "--json",
    ]);
    expect(toChallenge.status).toBe(0);
    const challengeReview = expectOk<{ phase: string }>(toChallenge.stdout);
    expect(challengeReview.phase).toBe("challenge");

    const question = runCli([
      "review",
      "question",
      "--project",
      projectRoot,
      "--review",
      review.id,
      "--template",
      "five-whys",
      "--text",
      "Why did the candidate proposal originally return no candidates?",
      "--json",
    ]);
    expect(question.status).toBe(0);
    const templatedChallenge = expectOk<{ content: string; kind: string }>(question.stdout);
    expect(templatedChallenge).toMatchObject({ kind: "question" });
    expect(templatedChallenge.content).toContain("5 Whys challenge");
    expect(templatedChallenge.content).toContain(
      "Why did the candidate proposal originally return no candidates?",
    );

    const challengeAnswer = runCli([
      "review",
      "respond",
      "--project",
      projectRoot,
      "--review",
      review.id,
      "--phase",
      "challenge",
      "--text",
      "The review loses traceability and future transfer stops being trustworthy.",
      "--evidence",
      `review:${review.id}`,
      "--json",
    ]);
    expect(challengeAnswer.status).toBe(0);
    const challengeData = expectOk<{ review: { phase: string } }>(challengeAnswer.stdout);
    expect(challengeData.review.phase).toBe("challenge");

    const interrupted = runCli([
      "review",
      "interrupt",
      "--project",
      projectRoot,
      "--review",
      review.id,
      "--json",
    ]);
    expect(interrupted.status).toBe(0);
    const interruptedReview = expectOk<{
      entries: Array<{ id: string }>;
      phase: string;
      status: string;
    }>(interrupted.stdout);
    expect(interruptedReview).toMatchObject({
      phase: "challenge",
      status: "interrupted",
    });

    const resumed = runCli([
      "review",
      "resume",
      "--project",
      projectRoot,
      "--review",
      review.id,
      "--json",
    ]);
    expect(resumed.status).toBe(0);
    const resumedReview = expectOk<{ phase: string; status: string }>(resumed.stdout);
    expect(resumedReview).toMatchObject({
      phase: "challenge",
      status: "active",
    });

    const toCorrect = runCli([
      "review",
      "advance",
      "--project",
      projectRoot,
      "--review",
      review.id,
      "--json",
    ]);
    expect(toCorrect.status).toBe(0);
    const correctedPhase = expectOk<{ phase: string }>(toCorrect.stdout);
    expect(correctedPhase.phase).toBe("correct");

    const correction = runCli([
      "review",
      "correct",
      "--project",
      projectRoot,
      "--review",
      review.id,
      "--text",
      "Record the promoted lesson only after the evidence chain is explicit.",
      "--evidence",
      "commit:docs-task-8",
      "--json",
    ]);
    expect(correction.status).toBe(0);
    const correctionEntry = expectOk<{ kind: string }>(correction.stdout);
    expect(correctionEntry.kind).toBe("correction");

    const toTransfer = runCli([
      "review",
      "advance",
      "--project",
      projectRoot,
      "--review",
      review.id,
      "--json",
    ]);
    expect(toTransfer.status).toBe(0);
    const transferPhase = expectOk<{ phase: string }>(toTransfer.stdout);
    expect(transferPhase.phase).toBe("transfer");

    const transfer = runCli([
      "review",
      "transfer",
      "--project",
      projectRoot,
      "--review",
      review.id,
      "--template",
      "feynman",
      "--text",
      "In another repo, I would demand evidence before promoting any reusable guidance.",
      "--evidence",
      "test:transfer-exercise",
      "--json",
    ]);
    expect(transfer.status).toBe(0);
    const transferEntry = expectOk<{ content: string; kind: string }>(transfer.stdout);
    expect(transferEntry.kind).toBe("transfer-answer");
    expect(transferEntry.content).toContain("Feynman transfer");
    expect(transferEntry.content).toContain(
      "Principle: In another repo, I would demand evidence before promoting any reusable guidance.",
    );

    const reviewComplete = runCli([
      "review",
      "advance",
      "--project",
      projectRoot,
      "--review",
      review.id,
      "--json",
    ]);
    expect(reviewComplete.status).toBe(0);
    const completedReview = expectOk<{ entries: Array<{ id: string }>; phase: string; status: string }>(
      reviewComplete.stdout,
    );
    expect(completedReview).toMatchObject({
      phase: "complete",
      status: "completed",
    });

    const evolution = runCli([
      "evolution",
      "add",
      "--project",
      projectRoot,
      "--title",
      "Promote only evidence-backed lessons",
      "--before",
      "Review notes were disconnected from durable knowledge.",
      "--after",
      "The workflow now records evolution only with linked evidence.",
      "--reason",
      "Deep review exposed the traceability gap.",
      "--impact",
      "Future agents can reuse the lesson with proof attached.",
      "--evidence",
      `task:${task.id}`,
      `event:${event.id}`,
      `checkpoint:${taskCheckpoint.id}`,
      "--json",
    ]);
    expect(evolution.status).toBe(0);
    const evolutionData = expectOk<{ path: string }>(evolution.stdout);
    expect(evolutionData.path).toContain(`${projectBase}/evolution/`);

    const propose = runCli([
      "knowledge",
      "propose",
      "--project",
      projectRoot,
      "--personal",
      personalRoot,
      "--review",
      review.id,
      "--candidate",
      JSON.stringify({
        principle: "Reject weak candidates before they become personal doctrine.",
        boundary: "Use rejection when a draft lacks enough project evidence.",
        evidence: [{ kind: "task", id: task.id }],
      }),
      JSON.stringify({
        principle: "Promote lessons only when project evidence remains attached.",
        boundary: "Applies after a completed deep review with task and event links.",
        evidence: [
          { kind: "task", id: task.id },
          { kind: "event", id: event.id },
          { kind: "checkpoint", id: taskCheckpoint.id },
        ],
      }),
      "--json",
    ]);
    expect(propose.status).toBe(0);
    const candidates = expectOk<
      Array<{ id: string; ordinal: number; status: string }>
    >(propose.stdout);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.ordinal)).toEqual([1, 2]);

    const rejected = runCli([
      "knowledge",
      "decide",
      "--project",
      projectRoot,
      "--personal",
      personalRoot,
      "--candidate",
      candidates[0]?.id ?? "",
      "--decision",
      "reject",
      "--actor",
      "human",
      "--source",
      "full workflow rejection",
      "--json",
    ]);
    expect(rejected.status).toBe(0);
    const rejectedDecision = expectOk<{
      candidate: { status: string };
      receipt: { actor: string; decision: string; source: string };
    }>(rejected.stdout);
    expect(rejectedDecision).toMatchObject({
      candidate: { status: "rejected" },
      receipt: {
        actor: "human",
        decision: "reject",
        source: "full workflow rejection",
      },
    });

    const blockedPromotion = runCli([
      "knowledge",
      "promote",
      "--project",
      projectRoot,
      "--personal",
      personalRoot,
      "--candidate",
      candidates[1]?.id ?? "",
      "--confidence",
      "0.82",
      "--json",
    ]);
    expect(blockedPromotion.status).toBe(2);
    const blockedEnvelope = parseEnvelope<never>(blockedPromotion.stdout);
    expect(blockedEnvelope).toMatchObject({
      ok: false,
      error: {
        code: "HUMAN_APPROVAL_REQUIRED",
      },
    });

    const approved = runCli([
      "knowledge",
      "decide",
      "--project",
      projectRoot,
      "--personal",
      personalRoot,
      "--candidate",
      candidates[1]?.id ?? "",
      "--decision",
      "approve",
      "--actor",
      "human",
      "--source",
      "full workflow approval",
      "--json",
    ]);
    expect(approved.status).toBe(0);
    const approvedDecision = expectOk<{
      candidate: { status: string };
      receipt: { actor: string; candidateDigest: string; decision: string; source: string };
    }>(approved.stdout);
    expect(approvedDecision).toMatchObject({
      candidate: { status: "approved" },
      receipt: {
        actor: "human",
        candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        decision: "approve",
        source: "full workflow approval",
      },
    });

    const promoted = runCli([
      "knowledge",
      "promote",
      "--project",
      projectRoot,
      "--personal",
      personalRoot,
      "--candidate",
      candidates[1]?.id ?? "",
      "--confidence",
      "0.82",
      "--json",
    ]);
    expect(promoted.status).toBe(0);
    const concept = expectOk<{ id: string; status: string }>(promoted.stdout);
    expect(concept.status).toBe("approved");

    const capability = runCli([
      "capability",
      "update",
      "--project",
      projectRoot,
      "--personal",
      personalRoot,
      "--concept",
      concept.id,
      "--level",
      "explainable",
      "--evidence",
      JSON.stringify({
        kind: "transfer",
        reviewId: review.id,
        passed: true,
      }),
      "--json",
    ]);
    expect(capability.status).toBe(0);
    const capabilityRecord = expectOk<{ conceptId: string; level: string }>(capability.stdout);
    expect(capabilityRecord).toMatchObject({
      conceptId: concept.id,
      level: "explainable",
    });

    await assertFileExists(join(projectBase, "current.md"));
    await assertFileExists(join(projectBase, "working.md"));
    await assertFileExists(join(personalRoot, "index.md"));
    await assertFileExists(join(personalRoot, "practice", `${review.id}.md`));
    await assertFileExists(join(personalRoot, "concepts", `${concept.id}.md`));

    const evolutionFiles = await readdir(join(projectBase, "evolution"));
    expect(evolutionFiles).toHaveLength(1);
    expect(evolutionFiles[0]).toContain("promote-only-evidence-backed-lessons");
    await assertFileExists(join(projectBase, "evolution", evolutionFiles[0] ?? ""));

    const taskRecord = await readStructuredJson(
      join(projectBase, "tasks", `${task.id}.json`),
      (value) => taskRecordSchema.parse(value),
    );
    expect(taskRecord).toMatchObject({
      id: task.id,
      status: "completed",
      title: "Document agent workflow",
      goal: "Verify the complete system",
    });

    const reviewState = await readStructuredJson(
      join(projectBase, "reviews", `${review.id}.json`),
      (value) => reviewSessionSchema.parse(value),
    );
    expect(reviewState.id).toBe(review.id);
    expect(reviewState.phase).toBe("complete");
    expect(reviewState.status).toBe("completed");

    const checkpointFiles = await readdir(join(projectBase, "checkpoints"));
    const checkpoints = await Promise.all(
      checkpointFiles.map(async (fileName) =>
        readStructuredJson(join(projectBase, "checkpoints", fileName), (value) =>
          checkpointSchema.parse(value),
        ),
      ),
    );
    expect(checkpoints).toHaveLength(2);
    const interruptCheckpoint = checkpoints.find(
      (entry) => entry.id === taskCheckpoint.id,
    );
    expect(interruptCheckpoint).toMatchObject({
      id: taskCheckpoint.id,
      taskId: task.id,
      reason: "interrupt",
    });
    const reviewCheckpoint = checkpoints.find(
      (entry) =>
        entry.taskId === task.id &&
        entry.reason === "review" &&
        entry.phase === "challenge" &&
        entry.snapshot.reviewId === review.id,
    );
    expect(reviewCheckpoint).toBeDefined();
    expect(reviewCheckpoint?.snapshot.entryIds).toEqual(
      interruptedReview.entries.map((entry) => entry.id),
    );

    const events = await readStructuredJsonLines(
      join(projectBase, "events", "events.jsonl"),
      (value) => projectEventSchema.parse(value),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task-started",
          taskId: task.id,
          evidence: expect.arrayContaining([{ kind: "task", id: task.id }]),
        }),
        expect.objectContaining({
          id: event.id,
          type: "evidence-collected",
          taskId: task.id,
        }),
        expect.objectContaining({
          type: "checkpoint-recorded",
          taskId: task.id,
          evidence: expect.arrayContaining([{ kind: "checkpoint", id: taskCheckpoint.id }]),
        }),
        expect.objectContaining({
          type: "checkpoint-recorded",
          taskId: task.id,
          evidence: expect.arrayContaining([
            { kind: "checkpoint", id: reviewCheckpoint?.id ?? "" },
          ]),
        }),
        expect.objectContaining({
          type: "task-completed",
          taskId: task.id,
          summary:
            "Completed the evidence-backed workflow draft and queued it for deep review.",
        }),
        expect.objectContaining({
          type: "evolution-recorded",
          summary: "Promote only evidence-backed lessons",
          evidence: expect.arrayContaining([
            { kind: "task", id: task.id },
            { kind: "event", id: event.id },
            { kind: "checkpoint", id: taskCheckpoint.id },
          ]),
        }),
      ]),
    );
    expect(events.filter((record) => record.type === "checkpoint-recorded")).toHaveLength(2);

    const conceptMarkdown = await readFile(
      join(personalRoot, "concepts", `${concept.id}.md`),
      "utf8",
    );
    expect(conceptMarkdown).toContain("Promote lessons only when project evidence remains attached.");

    const conceptRecord = await readStructuredJson(
      join(personalRoot, "concepts", `${concept.id}.json`),
      (value) => conceptRecordSchema.parse(value),
    );
    expect(conceptRecord).toMatchObject({
      id: concept.id,
      reviewId: review.id,
      taskId: task.id,
      status: "approved",
      confidence: 0.82,
      principle: "Promote lessons only when project evidence remains attached.",
      boundary: "Applies after a completed deep review with task and event links.",
      evidence: [
        { kind: "task", id: task.id },
        { kind: "event", id: event.id },
        { kind: "checkpoint", id: taskCheckpoint.id },
      ],
    });

    const capabilityState = await readStructuredJson(
      join(personalRoot, "capabilities.json"),
      (value) => capabilityStateSchema.parse(value),
    );
    expect(capabilityState.records).toEqual([
      {
        conceptId: concept.id,
        level: "explainable",
        evidence: [{ kind: "transfer", reviewId: review.id, passed: true }],
        updatedAt: expect.any(String),
      },
    ]);
  }, 60_000);
});
