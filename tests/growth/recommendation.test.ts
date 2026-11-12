import { join } from "node:path";
import { z } from "zod";
import { readJson, writeJsonAtomic } from "../../src/storage/files.js";
import { afterEach, describe, expect, it } from "vitest";
import { reviewRecommendationSchema, type ConceptRecord, type ReviewSignal, type TaskType } from "../../src/domain/schema.js";
import { recommendGrowth, type GrowthRecommendationInput } from "../../src/growth/recommendation.js";
import { deriveDueQueue } from "../../src/growth/recall.js";
import { contentFingerprint, type CapturedReview, type GrowthObservation, type GrowthSnapshot } from "../../src/growth/schema.js";
import { cleanupFixtures, fixture, task } from "./fixtures.js";

const now = new Date("2026-10-28T12:00:00.000Z");
function snapshot(): GrowthSnapshot {
  return { concepts: [], capabilities: { version: 1, records: [] }, observations: [], capturedReviews: [], decisionReceipts: [], personalReviewStates: [], tasks: [], reviews: [], checkpoints: [], events: [], projectRoot: "/synthetic/project", sourceId: "source-1" };
}
function captured(taskId: string, overrides: Partial<CapturedReview> = {}): CapturedReview {
  return { version: 1, id: `capture-${taskId}`, sourceId: "source-1", taskId, reviewId: `review-${taskId}`, taskType: "implementation", conceptIds: ["concept-1"], signals: ["failure-or-rework"], level: "deep", templateIds: [], taskCompletedAt: "2026-10-27T10:00:00.000Z", completedAt: "2026-10-27T10:00:00.000Z", capturedAt: "2026-10-27T11:00:00.000Z", ...overrides };
}
function concept(id = "concept-1"): ConceptRecord {
  return { id, reviewId: "origin-review", taskId: "origin-task", ordinal: 1, principle: "Use explicit input", boundary: "For deterministic rules", status: "approved", confidence: 0.5, reviewedAt: "2026-09-01T00:00:00.000Z", evidence: [{ kind: "task", id: "origin-task" }], history: [] };
}
function recall(id: string, result: "recalled" | "partial" | "forgotten", overrides: Partial<GrowthObservation> = {}): GrowthObservation {
  return { version: 1, id, conceptId: "concept-1", contentFingerprint: contentFingerprint(concept()), kind: "recall", result, recordedAt: "2026-10-27T10:00:00.000Z", actor: "human", source: "Synthetic human", ...overrides } as GrowthObservation;
}
function history(input = snapshot()) { input.capturedReviews = [captured("prior-1"), captured("prior-2")]; return input; }
afterEach(cleanupFixtures);

describe("history-informed review advice", () => {
  // Catches fingerprint restoration reviving failures from a superseded content epoch.
  it("excludes pre-restoration recall from advice and scheduling, then accepts fresh feedback at the edit instant", () => {
    const original = concept();
    const changed = { ...original, principle: "Changed wording" };
    const beforeEdit = (before: ConceptRecord, recordedAt: string) => ({
      principle: before.principle, boundary: before.boundary, confidence: before.confidence,
      status: before.status, reviewedAt: before.reviewedAt, evidence: before.evidence,
      summary: "Synthetic substantive edit", recordedAt,
    });
    const restored = { ...original, history: [
      beforeEdit(original, "2026-10-23T10:00:00.000Z"),
      beforeEdit(changed, "2026-10-25T10:00:00.000Z"),
    ] };
    const input = snapshot();
    input.concepts = [restored];
    input.observations = [
      recall("old-1", "forgotten", { recordedAt: "2026-10-21T10:00:00.000Z" }),
      recall("old-2", "forgotten", { recordedAt: "2026-10-22T10:00:00.000Z" }),
    ];

    expect(deriveDueQueue(input, now)).toMatchObject([{ reason: "needs-baseline" }]);
    expect(recommendGrowth(input, { conceptIds: [original.id] }, now)).toMatchObject({
      level: "skip", suggestedMethod: null, history: { unresolvedRecallCount: 0, recall: [] },
    });

    input.observations.push(recall("fresh", "partial", { recordedAt: "2026-10-25T10:00:00.000Z" }));
    expect(deriveDueQueue(input, now)).toMatchObject([{ reason: "partial" }]);
    expect(recommendGrowth(input, { conceptIds: [original.id] }, now)).toMatchObject({
      level: "skip", suggestedMethod: "feynman",
      history: { unresolvedRecallCount: 1, recall: [{ observationIds: ["fresh"] }] },
    });

    input.observations.push(recall("fresh-2", "forgotten"));
    expect(recommendGrowth(input, { conceptIds: [original.id] }, now)).toMatchObject({
      level: "quick", history: { unresolvedRecallCount: 2, recall: [{ observationIds: ["fresh", "fresh-2"] }] },
    });
  });

  // Catches old output changes, invented history risk and writes during inspection.
  it("preserves the legacy cold-start score, signals and reasons with explicit insufficient history", () => {
    const input = snapshot(); const before = structuredClone(input);
    const advice = recommendGrowth(input, {}, now);
    expect(advice).toMatchObject({ level: "skip", score: 0, signals: [], reasons: [], baseScore: 0, historyAdjustment: 0, history: { status: "insufficient-history", relevantTaskCount: 0, failureTaskCount: 0, unresolvedRecallCount: 0, sourceIds: [], samples: [], recall: [], window: { startInclusive: "2026-09-28T12:00:00.000Z", endInclusive: "2026-10-28T12:00:00.000Z" } }, suggestedMethod: null, alternatives: [] });
    expect(advice.history.reason).toMatch(/insufficient history/i);
    expect(advice.methodReasons.length).toBeGreaterThan(0);
    expect(input).toEqual(before);
    expect(reviewRecommendationSchema.parse({ level: "skip", score: 0, reasons: [], signals: [] })).toEqual({ level: "skip", score: 0, reasons: [], signals: [] });
    const strong = recommendGrowth(input, { signals: ["architecture-change", "ai-heavy", "architecture-change"] }, now);
    expect(strong).toMatchObject({ level: "deep", score: 4, baseScore: 4, historyAdjustment: 0, signals: ["architecture-change", "ai-heavy"], reasons: ["Architecture is changing, so a deeper review helps verify the new shape.", "AI did most of the work, so a quick review can confirm the human checks."] });
  });

  // Catches counting reviews rather than distinct tasks and exact-score floor errors.
  it("raises two distinct relevant failure tasks to score two with portable sample references", () => {
    const input = history(); input.capturedReviews.push(captured("prior-1", { id: "other-capture", reviewId: "second-review" }), captured("prior-1"));
    const advice = recommendGrowth(input, { type: "implementation" }, now);
    expect(advice).toMatchObject({ level: "deep", score: 2, baseScore: 0, historyAdjustment: 2, suggestedMethod: "aar", history: { relevantTaskCount: 2, failureTaskCount: 2, sourceIds: ["source-1"], samples: [{ sourceId: "source-1", taskId: "prior-1", reviewIds: ["review-prior-1", "second-review"], completedAt: "2026-10-27T10:00:00.000Z" }, { sourceId: "source-1", taskId: "prior-2", reviewIds: ["review-prior-2"], completedAt: "2026-10-27T10:00:00.000Z" }] } });
    expect(recommendGrowth(input, { type: "implementation", signals: ["ai-heavy"] }, now)).toMatchObject({ score: 2, baseScore: 1, historyAdjustment: 1, level: "deep" });
    expect(recommendGrowth(input, { type: "implementation", signals: ["architecture-change", "ai-heavy"] }, now)).toMatchObject({ level: "deep", score: 4, baseScore: 4, historyAdjustment: 0 });
    input.capturedReviews = input.capturedReviews.filter((item) => item.taskId === "prior-1");
    expect(recommendGrowth(input, { type: "implementation" }, now)).toMatchObject({ score: 0, history: { relevantTaskCount: 1, failureTaskCount: 1 } });
  });

  // Catches wildcard/general and cross-source type matching, and concept matching fallthrough.
  it("uses concept overlap across sources and otherwise exact non-general type within the selected source", () => {
    const input = history(); input.capturedReviews[1]!.sourceId = "source-2";
    expect(recommendGrowth(input, { conceptIds: ["concept-1"], type: "debugging" }, now)).toMatchObject({ score: 2, history: { sourceIds: ["source-1", "source-2"] } });
    expect(recommendGrowth(input, { type: "implementation" }, now)).toMatchObject({ score: 0, history: { relevantTaskCount: 1 } });
    expect(recommendGrowth(input, { type: "general" }, now)).toMatchObject({ score: 0, history: { relevantTaskCount: 0 } });
    expect(recommendGrowth(input, { conceptIds: ["unrelated"], type: "implementation" }, now)).toMatchObject({ history: { relevantTaskCount: 0 } });
    delete input.sourceId;
    expect(recommendGrowth(input, { type: "implementation" }, now)).toMatchObject({ history: { relevantTaskCount: 0 } });
    expect(recommendGrowth(input, { conceptIds: ["concept-1"] }, now)).toMatchObject({ score: 2 });
    expect(input).not.toHaveProperty("sourceId");
  });

  // Catches excluding same task ID from all sources or allowing current selected task in history.
  it("excludes only the current source/task pair and applies task metadata only as fallback", () => {
    const input = history(); input.tasks = [{ ...task("current"), type: "implementation", conceptIds: ["concept-1"] }];
    input.capturedReviews = [captured("current"), captured("current", { id: "foreign", sourceId: "source-2" }), captured("prior")];
    expect(recommendGrowth(input, { taskId: "current" }, now)).toMatchObject({ score: 2, suggestedMethod: "aar", history: { relevantTaskCount: 2, sourceIds: ["source-1", "source-2"] } });
    expect(recommendGrowth(input, { taskId: "current", type: "general", conceptIds: [], signals: [] }, now)).toMatchObject({ score: 0, suggestedMethod: null, history: { relevantTaskCount: 0 } });
  });

  // Catches wrong window endpoints, unknown completions, future capture, unrelated and live-review leakage.
  it("ignores out-of-window, unknown, future and unrelated history and does not implicitly capture live reviews", () => {
    const input = snapshot(); input.capturedReviews = [captured("start", { completedAt: "2026-09-28T12:00:00.000Z" }), captured("old", { completedAt: "2026-09-28T11:59:59.999Z" }), captured("at-now", { completedAt: now.toISOString(), capturedAt: now.toISOString() }), captured("future", { completedAt: "2026-10-28T12:00:00.001Z" }), captured("unknown", { completedAt: null }), captured("wrong", { taskType: "debugging", conceptIds: [] }), captured("future-capture", { capturedAt: "2026-10-29T00:00:00.000Z" })];
    input.reviews = [{ id: "interrupted", taskId: "live-task", level: "deep", selectedBy: "human", status: "interrupted", phase: "challenge", startedAt: "2026-10-27T00:00:00.000Z", entries: [] }];
    expect(recommendGrowth(input, { type: "implementation" }, now)).toMatchObject({ score: 2, history: { relevantTaskCount: 2, samples: [{ taskId: "at-now" }, { taskId: "start" }] } });
  });

  // Catches counting stale/duplicate/future observations or assuming capability means mastery.
  it("raises two distinct unresolved current-content human operations to quick, never downgrading current risk", () => {
    const input = snapshot(); input.concepts = [concept()]; input.observations = [recall("op-1", "partial"), recall("op-1", "partial"), recall("op-2", "forgotten"), recall("old", "forgotten", { contentFingerprint: "a".repeat(64) }), recall("future", "forgotten", { recordedAt: "2026-10-29T00:00:00.000Z" }), recall("unknown", "forgotten", { conceptId: "missing" })];
    const advice = recommendGrowth(input, { conceptIds: ["concept-1"] }, now);
    expect(advice).toMatchObject({ level: "quick", score: 1, baseScore: 0, historyAdjustment: 1, suggestedMethod: "feynman", history: { unresolvedRecallCount: 2, recall: [{ conceptId: "concept-1", latestOutcome: "forgotten", unresolvedCount: 2, observationIds: ["op-1", "op-2"] }] } });
    expect(recommendGrowth(input, { conceptIds: ["concept-1"], signals: ["failure-or-rework"] }, now)).toMatchObject({ score: 3, historyAdjustment: 0, suggestedMethod: "five-whys", alternatives: ["feynman"] });
    expect(recommendGrowth(input, {}, now)).toMatchObject({ score: 0, history: { unresolvedRecallCount: 0 } });
  });

  // Catches unresolved history surviving a later recalled and wrong per-concept resets.
  it("clears prior unresolved operations after a later recalled and reports the latest outcome", () => {
    const input = snapshot(); input.concepts = [concept()]; input.observations = [recall("old-1", "partial"), recall("old-2", "forgotten"), recall("resolved", "recalled", { recordedAt: now.toISOString() })];
    expect(recommendGrowth(input, { conceptIds: ["concept-1"] }, now)).toMatchObject({ score: 0, suggestedMethod: null, history: { unresolvedRecallCount: 0, recall: [{ latestOutcome: "recalled", unresolvedCount: 0, observationIds: [] }] } });
    input.observations.push(recall("again", "partial", { recordedAt: "2026-10-28T12:00:00.001Z" }));
    expect(recommendGrowth(input, { conceptIds: ["concept-1"] }, new Date("2026-10-28T12:00:00.001Z"))).toMatchObject({ score: 0, suggestedMethod: "feynman", history: { unresolvedRecallCount: 1, recall: [{ latestOutcome: "partial", observationIds: ["again"] }] } });
  });
});


describe("method suggestions and recommendation boundaries", () => {
  // Catches the wrong explicit mapping, text classification, and template auto-selection.
  it.each([
    ["architecture", [], "aar", []], ["implementation", [], "aar", []], ["research", [], "aar", []],
    ["refactor", [], "kpt", []], ["debugging", [], null, []], ["general", [], null, []],
    ["refactor", ["unfamiliar-technology"], "feynman", ["kpt"]],
    ["implementation", ["failure-or-rework", "unfamiliar-technology"], "five-whys", ["feynman", "aar"]],
    ["refactor", ["architecture-change"], "aar", ["kpt"]],
  ] as [TaskType, ReviewSignal[], string | null, string[]][])("maps explicit %s and %j without inferring workflow", (type, signals, method, alternatives) => {
    const input = snapshot();
    input.tasks = [{ ...task("selected"), title: "Failure debugging unfamiliar architecture refactor", goal: "Investigate recurring failures", type }];
    const before = structuredClone(input);
    const advice = recommendGrowth(input, { taskId: "selected", signals }, now);
    expect(advice).toMatchObject({ suggestedMethod: method, alternatives, history: { relevantTaskCount: 0 } });
    expect(advice.methodReasons.length).toBeGreaterThan(0);
    expect(advice.methodReasons.join(" ")).not.toMatch(/recurr|caused|improv|mastery/i);
    expect(input).toEqual(before);
  });

  // Catches unresolved counts being shared across concepts or stale/obsolete feedback contributing.
  it("combines unresolved operations across related concepts and clears each concept independently", () => {
    const input = snapshot(); input.concepts = [concept(), concept("concept-2"), { ...concept("obsolete"), status: "obsolete" }];
    input.observations = [recall("one", "partial"), recall("two", "forgotten", { conceptId: "concept-2", contentFingerprint: contentFingerprint(concept("concept-2")) }), recall("obsolete-op", "forgotten", { conceptId: "obsolete", contentFingerprint: contentFingerprint(concept("obsolete")) })];
    expect(recommendGrowth(input, { conceptIds: ["concept-1", "concept-2", "obsolete"] }, now)).toMatchObject({ score: 1, history: { unresolvedRecallCount: 2, recall: [{ conceptId: "concept-1", unresolvedCount: 1 }, { conceptId: "concept-2", unresolvedCount: 1 }] } });
    input.observations.push(recall("clear-one", "recalled", { recordedAt: now.toISOString() }));
    expect(recommendGrowth(input, { conceptIds: ["concept-1", "concept-2"] }, now)).toMatchObject({ score: 0, suggestedMethod: "feynman", history: { unresolvedRecallCount: 1 } });
  });

  // Catches an immediately recorded recalled being lost when all operations share an injected clock.
  it("lets a recalled at the same clock clear previous risk independently of operation ID sorting", () => {
    const input = snapshot(); input.concepts = [concept()];
    input.observations = [recall("z-old-1", "partial", { recordedAt: now.toISOString() }), recall("z-old-2", "forgotten", { recordedAt: now.toISOString() }), recall("a-recalled", "recalled", { recordedAt: now.toISOString() })];
    expect(recommendGrowth(input, { conceptIds: ["concept-1"] }, now)).toMatchObject({ score: 0, suggestedMethod: null, history: { unresolvedRecallCount: 0, recall: [{ latestOutcome: "recalled", latestObservedAt: now.toISOString(), observationIds: [] }] } });
  });

  // Catches global operation ID collisions inflating distinct human feedback counts.
  it("does not count conflicting copies of an operation ID as two human operations", () => {
    const input = snapshot(); input.concepts = [concept(), concept("concept-2")];
    input.observations = [recall("shared", "forgotten"), recall("shared", "partial", { conceptId: "concept-2", contentFingerprint: contentFingerprint(concept("concept-2")) })];
    const advice = recommendGrowth(input, { conceptIds: ["concept-1", "concept-2"] }, now);
    expect(advice).toMatchObject({ score: 0, history: { unresolvedRecallCount: 0, recall: [] } });
    expect(recommendGrowth({ ...input, observations: [...input.observations].reverse() }, { conceptIds: ["concept-1", "concept-2"] }, now)).toEqual(advice);
  });

  // Catches history success or independent capability records being interpreted as mastery.
  it("does not reduce strong current risk from successful history or capability levels", () => {
    const input = history(); input.capturedReviews.forEach((item) => { item.signals = []; });
    input.capabilities = { version: 2, history: [], records: [{ conceptId: "concept-1", level: "independent", evidence: [{ kind: "independent-task", taskId: "later", originatingTaskId: "origin" }], updatedAt: now.toISOString() }] };
    expect(recommendGrowth(input, { conceptIds: ["concept-1"], signals: ["failure-or-rework"] }, now)).toMatchObject({ score: 3, level: "deep", historyAdjustment: 0, suggestedMethod: "five-whys", history: { relevantTaskCount: 2, failureTaskCount: 0 } });
  });

  // Catches malformed inputs slipping into advice, unsafe IDs, and unknown selected task fallback.
  it.each([
    { type: "made-up" }, { signals: ["made-up"] }, { taskId: "../outside" }, { conceptIds: ["../outside"] },
    { signals: "failure-or-rework" }, { conceptIds: null }, { extra: "unrecognized" },
  ])("rejects invalid explicit input %j", (input) => {
    expect(() => recommendGrowth(snapshot(), input as GrowthRecommendationInput, now)).toThrowError(expect.objectContaining({ code: "INVALID_GROWTH_RECOMMENDATION" }));
  });
  it("rejects an invalid clock and absent selected task", () => {
    expect(() => recommendGrowth(snapshot(), {}, new Date("invalid"))).toThrowError(expect.objectContaining({ code: "INVALID_GROWTH_RECOMMENDATION" }));
    expect(() => recommendGrowth(snapshot(), { taskId: "missing" }, now)).toThrowError(expect.objectContaining({ code: "TASK_NOT_FOUND" }));
  });

  // Catches schema stripping metadata between the cache envelope, human start and persisted review.
  it("roundtrips metadata through the cache schema and ReviewService while preserving the human-selected level", async () => {
    const data = await fixture();
    const selected = await data.projectService.startTask({ title: "Synthetic review", goal: "Preserve explicit human choice" });
    const advice = recommendGrowth(history(), { type: "implementation" }, now);
    const cache = join(data.paths.project.base, "review-recommendations", `${selected.id}.json`);
    await writeJsonAtomic(cache, { taskId: selected.id, recommendation: advice });
    const cached = await readJson(cache, z.object({ taskId: z.string(), recommendation: reviewRecommendationSchema }));
    expect(cached.recommendation).toEqual(advice);
    const started = await data.reviewService.start({ taskId: selected.id, level: "quick", selectedBy: "human", recommendation: cached.recommendation });
    expect(started).toMatchObject({ level: "quick", selectedBy: "human", recommendation: advice });
    expect(await data.project.readReview(started.id)).toMatchObject({ level: "quick", recommendation: advice });
    expect(started.entries.some((entry) => entry.templateId !== undefined)).toBe(false);
    expect(reviewRecommendationSchema.safeParse({ ...advice, ruleVersion: "growth-v999" }).success).toBe(false);
  });

  // Catches sort operations mutating caller-owned arrays and input order changing recommendations.
  it("returns deterministic advice without changing any supplied record", () => {
    const input = history(); input.concepts = [concept()]; input.observations = [recall("second", "forgotten"), recall("first", "partial")];
    const before = structuredClone(input);
    const advice = recommendGrowth(input, { conceptIds: ["concept-1"] }, now);
    const reversed = structuredClone(input); reversed.capturedReviews.reverse(); reversed.observations.reverse();
    expect(recommendGrowth(reversed, { conceptIds: ["concept-1"] }, now)).toEqual(advice);
    expect(input).toEqual(before);
  });
});


describe("actual completed-task samples", () => {
  // Catches substituting review/capture/local task timestamps for a portable completion witness.
  it.each([undefined, null, "2026-10-28T12:00:00.001Z", "2026-09-28T11:59:59.999Z"])("excludes unknown, future or expired task completion %s", (taskCompletedAt) => {
    const input = history();
    for (const item of input.capturedReviews) {
      if (taskCompletedAt === undefined) delete item.taskCompletedAt;
      else item.taskCompletedAt = taskCompletedAt;
    }
    input.tasks = input.capturedReviews.map((item) => ({ ...task(item.taskId), type: "implementation" }));
    expect(recommendGrowth(input, { type: "implementation" }, now)).toMatchObject({ score: 0, history: { relevantTaskCount: 0, failureTaskCount: 0, samples: [], status: "insufficient-history" } });
  });

  // Catches wrong task window endpoints and exposing review completion as task completion.
  it("uses both inclusive task time boundaries and reports actual task completion instead of review time", () => {
    const input = history(); input.capturedReviews[0]!.taskCompletedAt = "2026-09-28T12:00:00.000Z"; input.capturedReviews[1]!.taskCompletedAt = now.toISOString();
    expect(recommendGrowth(input, { type: "implementation" }, now)).toMatchObject({ score: 2, history: { samples: [
      { taskId: "prior-1", completedAt: "2026-09-28T12:00:00.000Z" }, { taskId: "prior-2", completedAt: now.toISOString() },
    ] } });
  });
});
