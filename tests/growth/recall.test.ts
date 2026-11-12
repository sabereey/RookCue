import { readdir, readFile, rm, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConceptRecord } from "../../src/domain/schema.js";
import { contentFingerprint, type GrowthObservation, type GrowthSnapshot } from "../../src/growth/schema.js";
import { GrowthRepository } from "../../src/growth/repository.js";
import { deriveDueQueue, RecallService } from "../../src/growth/recall.js";
import { cleanupFixtures, fixture } from "./fixtures.js";

afterEach(cleanupFixtures);
const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T09:00:00.000Z`;
function concept(change: Partial<ConceptRecord> = {}): ConceptRecord {
  return { id: "concept-1", reviewId: "review-1", taskId: "task-1", ordinal: 1,
    principle: "Synthetic principle", boundary: "Synthetic boundary", status: "approved", confidence: 0.5,
    reviewedAt: at(20), evidence: [{ kind: "task", id: "task-1" }], history: [],
    timestamps: { candidateCreatedAt: at(19), approvedAt: at(20), promotedAt: at(20) }, ...change };
}
function snapshot(concepts = [concept()], observations: GrowthObservation[] = []): GrowthSnapshot {
  return { concepts, observations, capabilities: { version: 1, records: [] }, capturedReviews: [], decisionReceipts: [],
    personalReviewStates: [], tasks: [], reviews: [], checkpoints: [], events: [], projectRoot: "/synthetic" };
}
function recall(day: number, result: "recalled" | "partial" | "forgotten", id = `op-${day}`): Extract<GrowthObservation, { kind: "recall" }> {
  return { version: 1, id, kind: "recall", result, conceptId: "concept-1", contentFingerprint: contentFingerprint(concept()),
    recordedAt: at(day), actor: "human", source: "Synthetic human" };
}
function edit(before: ConceptRecord, day: number) {
  return { principle: before.principle, boundary: before.boundary, confidence: before.confidence, status: before.status,
    reviewedAt: before.reviewedAt, evidence: before.evidence, recordedAt: at(day), summary: "Synthetic edit" };
}
const input = () => ({ kind: "recall" as const, conceptId: "concept-1", revision: contentFingerprint(concept()),
  operationId: "operation-1", actor: "human" as const, source: "Synthetic human", result: "recalled" as const });
async function setup() {
  const f = await fixture();
  await f.personal.saveConcept(concept());
  const repository = new GrowthRepository(f.project, f.personal, { clock: f.clock, id: f.id });
  return { ...f, repository, service: new RecallService(repository, { clock: f.clock }) };
}

describe("voluntary due queue", () => {
  it("uses promotion plus one UTC day and includes the exact due boundary", () => {
    expect(deriveDueQueue(snapshot(), new Date(at(21)))[0]).toMatchObject({ conceptId: "concept-1",
      revision: contentFingerprint(concept()), dueAt: at(21), isDue: true, intervalDays: 1, reason: "promotion" });
    expect(deriveDueQueue(snapshot(), new Date(at(20)))[0]?.isDue).toBe(false);
  });
  it("makes unknown promotion and revised content visible for a baseline without inventing a date", () => {
    const unknown = concept(); delete unknown.timestamps;
    expect(deriveDueQueue(snapshot([unknown]), new Date(at(28)))[0]).toMatchObject({ dueAt: null, isDue: true, reason: "needs-baseline" });
    const revised = concept({ principle: "Changed", history: [edit(concept(), 25)] });
    expect(deriveDueQueue(snapshot([revised], [recall(24, "recalled")]), new Date(at(28)))[0]).toMatchObject({ dueAt: null, reason: "needs-baseline" });
  });
  it.each([
    [[recall(21, "recalled")], 3, at(24)],
    [[recall(21, "recalled"), recall(22, "recalled")], 7, at(29)],
    [[recall(21, "recalled"), recall(22, "recalled"), recall(23, "recalled")], 14, "2026-11-06T09:00:00.000Z"],
    [[recall(21, "recalled"), recall(22, "recalled"), recall(23, "recalled"), recall(24, "recalled"), recall(25, "recalled")], 30, "2026-11-24T09:00:00.000Z"],
    [[recall(21, "recalled"), recall(22, "partial")], 3, at(25)],
    [[recall(21, "recalled"), recall(22, "forgotten")], 1, at(23)],
    [[recall(21, "partial")], 1, at(22)],
  ])("schedules human outcomes %j", (events, intervalDays, dueAt) => {
    expect(deriveDueQueue(snapshot([concept()], events), new Date(at(28)))[0]).toMatchObject({ intervalDays, dueAt });
  });
  it("lets resume and later recall supersede deferral without claiming recall", () => {
    const base = recall(21, "recalled"); const { result, ...fields } = base;
    const defer: GrowthObservation = { ...fields, id: "defer", kind: "defer", recordedAt: at(22), until: at(30) };
    const resume: GrowthObservation = { ...fields, id: "resume", kind: "resume", recordedAt: at(23) };
    expect(deriveDueQueue(snapshot([concept()], [base, defer]), new Date(at(28)))[0]).toMatchObject({ dueAt: at(30), isDue: false, intervalDays: 3, reason: "deferred" });
    expect(deriveDueQueue(snapshot([concept()], [base, defer, resume]), new Date(at(28)))[0]).toMatchObject({ dueAt: at(24), intervalDays: 3 });
    expect(deriveDueQueue(snapshot([concept()], [base, defer, recall(23, "partial")]), new Date(at(28)))[0]).toMatchObject({ dueAt: at(26), intervalDays: 3 });
  });
  it("requires a baseline when old feedback proves changed wording but edit history is unavailable", () => {
    expect(deriveDueQueue(snapshot([concept({ principle: "Imported revised wording" })], [recall(24, "recalled")]), new Date(at(28)))[0]).toMatchObject({
      dueAt: null, reason: "needs-baseline", isDue: true,
    });
  });
  it("does not reset confidence changes but resets wording away and back at the latest edit", () => {
    const confidence = concept({ confidence: 0.9, history: [edit(concept(), 25)] });
    expect(deriveDueQueue(snapshot([confidence], [recall(24, "recalled")]), new Date(at(28)))[0]?.intervalDays).toBe(3);
    const away = concept({ principle: "Different" });
    const restored = concept({ history: [edit(concept(), 23), edit(away, 25)] });
    expect(deriveDueQueue(snapshot([restored], [recall(24, "recalled")]), new Date(at(28)))[0]?.reason).toBe("needs-baseline");
    expect(deriveDueQueue(snapshot([restored], [recall(24, "recalled"), recall(26, "partial")]), new Date(at(28)))[0]).toMatchObject({ intervalDays: 1, dueAt: at(27) });
  });
  it("ignores future observations and promotion dates with disclosed warnings", () => {
    const row = deriveDueQueue(snapshot([concept()], [recall(29, "recalled")]), new Date(at(28)))[0]!;
    expect(row).toMatchObject({ dueAt: at(21), intervalDays: 1 }); expect(row.warnings.length).toBeGreaterThan(0);
    expect(deriveDueQueue(snapshot([concept({ timestamps: { candidateCreatedAt: at(29), approvedAt: at(29), promotedAt: at(29) } })]), new Date(at(28)))[0]).toMatchObject({ dueAt: null, reason: "needs-baseline", warnings: expect.arrayContaining([expect.any(String)]) });
  });
  it("retains current matching recall when promotion is a future clock-skew timestamp", () => {
    const skewed = concept({ timestamps: { candidateCreatedAt: at(29), approvedAt: at(29), promotedAt: at(29) } });
    expect(deriveDueQueue(snapshot([skewed], [recall(28, "recalled")]), new Date(at(28)))[0]).toMatchObject({
      reason: "recalled", dueAt: at(31), intervalDays: 3, isDue: false,
      warnings: ["Promotion date is in the future; ignored for scheduling."],
    });
  });
  it("collapses simultaneous recalls conservatively without two advances and discloses contradictions", () => {
    const events = [recall(21, "recalled", "z"), recall(21, "forgotten", "a")];
    const row = deriveDueQueue(snapshot([concept()], events), new Date(at(28)))[0]!;
    expect(row).toMatchObject({ dueAt: at(22), intervalDays: 1 }); expect(row.warnings.length).toBeGreaterThan(0);
    expect(deriveDueQueue(snapshot([concept()], events.reverse()), new Date(at(28)))).toEqual([row]);
    expect(deriveDueQueue(snapshot([concept()], [recall(21, "recalled", "a"), recall(21, "recalled", "z")]), new Date(at(28)))[0]?.intervalDays).toBe(3);
  });
  it("prefers actionable scheduling for simultaneous defer/recall or defer/resume conflicts", () => {
    const { result, ...fields } = recall(21, "recalled");
    const defer: GrowthObservation = { ...fields, id: "z", kind: "defer", until: at(30) };
    const resume: GrowthObservation = { ...fields, id: "a", kind: "resume" };
    expect(deriveDueQueue(snapshot([concept()], [recall(21, "forgotten"), defer]), new Date(at(28)))[0]).toMatchObject({ dueAt: at(22), warnings: expect.arrayContaining([expect.any(String)]) });
    expect(deriveDueQueue(snapshot([concept()], [resume, defer]), new Date(at(28)))[0]).toMatchObject({ dueAt: at(21), warnings: expect.arrayContaining([expect.any(String)]) });
  });
  it("orders and groups equivalent ISO instants independent of fractional spelling", () => {
    const first = { ...recall(21, "recalled", "z"), recordedAt: "2026-10-21T09:00:00Z" };
    const contradiction = recall(21, "forgotten", "a");
    expect(deriveDueQueue(snapshot([concept()], [first, contradiction]), new Date(at(28)))[0]).toMatchObject({
      intervalDays: 1, dueAt: at(22), warnings: expect.arrayContaining([expect.any(String)]),
    });
  });
  it("excludes obsolete/missing concepts and sorts baseline first then due timestamp and ID", () => {
    const unknown = concept({ id: "z-baseline" }); delete unknown.timestamps;
    const s = snapshot([concept({ id: "z" }), concept({ id: "a" }), unknown, concept({ id: "obsolete", status: "obsolete" })], [recall(21, "recalled")]);
    expect(deriveDueQueue(s, new Date(at(28))).map((row) => row.conceptId)).toEqual(["z-baseline", "a", "z"]);
  });
  it("does not create files when reading empty roots", async () => {
    const f = await fixture();
    const repository = new GrowthRepository(f.project, f.personal, { clock: f.clock, id: f.id });
    expect(deriveDueQueue(await repository.readSnapshot(), f.clock())).toEqual([]);
    expect(await readdir(f.root)).toEqual([]);
  });
});

describe("human feedback mutation", () => {
  it("persists one immutable observation using only the injected timestamp, preserving concept and capability", async () => {
    const f = await setup(); const before = await readFile(join(f.paths.personal.concepts, "concept-1.json"), "utf8");
    const first = await f.service.record(input());
    expect(first).toMatchObject({ reused: false, stale: false, observation: { id: "operation-1", recordedAt: at(28), contentFingerprint: input().revision, actor: "human", result: "recalled" } });
    f.setTime(at(29)); expect(await f.service.record(input())).toEqual({ ...first, reused: true });
    expect(await readdir(f.repository.observationDirectory)).toEqual(["operation-1.json"]);
    expect(await readFile(join(f.paths.personal.concepts, "concept-1.json"), "utf8")).toBe(before);
    expect((await f.repository.readSnapshot()).capabilities).toEqual({ version: 1, records: [] });
  });
  it("schedules valid feedback recorded at the same clock instant as its content edit, including reload", async () => {
    const f = await setup(); const revised = concept({ principle: "Revised principle", history: [edit(concept(), 28)] });
    await f.personal.saveConcept(revised);
    const logical = { ...input(), revision: contentFingerprint(revised) };
    const first = await f.service.record(logical);
    expect(first.stale).toBe(false);
    const reloaded = new GrowthRepository(f.project, f.personal, { clock: f.clock, id: f.id });
    expect(deriveDueQueue(await reloaded.readSnapshot(), f.clock())[0]).toMatchObject({
      reason: "recalled", dueAt: at(31), intervalDays: 3, isDue: false,
      warnings: expect.arrayContaining([expect.any(String)]),
    });
    expect(await new RecallService(reloaded, { clock: f.clock }).record(logical)).toEqual({ ...first, reused: true });
  });
  it.each(["changed", "obsolete", "missing", "restored"])("replays the historical operation after %s content while disclosing stale", async (mode) => {
    const f = await setup(); const first = await f.service.record(input());
    if (mode === "missing") await rm(join(f.paths.personal.concepts, "concept-1.json"));
    else await f.personal.saveConcept(concept(mode === "changed" ? { principle: "Changed" } : mode === "obsolete" ? { status: "obsolete" } : { history: [edit(concept(), 29), edit(concept({ principle: "Away" }), 30)] }));
    f.setTime("2026-11-01T09:00:00.000Z");
    expect(await f.service.record(input())).toEqual({ ...first, reused: true, stale: true });
    expect(await readdir(f.repository.observationDirectory)).toEqual(["operation-1.json"]);
    await expect(f.service.record({ ...input(), result: "forgotten" })).rejects.toMatchObject({ code: "GROWTH_OPERATION_CONFLICT" });
  });
  it("treats omitted and empty evidence as the same no-evidence logical operation", async () => {
    const f = await setup(); const first = await f.service.record(input());
    expect(await f.service.record({ ...input(), evidence: [] })).toEqual({ ...first, reused: true });
    await expect(f.service.record({ ...input(), evidence: [{ kind: "task", id: "task-1" }] })).rejects.toMatchObject({ code: "GROWTH_OPERATION_CONFLICT" });
  });
  it("allows an exact defer replay after its deadline but rejects a new elapsed defer", async () => {
    const f = await setup(); const { result, ...base } = input();
    const deferred = { ...base, kind: "defer" as const, until: at(29) };
    const first = await f.service.record(deferred); f.setTime(at(30));
    expect(await f.service.record(deferred)).toEqual({ ...first, reused: true });
    await expect(f.service.record({ ...deferred, operationId: "new" })).rejects.toMatchObject({ code: "INVALID_GROWTH_OBSERVATION" });
  });
  it("replays equivalent ISO deferral deadlines as the same logical input", async () => {
    const f = await setup(); const { result, ...base } = input();
    const first = await f.service.record({ ...base, kind: "defer", until: "2026-10-29T09:00:00Z" });
    expect(await f.service.record({ ...base, kind: "defer", until: at(29) })).toEqual({ ...first, reused: true });
  });
  it("writes strict defer and resume variants without recall results", async () => {
    const f = await setup(); const { result, ...base } = input();
    expect((await f.service.record({ ...base, kind: "defer", until: at(29) })).observation).toMatchObject({ kind: "defer", until: at(29) });
    expect((await f.service.record({ ...base, operationId: "resume", kind: "resume" })).observation).not.toHaveProperty("result");
  });
  it.each([{ actor: "ai" }, { source: " " }, { operationId: "../bad" }, { conceptId: "/bad" }, { revision: "bad" },
    { recordedAt: at(10) }, { kind: "recall", until: at(30) }, { kind: "resume", result: "recalled" },
    { kind: "defer", result: undefined, until: "invalid" }, { kind: "defer", result: undefined, until: at(28) },
    { evidence: [{ kind: "task", id: "../bad" }] }, { evidence: [{ kind: "task", id: "ok", unknown: true }] },
  ])("rejects malformed or backdated logical input without observation writes: %j", async (change) => {
    const f = await setup();
    await expect(f.service.record({ ...input(), ...change } as never)).rejects.toMatchObject({ code: "INVALID_GROWTH_OBSERVATION" });
    expect((await f.repository.readSnapshot()).observations).toEqual([]);
  });
  it.each(["changed", "obsolete", "missing"])("rejects a new operation against %s current content", async (mode) => {
    const f = await setup();
    if (mode === "missing") await rm(join(f.paths.personal.concepts, "concept-1.json"));
    else await f.personal.saveConcept(concept(mode === "changed" ? { principle: "Changed" } : { status: "obsolete" }));
    await expect(f.service.record(input())).rejects.toMatchObject({ code: "GROWTH_STALE_CONTENT" });
    expect((await f.repository.readSnapshot()).observations).toEqual([]);
  });
  it("serializes concurrent exact retries and conflicts under the personal lock", async () => {
    const f = await setup(); const service2 = new RecallService(f.repository, { clock: f.clock });
    const results = await Promise.all([f.service.record(input()), service2.record(input())]);
    expect(results.map((row) => row.reused).sort()).toEqual([false, true]);
    const conflict = await Promise.allSettled([f.service.record({ ...input(), operationId: "second" }), service2.record({ ...input(), operationId: "second", result: "forgotten" })]);
    expect(conflict.map((row) => row.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await f.repository.readSnapshot()).observations).toHaveLength(2);
  });
  it("rejects an invalid injected clock before observation writes", async () => {
    const f = await setup(); const service = new RecallService(f.repository, { clock: () => new Date("invalid") });
    await expect(service.record(input())).rejects.toMatchObject({ code: "INVALID_GROWTH_OBSERVATION" });
    expect((await f.repository.readSnapshot()).observations).toEqual([]);
  });
  it("rejects personal root symlinks before creating a lock through them", async () => {
    const f = await fixture(); const outside = join(f.root, "outside"); await mkdir(outside);
    await symlink(outside, f.paths.personal.base);
    const repository = new GrowthRepository(f.project, f.personal, { clock: f.clock, id: f.id });
    await expect(new RecallService(repository, { clock: f.clock }).record(input())).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readdir(outside)).toEqual([]);
  });
});
