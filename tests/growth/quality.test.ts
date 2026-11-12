import { describe, expect, it } from "vitest";
import type { ConceptRecord, KnowledgeCandidate } from "../../src/domain/schema.js";
import { assessQuality } from "../../src/growth/quality.js";
import { contentFingerprint, type GrowthSnapshot } from "../../src/growth/schema.js";
import { candidateDigest } from "../../src/personal/candidate-identity.js";
import { review, task } from "./fixtures.js";

function snapshot(): GrowthSnapshot {
  const candidate: KnowledgeCandidate = {
    id: "concept-1", reviewId: "review-1", ordinal: 1, principle: "Separate inputs from effects",
    boundary: "When deterministic rules can be isolated", status: "approved",
    evidence: [{ kind: "task", id: "task-1" }],
  };
  const concept: ConceptRecord = {
    ...candidate, evidence: structuredClone(candidate.evidence), status: "approved", taskId: "task-1", confidence: 0.5,
    reviewedAt: "2026-10-27T11:00:00.000Z", history: [],
    timestamps: { candidateCreatedAt: "2026-10-27T09:30:00.000Z", approvedAt: "2026-10-27T10:00:00.000Z", promotedAt: "2026-10-27T11:00:00.000Z" },
    provenance: { candidateId: candidate.id, reviewId: candidate.reviewId, taskId: "task-1", sourceProject: "/synthetic/project", sourceSummary: "Synthetic approval", evidenceRefs: candidate.evidence, decisionReceiptId: "receipt-1" },
  };
  return {
    concepts: [concept], capabilities: { version: 1, records: [] }, observations: [], capturedReviews: [],
    personalReviewStates: [{ version: 1, reviewId: "review-1", taskId: "task-1", proposedAt: "2026-10-27T09:30:00.000Z", candidates: [candidate] }],
    decisionReceipts: [{ id: "receipt-1", candidateId: candidate.id, candidateDigest: candidateDigest(candidate), actor: "human", at: "2026-10-27T10:00:00.000Z", decision: "approve", source: "Synthetic test human" }],
    tasks: [task()], reviews: [review()], checkpoints: [], events: [], projectRoot: "/synthetic/project", sourceId: "source-1",
  };
}
function concept(input: GrowthSnapshot): ConceptRecord { return input.concepts[0]!; }
function result(input = snapshot()) { return assessQuality(input)[0]!; }

describe("documentation and evidence quality", () => {
  // Catches omitted dimensions, wrong weights, and accidental capability updates.
  it("explains a complete assessment with four rubric dimensions without changing the snapshot", () => {
    const input = snapshot();
    const before = structuredClone(input);
    const assessment = result(input);
    expect(assessment).toMatchObject({ conceptId: "concept-1", revision: contentFingerprint(concept(input)), ruleVersion: "growth-v1", earned: 100, unknown: 0, range: { min: 100, max: 100 }, coverage: 1, score: 100, status: "assessed", measure: "documentation-and-evidence-quality" });
    for (const [dimension, points] of [["structure", 20], ["provenance", 20], ["evidence", 40], ["consistency", 20]] as const) {
      expect(assessment.checks.filter((check) => check.dimension === dimension).reduce((sum, check) => sum + check.earned, 0)).toBe(points);
    }
    expect(assessment.checks.every((check) => typeof check.correctiveAction === "string" && Array.isArray(check.evidenceIds))).toBe(true);
    expect(assessment.evidence).toEqual([expect.objectContaining({ id: "task-1", kind: "task", status: "verified-local", earned: 40, unknown: 0 })]);
    expect(input).toEqual(before);
  });

  // Catches renormalization, treating declarations as verified, and duplicate inflation.
  it("retains the unknown weight of external evidence and deduplicates identical references", () => {
    const input = snapshot();
    concept(input).evidence.push({ kind: "test", id: "test-result" });
    let assessment = result(input);
    expect(assessment).toMatchObject({ earned: 80, unknown: 20, range: { min: 80, max: 100 }, coverage: 0.8, status: "insufficient-evidence" });
    expect(assessment).not.toHaveProperty("score");
    expect(assessment.evidence.map((item) => item.status)).toEqual(["verified-local", "declared-external"]);
    concept(input).evidence.push({ kind: "task", id: "task-1" }, { kind: "test", id: "test-result" });
    assessment = result(input);
    expect(assessment).toMatchObject({ earned: 80, unknown: 20 });
    expect(assessment.evidence).toHaveLength(2);
  });

  // Catches colliding IDs being accepted from a different project.
  it("distinguishes dangling selected-project references from unavailable imported sources", () => {
    const input = snapshot();
    input.tasks = [];
    expect(result(input)).toMatchObject({ earned: 60, unknown: 0, score: 60 });
    expect(result(input).evidence[0]).toMatchObject({ status: "missing" });
    input.tasks = [task()];
    concept(input).provenance!.sourceProject = "/unrelated/project";
    expect(result(input)).toMatchObject({ earned: 60, unknown: 40, range: { min: 60, max: 100 } });
    expect(result(input).evidence[0]).toMatchObject({ status: "unavailable-source" });
  });

  // Catches empty evidence being treated as perfect or indefinitely unknown.
  it("assigns known zero to absent evidence and never penalizes the age of coherent records", () => {
    const input = snapshot();
    concept(input).evidence = [];
    expect(result(input)).toMatchObject({ earned: 60, unknown: 0, score: 60 });
    expect(result(input).checks.find((check) => check.id === "evidence.none")).toMatchObject({ earned: 0, unknown: 0, points: 40 });
    concept(input).evidence = [{ kind: "task", id: "task-1" }];
    concept(input).timestamps = { candidateCreatedAt: "2000-01-01T00:00:00.000Z", approvedAt: "2000-01-02T00:00:00.000Z", promotedAt: "2000-01-03T00:00:00.000Z" };
    concept(input).reviewedAt = "2000-01-03T00:00:00.000Z";
    input.decisionReceipts[0]!.at = "2000-01-02T00:00:00.000Z";
    input.personalReviewStates[0]!.proposedAt = "2000-01-01T00:00:00.000Z";
    expect(result(input)).toMatchObject({ earned: 100, unknown: 0 });
  });

  // Catches min-length validation being mistaken for meaningful structure.
  it("treats whitespace as missing structure and legacy metadata as explicit uncertainty", () => {
    const input = snapshot();
    concept(input).principle = " \n ";
    concept(input).boundary = "\t";
    expect(result(input).checks.filter((check) => check.dimension === "structure").map((check) => check.earned)).toEqual([0, 0]);
    delete concept(input).timestamps;
    delete concept(input).provenance;
    expect(result(input)).toMatchObject({ earned: 10, unknown: 50, range: { min: 10, max: 60 } });
    expect(result(input).checks.find((check) => check.id === "provenance.receipt")).toMatchObject({ status: "missing", unknown: 0 });
    expect(result(input).evidence[0]).toMatchObject({ status: "unavailable-source" });
  });

  // Catches accidental mastery inflation and omission of explicit obsolete inspection.
  it("excludes obsolete concepts by default but allows explicit inspection", () => {
    const input = snapshot();
    concept(input).status = "obsolete";
    concept(input).timestamps!.supersededAt = concept(input).reviewedAt;
    expect(assessQuality(input)).toEqual([]);
    expect(assessQuality(input, "concept-1")[0]).toMatchObject({ earned: 90, unknown: 0 });
    expect(() => assessQuality(input, "missing")).toThrow(/concept.*not found/i);
    expect(() => assessQuality(input, "../outside")).toThrow(/identifier/i);
  });
});

describe("approval and record integrity", () => {
  // Catches current wording being silently certified by a historical approval.
  it("validates original approval across substantive revisions and warns about the current wording", () => {
    const input = snapshot();
    const current = concept(input);
    current.history.push({ revisionId: "a".repeat(64), principle: current.principle, boundary: current.boundary, status: current.status, confidence: current.confidence, reviewedAt: current.reviewedAt, recordedAt: "2026-10-28T10:00:00.000Z", summary: "Refined wording", evidence: [{ kind: "test", id: "revision-check" }] });
    current.principle = "Keep rules independent from side effects";
    current.reviewedAt = "2026-10-28T10:00:00.000Z";
    current.timestamps!.updatedAt = current.reviewedAt;
    expect(result(input)).toMatchObject({ earned: 100, unknown: 0 });
    expect(result(input).findings).toContainEqual(expect.objectContaining({ code: "revision-after-approval" }));
    input.personalReviewStates = [];
    expect(result(input).checks.find((check) => check.id === "provenance.receipt")).toMatchObject({ earned: 5, unknown: 0 });
    expect(result(input).findings).toContainEqual(expect.objectContaining({ code: "original-candidate-unavailable" }));
    current.history = [];
    expect(result(input).checks.find((check) => check.id === "provenance.receipt")).toMatchObject({ earned: 0, unknown: 0, status: "inconsistent" });
  });

  // Catches false approval through wrong candidate, digest, or human decision.
  it.each(["digest", "candidate", "decision", "missing"] as const)("reports a %s approval problem as known failure", (problem) => {
    const input = snapshot();
    if (problem === "digest") input.decisionReceipts[0]!.candidateDigest = "0".repeat(64);
    if (problem === "candidate") input.decisionReceipts[0]!.candidateId = "other-concept";
    if (problem === "decision") input.decisionReceipts[0]!.decision = "reject";
    if (problem === "missing") input.decisionReceipts = [];
    expect(result(input)).toMatchObject({ earned: 95, unknown: 0, score: 95 });
    expect(result(input).checks.find((check) => check.id === "provenance.receipt")).toMatchObject({ earned: 0, unknown: 0, status: problem === "missing" ? "missing" : "inconsistent" });
  });

  // Catches absent timestamp metadata becoming a fabricated perfect score.
  it("retains unknown weight for legacy timestamps while reporting a missing receipt separately", () => {
    const input = snapshot();
    delete concept(input).timestamps;
    input.decisionReceipts = [];
    expect(result(input)).toMatchObject({ earned: 85, unknown: 10, range: { min: 85, max: 95 }, coverage: 0.9 });
    expect(result(input)).not.toHaveProperty("score");
  });

  // Catches incoherent chronology and history gaps passing the consistency check.
  it.each(["reversed", "receipt-time", "missing-history", "history-order", "history-time", "history-link"] as const)("reports %s timestamp/history inconsistency without changing approval", (problem) => {
    const input = snapshot();
    const current = concept(input);
    if (problem === "reversed") current.timestamps!.approvedAt = "2026-10-28T00:00:00.000Z";
    if (problem === "receipt-time") input.decisionReceipts[0]!.at = "2026-10-27T10:01:00.000Z";
    if (problem === "missing-history") { current.reviewedAt = "2026-10-28T10:00:00.000Z"; current.timestamps!.updatedAt = current.reviewedAt; }
    if (problem === "history-order" || problem === "history-time" || problem === "history-link") {
      current.history.push({ revisionId: "a".repeat(64), principle: current.principle, boundary: current.boundary, status: current.status, confidence: current.confidence, reviewedAt: current.reviewedAt, recordedAt: "2026-10-28T10:00:00.000Z", summary: "Assessment", evidence: [{ kind: "task", id: "task-1" }] });
      current.reviewedAt = "2026-10-28T10:00:00.000Z";
      current.timestamps!.updatedAt = current.reviewedAt;
      if (problem === "history-order") current.history[0]!.reviewedAt = "2026-10-29T10:00:00.000Z";
      else if (problem === "history-link") current.history[0]!.reviewedAt = "2026-10-27T12:00:00.000Z";
      else current.history[0]!.recordedAt = "2026-10-26T10:00:00.000Z";
    }
    expect(result(input)).toMatchObject({ earned: 90, unknown: 0, score: 90 });
    expect(result(input).checks.find((check) => check.id === "consistency.metadata")).toMatchObject({ status: "inconsistent", earned: 0 });
  });

  // Catches treating confidence-only changes as content revisions needing reapproval.
  it("keeps confidence-only revision identity and treats absent legacy revision IDs as unknown", () => {
    const input = snapshot();
    const current = concept(input);
    current.history.push({ revisionId: "b".repeat(64), principle: current.principle, boundary: current.boundary, status: current.status, confidence: current.confidence, reviewedAt: current.reviewedAt, recordedAt: "2026-10-28T10:00:00.000Z", summary: "Confidence assessment", evidence: [{ kind: "task", id: "task-1" }] });
    const fingerprint = contentFingerprint(current);
    current.confidence = 0.9;
    current.reviewedAt = "2026-10-28T10:00:00.000Z";
    current.timestamps!.updatedAt = current.reviewedAt;
    expect(result(input)).toMatchObject({ earned: 100, unknown: 0, revision: fingerprint });
    expect(result(input).findings.some((finding) => finding.code === "revision-after-approval")).toBe(false);
    delete current.history[0]!.revisionId;
    expect(result(input)).toMatchObject({ earned: 90, unknown: 10 });
  });

  // Catches provenance identifier scoring being conflated with entity availability.
  it("fails only the mismatching provenance identifiers while keeping matching source evidence", () => {
    const input = snapshot();
    concept(input).provenance!.reviewId = "wrong-review";
    concept(input).provenance!.taskId = "wrong-task";
    expect(result(input)).toMatchObject({ earned: 90, unknown: 0, score: 90 });
    expect(result(input).evidence[0]).toMatchObject({ status: "verified-local" });
  });

  // Catches evidence kind fallthrough, source ID collisions, and order instability.
  it("resolves all local record kinds only for the matching source and keeps deterministic concept order", () => {
    const input = snapshot();
    input.events = [{ id: "event-1", at: "2026-10-27T08:00:00.000Z", type: "test", summary: "Synthetic", evidence: [] }];
    input.checkpoints = [{ id: "checkpoint-1", taskId: "task-1", at: "2026-10-27T08:00:00.000Z", reason: "manual", snapshot: {} }];
    concept(input).evidence = [{ kind: "review", id: "review-1" }, { kind: "event", id: "event-1" }, { kind: "checkpoint", id: "checkpoint-1" }, { kind: "commit", id: "commit-1", path: "/never/read/this" }];
    concept(input).provenance!.sourceProject = "source-1";
    expect(result(input)).toMatchObject({ earned: 90, unknown: 10 });
    expect(result(input).evidence.map((item) => item.status)).toEqual(["verified-local", "verified-local", "verified-local", "declared-external"]);
    concept(input).provenance!.sourceProject = "source-2";
    expect(result(input)).toMatchObject({ earned: 60, unknown: 40 });
    const other = structuredClone(concept(input)); other.id = "a-concept";
    input.concepts.push(other);
    expect(assessQuality(input).map((assessment) => assessment.conceptId)).toEqual(["a-concept", "concept-1"]);
  });
});

describe("fractional evidence weights", () => {
  // Catches rounding each 40/N contribution before summing.
  it.each([3, 7])("keeps %i verified references at exactly 40 evidence points and 100 overall", (count) => {
    const input = snapshot();
    concept(input).evidence = Array.from({ length: count }, (_, index) => ({ kind: "task", id: `task-${index + 1}` }));
    input.tasks = Array.from({ length: count }, (_, index) => task(`task-${index + 1}`));
    expect(result(input)).toMatchObject({ earned: 100, unknown: 0, score: 100, range: { min: 100, max: 100 }, coverage: 1 });
    expect(result(input).evidence.reduce((sum, reference) => sum + reference.earned, 0)).toBeCloseTo(40, 12);
  });

  // Catches unknown or known-failed weights being added to the wrong range bound.
  it("bounds mixed fractional verified, external, and missing references without renormalizing", () => {
    const input = snapshot();
    concept(input).evidence = [{ kind: "task", id: "task-1" }, { kind: "commit", id: "commit-1" }, { kind: "event", id: "missing-event" }];
    const assessment = result(input);
    expect(assessment.earned).toBeCloseTo(73.3333333333, 9);
    expect(assessment.unknown).toBeCloseTo(13.3333333333, 9);
    expect(assessment.range.max).toBeCloseTo(86.6666666667, 9);
    expect(assessment.range.max).toBeLessThanOrEqual(100);
    expect(assessment.evidence.map((reference) => reference.status)).toEqual(["verified-local", "declared-external", "missing"]);
    expect(assessment).not.toHaveProperty("score");
  });
});
