import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/index.js";
import {
  capabilityLevelSchema,
  conceptRecordSchema,
  evidenceRefSchema,
  knowledgeCandidateSchema,
  reviewPhaseSchema,
} from "../../src/domain/schema.js";

describe("domain schemas", () => {
  it("accepts the ordered review phases", () => {
    expect(reviewPhaseSchema.options).toEqual([
      "context",
      "reconstruct",
      "challenge",
      "correct",
      "transfer",
      "complete",
    ]);
  });

  it("rejects a fourth knowledge candidate index", () => {
    const result = knowledgeCandidateSchema.safeParse({
      id: "candidate-4",
      reviewId: "review-1",
      ordinal: 4,
      principle: "Too many",
      boundary: "Any",
      evidence: [{ kind: "review", id: "review-evidence-1" }],
      status: "candidate",
    });

    expect(result.success).toBe(false);

    if (result.success) {
      throw new Error("Expected ordinal 4 to be rejected");
    }

    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        code: "too_big",
        path: ["ordinal"],
      }),
    );
  });

  it("defines evidence-backed capability levels", () => {
    expect(capabilityLevelSchema.options).toEqual([
      "seen",
      "understood",
      "explainable",
      "independent",
    ]);
  });

  it.each(["../escaped", "../../escaped", "/absolute", "a/b", "..", "."])(
    "rejects unsafe persisted identifiers: %s",
    (id) => {
      expect(evidenceRefSchema.safeParse({ kind: "task", id }).success).toBe(false);
    },
  );

  it("exposes typed domain errors from the public entrypoint", () => {
    const error = new DomainError("bad-state", "Oops", { retryable: false });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DomainError");
    expect(error.code).toBe("bad-state");
    expect(error.details).toEqual({ retryable: false });
  });

  it("keeps promoted knowledge metadata backward compatible while accepting provenance", () => {
    const baseConcept = {
      id: "review-1-candidate-1",
      reviewId: "review-1",
      ordinal: 1,
      principle: "Keep source evidence attached.",
      boundary: "Use after completed reviews.",
      evidence: [{ kind: "task", id: "task-1" }],
      status: "approved",
      confidence: 0.8,
      reviewedAt: "2026-07-01T00:00:00.000Z",
      taskId: "task-1",
      history: [],
    };

    expect(conceptRecordSchema.safeParse(baseConcept).success).toBe(true);
    expect(
      conceptRecordSchema.safeParse({
        ...baseConcept,
        timestamps: {
          candidateCreatedAt: "2026-07-01T00:00:00.000Z",
          approvedAt: "2026-07-01T00:01:00.000Z",
          promotedAt: "2026-07-01T00:02:00.000Z",
        },
        provenance: {
          candidateId: "review-1-candidate-1",
          reviewId: "review-1",
          taskId: "task-1",
          sourceProject: "/work/project",
          sourceSummary: "Promoted from a completed task review.",
          evidenceRefs: [
            { kind: "task", id: "task-1" },
            { kind: "review", id: "review-1" },
          ],
          decisionReceiptId: "receipt-1",
        },
      }).success,
    ).toBe(true);
  });
});
