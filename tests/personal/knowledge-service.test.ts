import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  DomainError,
  ProjectRepository,
  ProjectService,
  ReviewService,
  resolvePaths,
} from "../../src/index.js";
import { PersonalRepository } from "../../src/storage/personal-repository.js";
import {
  KnowledgeService,
  type CapabilityEvidence,
} from "../../src/personal/knowledge-service.js";

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

async function createFixture(
  createPersonalRepository?: (
    paths: ReturnType<typeof resolvePaths>,
    clock: () => Date,
  ) => PersonalRepository,
) {
  const projectRoot = await mkdtemp(join(tmpdir(), "growth-memory-knowledge-"));
  createdPaths.push(projectRoot);

  const paths = resolvePaths(projectRoot, join(projectRoot, ".personal-growth-memory"));
  const clock = () => new Date("2026-06-19T10:00:00.000Z");
  let idCounter = 0;
  const id = () => `id-${++idCounter}`;
  const projectRepository = new ProjectRepository(paths, { clock });
  const personalRepository = createPersonalRepository
    ? createPersonalRepository(paths, clock)
    : new PersonalRepository(paths, { clock });
  const projectService = new ProjectService(projectRepository, { clock, id });
  const reviewService = new ReviewService(projectRepository, projectService, {
    clock,
    id,
  });
  const knowledgeService = new KnowledgeService(
    personalRepository,
    projectRepository,
    { clock, id },
  );

  return {
    paths,
    projectService,
    reviewService,
    personalRepository,
    knowledgeService,
  };
}

async function createCompletedReview(
  createPersonalRepository?: Parameters<typeof createFixture>[0],
  options: {
    transferAnswerContent?: string;
  } = {},
) {
  const fixture = await createFixture(createPersonalRepository);
  const { projectService, reviewService } = fixture;
  const task = await projectService.startTask({
    title: "Promote transferable knowledge",
    goal: "Verify review-backed learning survives promotion",
  });
  const review = await reviewService.start({
    taskId: task.id,
    level: "deep",
    selectedBy: "human",
    recommendation: {
      level: "deep",
      score: 4,
      reasons: ["Transferable learning candidate detected"],
      signals: ["transferable-learning"],
    },
  });

  await reviewService.addEntry(review.id, {
    actor: "human",
    kind: "decision",
    content: "Proceed with deep review.",
    evidence: [],
  });
  await reviewService.advance(review.id);
  await reviewService.addEntry(review.id, {
    actor: "human",
    kind: "response",
    content: "The stable rule is hidden inside one task flow today.",
    evidence: [{ kind: "task", id: task.id }],
  });
  await reviewService.advance(review.id);
  await reviewService.addEntry(review.id, {
    actor: "ai",
    kind: "question",
    content: "What breaks when we skip the evidence trail?",
    evidence: [],
  });
  await reviewService.addEntry(review.id, {
    actor: "human",
    kind: "response",
    content: "We lose the proof needed to trust the generalization.",
    evidence: [{ kind: "review", id: review.id }],
  });
  await reviewService.advance(review.id);
  await reviewService.addEntry(review.id, {
    actor: "ai",
    kind: "correction",
    content: "Promotions should keep the linked proof, not just the summary.",
    evidence: [{ kind: "commit", id: "commit-7" }],
  });
  await reviewService.advance(review.id);
  await reviewService.addEntry(review.id, {
    actor: "human",
    kind: "transfer-answer",
    content:
      options.transferAnswerContent ??
      "In a new task, carry the principle, boundary, and source evidence together.",
    evidence: [{ kind: "test", id: "test-knowledge-transfer" }],
  });

  const completedReview = await reviewService.advance(review.id);

  return {
    ...fixture,
    review: completedReview,
    task,
  };
}

describe("personal/knowledge-service", () => {
  it("enforces the zero-to-three candidate gate", async () => {
    const { knowledgeService, review, task } = await createCompletedReview();

    await expect(
      knowledgeService.propose(review, [
        {
          principle: "One",
          boundary: "A",
          evidence: [{ kind: "review", id: review.id }],
        },
        {
          principle: "Two",
          boundary: "B",
          evidence: [{ kind: "review", id: review.id }],
        },
        {
          principle: "Three",
          boundary: "C",
          evidence: [{ kind: "review", id: review.id }],
        },
        {
          principle: "Four",
          boundary: "D",
          evidence: [{ kind: "review", id: review.id }],
        },
      ]),
    ).rejects.toMatchObject({ code: "TOO_MANY_CANDIDATES" });

    await expect(knowledgeService.propose(review, [])).resolves.toMatchObject([
      {
        ordinal: 1,
        principle:
          "In a new task, carry the principle, boundary, and source evidence together.",
        boundary:
          "Use this when a completed deep review includes a human transfer answer and concrete project evidence.",
        evidence: [{ kind: "task", id: task.id }],
        status: "candidate",
      },
    ]);
  });

  it("requires evidence-backed candidates with a principle and boundary", async () => {
    const { knowledgeService, review } = await createCompletedReview();

    await expect(
      knowledgeService.propose(review, [
        {
          principle: "",
          boundary: "Only when the rule survived review",
          evidence: [{ kind: "review", id: review.id }],
        },
      ]),
    ).rejects.toBeInstanceOf(DomainError);

    await expect(
      knowledgeService.propose(review, [
        {
          principle: "Promotion must keep proof attached.",
          boundary: "",
          evidence: [{ kind: "review", id: review.id }],
        },
      ]),
    ).rejects.toBeInstanceOf(DomainError);

    await expect(
      knowledgeService.propose(review, [
        {
          principle: "Promotion must keep proof attached.",
          boundary: "Only when a concrete review generated the rule",
          evidence: [],
        },
      ]),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("rejects review-only candidate evidence", async () => {
    const { knowledgeService, review } = await createCompletedReview();

    await expect(
      knowledgeService.propose(review, [
        {
          principle: "Review summaries alone are not enough.",
          boundary: "Promotion needs concrete project proof",
          evidence: [{ kind: "review", id: review.id }],
        },
      ]),
    ).rejects.toMatchObject({ code: "PROJECT_EVIDENCE_REQUIRED" });
  });

  it("accepts mixed review and project evidence", async () => {
    const { knowledgeService, review } = await createCompletedReview();

    await expect(
      knowledgeService.propose(review, [
        {
          principle: "Keep review framing alongside concrete proof.",
          boundary: "Useful when the review explains why the project evidence matters",
          evidence: [
            { kind: "review", id: review.id },
            { kind: "commit", id: "commit-mixed-evidence" },
          ],
        },
      ]),
    ).resolves.toMatchObject([
      {
        status: "candidate",
        evidence: [
          { kind: "review", id: review.id },
          { kind: "commit", id: "commit-mixed-evidence" },
        ],
      },
    ]);
  });

  it("extracts the principle line from a templated transfer answer", async () => {
    const { knowledgeService, review, task } = await createCompletedReview();
    const templatedReview = {
      ...review,
      entries: review.entries.map((entry) =>
        entry.kind === "transfer-answer"
          ? {
              ...entry,
              content: [
                "Feynman transfer",
                "",
                "Principle: Keep the reusable rule separate from the template wrapper.",
                "",
                "Simple explanation: The wrapper guides review, but the principle becomes knowledge.",
              ].join("\n"),
            }
          : entry,
      ),
    };

    await expect(knowledgeService.propose(templatedReview, [])).resolves.toMatchObject([
      {
        principle: "Keep the reusable rule separate from the template wrapper.",
        evidence: [{ kind: "task", id: task.id }],
      },
    ]);
  });

  it("splits numbered transfer answers into up to three automatic candidates", async () => {
    const { knowledgeService, review, task } = await createCompletedReview(undefined, {
      transferAnswerContent: [
        "全部沉淀：1. BYO 云服务不等于无隐私责任。",
        "2. Remote 抽象层要显式声明 capabilities。",
        "3. 同步冲突判断应基于 base、local、remote 三方差异。",
        "4. 同步产品目标是恢复可继续使用状态。",
      ].join(" "),
    });

    await expect(knowledgeService.propose(review, [])).resolves.toMatchObject([
      {
        ordinal: 1,
        principle: "BYO 云服务不等于无隐私责任。",
        evidence: [{ kind: "task", id: task.id }],
      },
      {
        ordinal: 2,
        principle: "Remote 抽象层要显式声明 capabilities。",
        evidence: [{ kind: "task", id: task.id }],
      },
      {
        ordinal: 3,
        principle: "同步冲突判断应基于 base、local、remote 三方差异。",
        evidence: [{ kind: "task", id: task.id }],
      },
    ]);
  });

  it("requires a human decision before promotion and writes promoted knowledge", async () => {
    const { knowledgeService, personalRepository, review } = await createCompletedReview();
    const [candidate] = await knowledgeService.propose(review, [
      {
        principle: "Promotions must preserve source evidence.",
        boundary: "Only for rules validated by a completed review",
        evidence: [{ kind: "commit", id: "commit-human-gated" }],
      },
    ]);
    const ensuredCandidate = requireCandidate(candidate);

    await expect(
      knowledgeService.promote(ensuredCandidate.id, { confidence: 0.8 }),
    ).rejects.toMatchObject({ code: "HUMAN_APPROVAL_REQUIRED" });

    await expect(
      knowledgeService.decide(ensuredCandidate.id, {
        actor: "ai",
        decision: "approve",
        source: "fabricated AI approval",
      }),
    ).rejects.toMatchObject({ code: "HUMAN_DECISION_REQUIRED" });

    await expect(
      knowledgeService.decide(
        ensuredCandidate.id,
        { actor: "human", decision: "approve" } as never,
      ),
    ).rejects.toMatchObject({ code: "DECISION_SOURCE_REQUIRED" });

    await knowledgeService.decide(ensuredCandidate.id, {
      actor: "human",
      decision: "approve",
      source: "unit-test explicit approval",
    });
    await expect(
      personalRepository.readDecisionReceipts(ensuredCandidate.id),
    ).resolves.toMatchObject([
      {
        actor: "human",
        candidateId: ensuredCandidate.id,
        candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        decision: "approve",
        source: "unit-test explicit approval",
      },
    ]);
    await expect(
      knowledgeService.promote(ensuredCandidate.id, { confidence: 0.8 }),
    ).resolves.toMatchObject({
      id: ensuredCandidate.id,
      status: "approved",
      confidence: 0.8,
      timestamps: {
        candidateCreatedAt: "2026-06-19T10:00:00.000Z",
        approvedAt: "2026-06-19T10:00:00.000Z",
        promotedAt: "2026-06-19T10:00:00.000Z",
      },
      provenance: {
        candidateId: ensuredCandidate.id,
        reviewId: review.id,
        taskId: review.taskId,
        sourceProject: expect.stringContaining("growth-memory-knowledge-"),
        sourceSummary: expect.stringContaining("Promote transferable knowledge"),
        decisionReceiptId: expect.stringMatching(/^id-/),
        evidenceRefs: [
          { kind: "task", id: review.taskId },
          { kind: "review", id: review.id },
          { kind: "commit", id: "commit-human-gated" },
        ],
      },
    });

    await expect(personalRepository.readConcept(ensuredCandidate.id)).resolves.toMatchObject({
      id: ensuredCandidate.id,
      status: "approved",
      confidence: 0.8,
      timestamps: {
        promotedAt: "2026-06-19T10:00:00.000Z",
      },
      provenance: {
        candidateId: ensuredCandidate.id,
        reviewId: review.id,
      },
      history: [],
    });
  });

  it("rejects promotion when candidate content no longer matches its approval digest", async () => {
    const { knowledgeService, personalRepository, review } = await createCompletedReview();
    const [candidate] = await knowledgeService.propose(review, [
      {
        principle: "Approval binds exact candidate content.",
        boundary: "Only the reviewed content may be promoted",
        evidence: [{ kind: "task", id: review.taskId }],
      },
    ]);
    const ensuredCandidate = requireCandidate(candidate);
    await knowledgeService.decide(ensuredCandidate.id, {
      actor: "human",
      decision: "approve",
      source: "unit-test explicit approval",
    });

    const state = await personalRepository.readReviewState(review.id);
    await personalRepository.saveReviewState({
      ...state,
      candidates: state.candidates.map((item) =>
        item.id === ensuredCandidate.id
          ? { ...item, principle: "Tampered after approval" }
          : item,
      ),
    });

    await expect(
      knowledgeService.promote(ensuredCandidate.id, { confidence: 0.8 }),
    ).rejects.toMatchObject({ code: "APPROVAL_RECEIPT_MISMATCH" });
  });

  it("requires passed behavioral evidence to reach explainable", async () => {
    const { knowledgeService, review } = await createCompletedReview();
    const concept = await promoteCandidate(knowledgeService, review);

    await expect(
      knowledgeService.updateCapability(concept.id, {
        level: "explainable",
        evidence: [{ kind: "explanation", reviewId: review.id, passed: false }],
      }),
    ).rejects.toMatchObject({ code: "EXPLAINABLE_EVIDENCE_REQUIRED" });

    await expect(
      knowledgeService.updateCapability(concept.id, {
        level: "explainable",
        evidence: [{ kind: "transfer", reviewId: review.id, passed: true }],
      }),
    ).resolves.toMatchObject({ level: "explainable" });
  });

  it("requires an independent task before reaching independent capability", async () => {
    const { knowledgeService, review, task } = await createCompletedReview();
    const concept = await promoteCandidate(knowledgeService, review);
    const sameTaskEvidence: CapabilityEvidence[] = [
      {
        kind: "independent-task",
        taskId: task.id,
        originatingTaskId: task.id,
      },
    ];

    await expect(
      knowledgeService.updateCapability(concept.id, {
        level: "independent",
        evidence: sameTaskEvidence,
      }),
    ).rejects.toMatchObject({ code: "INDEPENDENT_TASK_REQUIRED" });

    await expect(
      knowledgeService.updateCapability(concept.id, {
        level: "independent",
        evidence: [
          {
            kind: "independent-task",
            taskId: "task-other",
            originatingTaskId: task.id,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
  });

  it("preserves revision history when confidence changes or knowledge becomes obsolete", async () => {
    const { knowledgeService, personalRepository, review } = await createCompletedReview();
    const concept = await promoteCandidate(knowledgeService, review);

    await knowledgeService.reviseEntry(concept.id, {
      confidence: 0.35,
      summary: "A counterexample reduced confidence in the generalization.",
      evidence: [{ kind: "commit", id: "commit-counterexample" }],
    });
    await knowledgeService.reviseEntry(concept.id, {
      status: "obsolete",
      summary: "A later task proved the rule no longer holds.",
      evidence: [{ kind: "commit", id: "commit-counterexample-2" }],
    });

    await expect(personalRepository.readConcept(concept.id)).resolves.toMatchObject({
      id: concept.id,
      status: "obsolete",
      confidence: 0.35,
      timestamps: {
        candidateCreatedAt: "2026-06-19T10:00:00.000Z",
        approvedAt: "2026-06-19T10:00:00.000Z",
        promotedAt: "2026-06-19T10:00:00.000Z",
        updatedAt: "2026-06-19T10:00:00.000Z",
        supersededAt: "2026-06-19T10:00:00.000Z",
      },
      history: [
        expect.objectContaining({
          status: "approved",
          confidence: 0.8,
        }),
        expect.objectContaining({
          status: "approved",
          confidence: 0.35,
        }),
      ],
    });
  });

  it("does not overwrite an already promoted concept", async () => {
    const { knowledgeService, personalRepository, review } = await createCompletedReview();
    const concept = await promoteCandidate(knowledgeService, review);

    await knowledgeService.reviseEntry(concept.id, {
      confidence: 0.6,
      summary: "A narrower example reduced confidence.",
      evidence: [{ kind: "commit", id: "commit-revision-1" }],
    });

    await expect(
      knowledgeService.promote(concept.id, { confidence: 0.95 }),
    ).rejects.toMatchObject({ code: "CONCEPT_ALREADY_PROMOTED" });

    await expect(personalRepository.readConcept(concept.id)).resolves.toMatchObject({
      id: concept.id,
      confidence: 0.6,
      history: [expect.objectContaining({ confidence: 0.8 })],
    });
  });

  it("reconciles promotion after JSON committed but save reported failure", async () => {
    class JsonCommitThenFailRepository extends PersonalRepository {
      private failed = false;

      override async saveConcept(concept: Parameters<PersonalRepository["saveConcept"]>[0]) {
        await super.saveConcept(concept);
        if (!this.failed) {
          this.failed = true;
          throw new Error("concept JSON reported failure after commit");
        }
      }
    }

    const fixture = await createCompletedReview(
      (paths, clock) => new JsonCommitThenFailRepository(paths, { clock }),
    );
    const { knowledgeService, review, paths } = fixture;
    const candidate = await proposeAndApprove(knowledgeService, review);

    await expect(
      knowledgeService.promote(candidate.id, { confidence: 0.8 }),
    ).rejects.toThrow("concept JSON reported failure after commit");
    await expect(
      knowledgeService.promote(candidate.id, { confidence: 0.8 }),
    ).resolves.toMatchObject({ id: candidate.id, history: [] });
    await expect(
      readFile(join(paths.personal.concepts, `${candidate.id}.md`), "utf8"),
    ).resolves.toContain("Promotions must preserve source evidence.");
  });

  it("reconciles promotion after the Markdown write fails", async () => {
    class MarkdownFailingRepository extends PersonalRepository {
      private failed = false;

      override async writeConceptMarkdown(conceptId: string, markdown: string) {
        if (!this.failed) {
          this.failed = true;
          throw new Error("concept Markdown write failed");
        }
        await super.writeConceptMarkdown(conceptId, markdown);
      }
    }

    const fixture = await createCompletedReview(
      (paths, clock) => new MarkdownFailingRepository(paths, { clock }),
    );
    const { knowledgeService, review, paths } = fixture;
    const candidate = await proposeAndApprove(knowledgeService, review);

    await expect(
      knowledgeService.promote(candidate.id, { confidence: 0.8 }),
    ).rejects.toThrow("concept Markdown write failed");
    await expect(
      knowledgeService.promote(candidate.id, { confidence: 0.8 }),
    ).resolves.toMatchObject({ id: candidate.id, history: [] });
    await expect(
      readFile(join(paths.personal.concepts, `${candidate.id}.md`), "utf8"),
    ).resolves.toContain("Promotions must preserve source evidence.");
  });

  it("does not duplicate revision history after a partial JSON revision write", async () => {
    class RevisionJsonCommitThenFailRepository extends PersonalRepository {
      private saveCount = 0;

      override async saveConcept(concept: Parameters<PersonalRepository["saveConcept"]>[0]) {
        this.saveCount += 1;
        await super.saveConcept(concept);
        if (this.saveCount === 2) {
          throw new Error("revision JSON reported failure after commit");
        }
      }
    }

    const fixture = await createCompletedReview(
      (paths, clock) => new RevisionJsonCommitThenFailRepository(paths, { clock }),
    );
    const { knowledgeService, personalRepository, review } = fixture;
    const concept = await promoteCandidate(knowledgeService, review);
    const revision = {
      confidence: 0.4,
      summary: "One deterministic revision",
      evidence: [{ kind: "commit" as const, id: "commit-revision-retry" }],
    };

    await expect(knowledgeService.reviseEntry(concept.id, revision)).rejects.toThrow(
      "revision JSON reported failure after commit",
    );
    await expect(knowledgeService.reviseEntry(concept.id, revision)).resolves.toMatchObject({
      confidence: 0.4,
      history: [expect.objectContaining({ summary: revision.summary })],
    });
    await expect(personalRepository.readConcept(concept.id)).resolves.toMatchObject({
      history: [expect.objectContaining({ summary: revision.summary })],
    });
  });

  it("does not duplicate revision history after a partial Markdown revision write", async () => {
    class RevisionMarkdownFailingRepository extends PersonalRepository {
      private markdownCount = 0;

      override async writeConceptMarkdown(conceptId: string, markdown: string) {
        this.markdownCount += 1;
        if (this.markdownCount === 2) {
          throw new Error("revision Markdown write failed");
        }
        await super.writeConceptMarkdown(conceptId, markdown);
      }
    }

    const fixture = await createCompletedReview(
      (paths, clock) => new RevisionMarkdownFailingRepository(paths, { clock }),
    );
    const { knowledgeService, personalRepository, review, paths } = fixture;
    const concept = await promoteCandidate(knowledgeService, review);
    const revision = {
      boundary: "A narrower retry-safe boundary",
      summary: "One Markdown-repair revision",
      evidence: [{ kind: "test" as const, id: "test-revision-retry" }],
    };

    await expect(knowledgeService.reviseEntry(concept.id, revision)).rejects.toThrow(
      "revision Markdown write failed",
    );
    await expect(knowledgeService.reviseEntry(concept.id, revision)).resolves.toMatchObject({
      boundary: revision.boundary,
      history: [expect.objectContaining({ summary: revision.summary })],
    });
    await expect(personalRepository.readConcept(concept.id)).resolves.toMatchObject({
      history: [expect.objectContaining({ summary: revision.summary })],
    });
    await expect(
      readFile(join(paths.personal.concepts, `${concept.id}.md`), "utf8"),
    ).resolves.toContain(revision.boundary);
  });
});

async function promoteCandidate(knowledgeService: KnowledgeService, review: Awaited<ReturnType<typeof createCompletedReview>>["review"]) {
  const candidate = await proposeAndApprove(knowledgeService, review);
  return knowledgeService.promote(candidate.id, { confidence: 0.8 });
}

async function proposeAndApprove(
  knowledgeService: KnowledgeService,
  review: Awaited<ReturnType<typeof createCompletedReview>>["review"],
) {
  const [candidate] = await knowledgeService.propose(review, [
    {
      principle: "Promotions must preserve source evidence.",
      boundary: "Only for rules validated by a completed review",
      evidence: [{ kind: "task", id: review.taskId }],
    },
  ]);
  const ensuredCandidate = requireCandidate(candidate);

  await knowledgeService.decide(ensuredCandidate.id, {
    actor: "human",
    decision: "approve",
    source: "unit-test helper approval",
  });
  return ensuredCandidate;
}

function requireCandidate<T>(candidate: T | undefined): T {
  expect(candidate).toBeDefined();
  if (!candidate) {
    throw new Error("Expected a proposed candidate");
  }

  return candidate;
}
