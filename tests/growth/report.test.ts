import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrowthRepository } from "../../src/growth/repository.js";
import { buildGrowthReport, GrowthService, renderGrowthReport } from "../../src/index.js";
import type { GrowthSnapshot } from "../../src/growth/schema.js";
import { cleanupFixtures, fixture, task, review } from "./fixtures.js";

// Timing hook only: directory listings and source bytes use the real disposable filesystem.
const directoryHook = vi.hoisted(() => ({ afterList: undefined as undefined | ((path: string) => Promise<void>) }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readdir: async (path: string, ...args: unknown[]) => {
    const result = await (actual.readdir as Function)(path, ...args);
    await directoryHook.afterList?.(path);
    return result;
  } };
});
afterEach(async () => { directoryHook.afterList = undefined; vi.restoreAllMocks(); await cleanupFixtures(); });
function empty(): GrowthSnapshot {
  return { concepts: [], capabilities: { version: 1, records: [] }, observations: [], capturedReviews: [], decisionReceipts: [], personalReviewStates: [], tasks: [], reviews: [], checkpoints: [], events: [], projectRoot: "/synthetic/project" };
}

describe("growth report UTC periods", () => {
  // Catches a Sunday week start or observing future days in the calendar week.
  it("observes only the elapsed part of the UTC Monday calendar week", () => {
    expect(buildGrowthReport(empty(), {}, new Date("2026-10-28T09:00:00.000Z"))).toMatchObject({
      schemaVersion: 1, ruleVersion: "growth-v1", generatedAt: "2026-10-28T09:00:00.000Z",
      bounds: { period: "week", from: "2026-10-26T00:00:00.000Z", to: "2026-10-28T09:00:00.000Z", requestedTo: "2026-11-02T00:00:00.000Z", endExclusive: true },
    });
  });
});

// Each literal catches a different UTC calendar rollover (including leap February).
it.each([
  ["week", "2027-01-01T10:00:00.000Z", "2026-12-28T00:00:00.000Z", "2027-01-04T00:00:00.000Z"],
  ["week", "2026-11-01T10:00:00.000Z", "2026-10-26T00:00:00.000Z", "2026-11-02T00:00:00.000Z"],
  ["month", "2024-02-29T10:00:00.000Z", "2024-02-01T00:00:00.000Z", "2024-03-01T00:00:00.000Z"],
  ["month", "2026-12-31T10:00:00.000Z", "2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
] as const)("bounds %s at %s", (period, at, from, requestedTo) => {
  expect(buildGrowthReport(empty(), { period }, new Date(at)).bounds).toMatchObject({ from, to: at, requestedTo });
});

it("allows the empty observed calendar period exactly at its start", () => {
  expect(buildGrowthReport(empty(), {}, new Date("2026-10-26T00:00:00.000Z")).bounds).toMatchObject({ from: "2026-10-26T00:00:00.000Z", to: "2026-10-26T00:00:00.000Z" });
});

it("normalizes custom offsets and caps a requested future end at the clock", () => {
  expect(buildGrowthReport(empty(), { from: "2026-10-27T08:00:00+08:00", to: "2026-11-01T00:00:00Z" }, new Date("2026-10-28T09:00:00.000Z")).bounds).toEqual({ period: "custom", from: "2026-10-27T00:00:00.000Z", to: "2026-10-28T09:00:00.000Z", requestedTo: "2026-11-01T00:00:00.000Z", endExclusive: true });
});

it.each([
  { from: "bad", to: "2026-10-28T00:00:00Z" },
  { from: "2026-02-30T00:00:00Z", to: "2026-10-28T00:00:00Z" },
  { from: "2026-10-27", to: "2026-10-28T00:00:00Z" },
  { from: "2026-10-27T00:00:00Z" },
  { to: "2026-10-28T00:00:00Z" },
  { from: "2026-10-28T00:00:00Z", to: "2026-10-27T00:00:00Z" },
  { from: "2026-10-27T00:00:00Z", to: "2026-10-27T00:00:00Z" },
  { from: "2026-10-29T00:00:00Z", to: "2026-10-30T00:00:00Z" },
  { period: "week" as const, from: "2026-10-27T00:00:00Z", to: "2026-10-28T00:00:00Z" },
])("rejects invalid, inverted, mixed, and future-only options %j", (options) => {
  expect(() => buildGrowthReport(empty(), options, new Date("2026-10-28T09:00:00.000Z"))).toThrow(/period|range|timestamp/i);
});

it("rejects invalid clocks rather than producing a report with unusable dates", () => {
  expect(() => buildGrowthReport(empty(), {}, new Date(NaN))).toThrow(/clock/i);
});

function sample(): GrowthSnapshot {
  const input = empty();
  input.sourceId = "selected-source";
  input.concepts = [{ id: "concept-1", reviewId: "review-1", taskId: "task-1", ordinal: 1, principle: "Separate rules and effects", boundary: "Where rules are deterministic", evidence: [{ kind: "task", id: "task-1" }], status: "approved", confidence: .8,
    reviewedAt: "2026-10-27T03:00:00.000Z", timestamps: { candidateCreatedAt: "2026-10-25T00:00:00.000Z", approvedAt: "2026-10-26T00:00:00.000Z", promotedAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-27T03:00:00.000Z" },
    history: [{ revisionId: "a".repeat(64), principle: "Old wording", boundary: "Old boundary", status: "approved", confidence: .8, reviewedAt: "2026-10-26T00:00:00.000Z", recordedAt: "2026-10-27T03:00:00.000Z", summary: "Revised", evidence: [{ kind: "task", id: "task-1" }] }],
  }];
  input.capturedReviews = [{ version: 1, id: "capture-1", sourceId: "other-source", taskId: "task-1", reviewId: "review-1", taskType: "implementation", conceptIds: ["concept-1"], signals: [], level: "quick", templateIds: ["aar", "feynman"], taskCompletedAt: "2026-10-27T08:00:00.000Z", completedAt: "2026-10-27T04:00:00.000Z", capturedAt: "2026-10-28T00:00:00.000Z" }];
  input.observations = [{ version: 1, id: "recall-1", kind: "recall", result: "partial", conceptId: "concept-1", contentFingerprint: "b".repeat(64), recordedAt: "2026-10-27T05:00:00.000Z", actor: "human", source: "Synthetic human" }];
  return input;
}
const now = new Date("2026-10-28T09:00:00.000Z");

describe("actual period events and coverage", () => {
  // Catches implicit capture, use of capture/start dates as completion, and inferred template use.
  it("counts only dated captures and explicit methods, preserving actual source identities", () => {
    const input = sample();
    input.capturedReviews.push({ ...input.capturedReviews[0]!, id: "unknown-completion", completedAt: null, templateIds: ["five-whys"] });
    input.reviews = [{ id: "uncaptured", taskId: "selected-task", level: "quick", selectedBy: "human", status: "completed", phase: "complete", startedAt: "2026-10-27T00:00:00.000Z", completedAt: "2026-10-27T06:00:00.000Z", entries: [] }];
    const report = buildGrowthReport(input, {}, now);
    expect(report.counts).toMatchObject({ promotions: 1, revisions: 1, completedReviews: 1, methodUses: 2, recalls: { recalled: 0, partial: 1, forgotten: 0 } });
    expect(report.events.filter((event) => event.kind === "review-completed")).toEqual([expect.objectContaining({ at: "2026-10-27T04:00:00.000Z", source: { kind: "captured-review", id: "capture-1" }, sourceId: "other-source", taskId: "task-1", reviewId: "review-1" })]);
    expect(report.events.filter((event) => event.kind === "method-used").map((event) => event.templateId)).toEqual(["aar", "feynman"]);
    expect(report.coverage).toMatchObject({ selectedProjectSourceId: "selected-source", sourceIds: ["other-source", "selected-source"], counts: { capturedReviews: 2, selectedReviews: 1 }, records: { capturedReviews: ["capture-1", "unknown-completion"], selectedReviews: ["uncaptured"] } });
    expect(report.coverage.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unknown-review-completion", recordIds: ["unknown-completion"] }),
      expect.objectContaining({ code: "uncaptured-selected-review", recordIds: ["uncaptured"] }),
    ]));
  });

  // Catches half-open end leakage, cross-period totals, future capture metadata, and legacy fallback dates.
  it("isolates half-open event periods without inventing legacy promotions", () => {
    const input = sample();
    const legacy = structuredClone(input.concepts[0]!); legacy.id = "legacy"; legacy.history = []; delete legacy.timestamps;
    input.concepts.push(legacy);
    input.capturedReviews.push({ ...input.capturedReviews[0]!, id: "future-capture", capturedAt: "2026-11-01T00:00:00.000Z" });
    const report = buildGrowthReport(input, { from: "2026-10-27T03:00:00Z", to: "2026-10-27T05:00:00Z" }, now);
    expect(report.events.map((event) => event.kind)).toEqual(["concept-revised", "method-used", "method-used", "review-completed"]);
    expect(report.counts).toMatchObject({ promotions: 0, revisions: 1, completedReviews: 1, methodUses: 2, recalls: { recalled: 0, partial: 0, forgotten: 0 } });
    expect(report.coverage.gaps).toContainEqual(expect.objectContaining({ code: "unknown-promotion-time", recordIds: ["legacy"] }));
    expect(report.coverage.gaps).toContainEqual(expect.objectContaining({ code: "future-capture", recordIds: ["future-capture"] }));
  });

  // Catches a review ID collision in an unrelated source hiding selected-project missing capture.
  it("matches capture coverage using both review ID and selected source identity", () => {
    const input = sample();
    input.reviews = [{ id: "review-1", taskId: "task-1", level: "quick", selectedBy: "human", status: "completed", phase: "complete", startedAt: "2026-10-27T00:00:00.000Z", entries: [] }];
    expect(buildGrowthReport(input, {}, now).coverage.gaps).toContainEqual(expect.objectContaining({ code: "uncaptured-selected-review", recordIds: ["review-1"] }));
    input.capturedReviews[0]!.sourceId = "selected-source";
    expect(buildGrowthReport(input, {}, now).coverage.gaps.some((gap) => gap.code === "uncaptured-selected-review")).toBe(false);
    delete input.sourceId;
    expect(buildGrowthReport(input, {}, now).coverage.gaps).toContainEqual(expect.objectContaining({ code: "uncaptured-selected-review", recordIds: ["review-1"] }));
  });

  // Catches legacy/latest state being called improvement and same-level/noop inflation.
  it("separates capability baselines, rises, downgrades, and assessments while excluding noop receipts", () => {
    const input = sample();
    const evidence = [{ kind: "explanation" as const, reviewId: "review-1", passed: true }];
    const record = { conceptId: "concept-1", level: "understood" as const, evidence, updatedAt: "2026-10-27T06:00:00.000Z" };
    const base = { conceptId: "concept-1", evidence, at: "2026-10-27T06:00:00.000Z", returnedRecord: record };
    const fields = { ...base, contentFingerprint: "b".repeat(64), input: { conceptId: "concept-1", level: "understood" as const, evidence } };
    input.capabilities = { version: 2, records: [record], history: [
      { ...base, kind: "baseline", operationId: "baseline", previousLevel: null, newLevel: "understood" },
      { ...fields, kind: "transition", operationId: "rise", previousLevel: "understood", newLevel: "explainable" },
      { ...fields, kind: "transition", operationId: "drop", previousLevel: "explainable", newLevel: "understood" },
      { ...fields, kind: "assessment", operationId: "assess", previousLevel: "understood", newLevel: "understood" },
      { ...fields, kind: "noop", operationId: "noop", previousLevel: "understood", newLevel: "understood" },
    ] };
    const report = buildGrowthReport(input, {}, now);
    expect(report.counts).toMatchObject({ capabilityBaselines: 1, capabilityTransitions: 2, capabilityRises: 1, capabilityDowngrades: 1, capabilityAssessments: 1 });
    expect(report.events.filter((event) => event.kind.startsWith("capability-")).map((event) => event.source.id).sort()).toEqual(["assess", "baseline", "drop", "rise"]);
    expect(report.coverage.gaps).toContainEqual(expect.objectContaining({ code: "capability-history-gap", recordIds: ["baseline"] }));
    input.capabilities = { version: 1, records: [record] };
    expect(buildGrowthReport(input, {}, now).counts).toMatchObject({ capabilityBaselines: 1, capabilityTransitions: 0, capabilityRises: 0, capabilityAssessments: 0 });
  });

  // Catches historical period ends being used as the current quality/due clock.
  it("labels current quality/due at generation time and gives actionable existing-rule suggestions", () => {
    const report = buildGrowthReport(sample(), { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" }, now);
    expect(report.events).toEqual([]);
    expect(report.currentQuality).toMatchObject({ asOf: "2026-10-28T09:00:00.000Z", scope: "current-at-generation", items: [{ conceptId: "concept-1", measure: "documentation-and-evidence-quality" }] });
    expect(report.currentDue).toMatchObject({ asOf: "2026-10-28T09:00:00.000Z", scope: "current-at-generation", items: [{ conceptId: "concept-1", isDue: true }] });
    expect(report.nextSuggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "recall", conceptId: "concept-1", action: expect.stringMatching(/recall/i) }),
      expect.objectContaining({ kind: "quality", conceptId: "concept-1", action: expect.any(String) }),
    ]));
    expect(report.nextSuggestions.every((item) => item.action.trim().length > 0)).toBe(true);
  });

  // Catches invented task types/methods and fabricated positive claims for no data.
  it("keeps an empty report honest without inventing task advice", () => {
    const report = buildGrowthReport(empty(), {}, now);
    expect(report.events).toEqual([]);
    expect(report.counts).toMatchObject({ promotions: 0, revisions: 0, completedReviews: 0, methodUses: 0, capabilityRises: 0 });
    expect(report.nextSuggestions).toEqual([]);
    expect(report.coverage.sourceIds).toEqual([]);
    expect(report.coverage.gaps).toContainEqual(expect.objectContaining({ code: "no-source-data" }));
  });
});


it("uses recommendation rules only for real active task metadata without choosing or running a method", () => {
  const input = empty();
  input.tasks = [{ ...task(), id: "active-refactor", status: "active", type: "refactor" }];
  const report = buildGrowthReport(input, {}, now);
  expect(report.nextSuggestions).toContainEqual(expect.objectContaining({ kind: "review", taskId: "active-refactor", recommendation: expect.objectContaining({ suggestedMethod: "kpt", alternatives: [] }) }));
  delete input.tasks[0]!.type;
  expect(buildGrowthReport(input, {}, now).nextSuggestions).toContainEqual(expect.objectContaining({ kind: "review", taskId: "active-refactor", recommendation: expect.objectContaining({ suggestedMethod: null, history: expect.objectContaining({ status: "insufficient-history" }) }) }));
  expect(input.reviews).toEqual([]);
});

it("renders reproducible Markdown with exact bounds, actual source refs, gaps, and current snapshot labels", () => {
  const input = sample();
  input.concepts.push({ ...structuredClone(input.concepts[0]!), id: "a-concept" });
  input.capturedReviews.push({ ...input.capturedReviews[0]!, id: "a-capture", taskId: "task-2", templateIds: ["kpt"] });
  input.observations.push({ ...input.observations[0]!, id: "a-recall" });
  input.tasks = [{ ...task("z-task"), status: "active", type: "refactor" }, { ...task("a-task"), status: "active", type: "implementation" }];
  const before = structuredClone(input);
  const first = buildGrowthReport(input, {}, now);
  const markdown = renderGrowthReport(first);
  expect(markdown).toContain("[2026-10-26T00:00:00.000Z, 2026-10-28T09:00:00.000Z)");
  expect(markdown).toContain("2026-11-02T00:00:00.000Z");
  expect(markdown).toContain("capture-1");
  expect(markdown).toContain("other-source");
  expect(markdown).toMatch(/Current quality.*generation/i);
  expect(markdown).toMatch(/Current due.*generation/i);
  expect(markdown).toMatch(/baseline.*not.*improvement/i);
  expect(markdown).toMatch(/mastery.*causal|causal.*mastery/i);
  expect(input).toEqual(before);
  input.concepts.reverse(); input.capturedReviews.reverse(); input.observations.reverse(); input.tasks.reverse();
  expect(JSON.stringify(buildGrowthReport(input, {}, now))).toBe(JSON.stringify(first));
  expect(renderGrowthReport(buildGrowthReport(input, {}, now))).toBe(markdown);
});

describe("GrowthService real repository facade", () => {
  // Catches implicit filesystem initialization and repeated snapshots/clocks per read.
  it("reads one snapshot and one clock per operation and leaves missing roots untouched", async () => {
    const f = await fixture();
    let clockReads = 0;
    const clock = () => { clockReads++; return new Date("2026-10-28T09:00:00.000Z"); };
    const service = new GrowthService(f.project, f.personal, { clock, id: f.id });
    const read = vi.spyOn(GrowthRepository.prototype, "readSnapshot");
    expect(await service.report()).toMatchObject({ counts: { completedReviews: 0 }, currentDue: { items: [] } });
    expect(await service.quality()).toEqual([]);
    expect(await service.due()).toEqual([]);
    expect(await service.history()).toEqual([]);
    expect(await service.recommend({})).toMatchObject({ suggestedMethod: null, history: { status: "insufficient-history" } });
    expect(clockReads).toBe(5);
    expect(read).toHaveBeenCalledTimes(5);
    expect(await readdir(f.root)).toEqual([]);
  });

  // Catches copied mutation policy, implicit capture, and read-side rewrites.
  it("delegates explicit capture and valid human feedback to existing services", async () => {
    const f = await fixture();
    const concept = sample().concepts[0]!;
    await f.personal.saveConcept(concept);
    await f.project.saveTask(task());
    await f.project.saveReview({ ...review(), completedAt: "2026-10-27T09:00:00.000Z" });
    const service = new GrowthService(f.project, f.personal, { clock: f.clock, id: () => "selected-source" });
    expect((await service.report()).counts.completedReviews).toBe(0);
    await expect(stat(join(f.paths.project.base, "project-identity.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await service.capture()).toMatchObject({ captured: [{ sourceId: "selected-source" }], reused: [] });
    const report = await service.report();
    expect(report.counts.completedReviews).toBe(1);
    const feedback = { kind: "recall", conceptId: "concept-1", revision: report.currentQuality.items[0]!.revision, operationId: "feedback-1", actor: "human", source: "Synthetic human", result: "recalled" } as const;
    expect(await service.record(feedback)).toMatchObject({ reused: false, stale: false, observation: { id: "feedback-1", recordedAt: "2026-10-28T09:00:00.000Z" } });
    expect(await service.record(feedback)).toMatchObject({ reused: true });
    const bytes = await readFile(join(f.paths.personal.base, "growth", "observations", "feedback-1.json"), "utf8");
    expect(await service.due()).toEqual([]);
    expect(await readFile(join(f.paths.personal.base, "growth", "observations", "feedback-1.json"), "utf8")).toBe(bytes);
    // @ts-expect-error Intentional invalid caller input must be rejected at runtime.
    await expect(service.record({ ...feedback, operationId: "bad", actor: "ai" })).rejects.toMatchObject({ code: "INVALID_GROWTH_OBSERVATION" });
    await expect(service.record({ ...feedback, operationId: "stale", revision: "0".repeat(64) })).rejects.toMatchObject({ code: "GROWTH_STALE_CONTENT" });
  });

  // Catches facade bypassing bounded snapshot consistency and returning mixed file versions.
  it("rejects continuously changing real source bytes after bounded snapshot retries", async () => {
    const f = await fixture();
    await f.project.saveTask(task());
    let changes = 0;
    directoryHook.afterList = async (path) => {
      if (path !== f.paths.project.tasks) return;
      await writeFile(join(path, "task-1.json"), JSON.stringify({ ...task(), title: `Changed ${++changes}` }));
    };
    const service = new GrowthService(f.project, f.personal, { clock: f.clock, id: f.id });
    const outcome = await service.report().then(() => "resolved", (error: unknown) => error);
    expect(outcome).toMatchObject({ code: "GROWTH_SOURCE_CHANGED" });
    expect(changes).toBeGreaterThanOrEqual(3);
    await expect(stat(f.paths.personal.base)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("makes an uncaptured legacy review's unknown completion date explicit in coverage", () => {
  const input = empty();
  input.reviews = [review("legacy-review")];
  const report = buildGrowthReport(input, {}, now);
  expect(report.counts.completedReviews).toBe(0);
  expect(report.coverage.gaps).toContainEqual(expect.objectContaining({ code: "unknown-selected-review-completion", recordIds: ["legacy-review"] }));
});


// Catches task-time inference and task closure replacing independently observed review completion dates.
it("reports unknown task completion coverage while retaining review and method facts at their review dates", () => {
  const input = sample(); const known = input.capturedReviews[0]!;
  const missing = { ...known, id: "legacy-missing", taskId: "legacy-task-1" }; delete missing.taskCompletedAt;
  input.capturedReviews.push(missing, { ...known, id: "legacy-null", taskId: "legacy-task-2", taskCompletedAt: null });
  const report = buildGrowthReport(input, {}, now);
  expect(report.counts).toMatchObject({ completedReviews: 3, methodUses: 6 });
  expect(report.events.filter((event) => event.kind === "review-completed").every((event) => event.at === "2026-10-27T04:00:00.000Z")).toBe(true);
  expect(report.events.filter((event) => event.kind === "method-used").every((event) => event.at === "2026-10-27T04:00:00.000Z")).toBe(true);
  expect(report.coverage.gaps.filter((gap) => gap.code === "unknown-task-completion").map((gap) => gap.recordIds)).toEqual([["legacy-missing"], ["legacy-null"]]);
  expect(report.coverage.gaps.some((gap) => gap.code === "unknown-task-completion" && gap.recordIds.includes("capture-1"))).toBe(false);
});
