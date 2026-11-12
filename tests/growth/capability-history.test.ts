import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { capabilityRecordSchema, capabilityStateSchema, type CapabilityEvidence, type ConceptRecord } from "../../src/domain/schema.js";
import { KnowledgeService } from "../../src/personal/knowledge-service.js";
import { PersonalRepository } from "../../src/storage/personal-repository.js";
import { GrowthRepository } from "../../src/growth/repository.js";
import { capabilityHistory } from "../../src/growth/capability-history.js";
import { cleanupFixtures, fixture, review, task } from "./fixtures.js";

afterEach(cleanupFixtures);
const at = "2026-10-27T09:00:00.000Z";
const a: CapabilityEvidence[] = [{ kind: "explanation", reviewId: "review-1", passed: true }];
const b: CapabilityEvidence[] = [{ kind: "transfer", reviewId: "review-1", passed: true }];
async function setup(makePersonal?: (f: Awaited<ReturnType<typeof fixture>>) => PersonalRepository, conceptId = "concept-1") {
  const f = await fixture();
  const personal = makePersonal?.(f) ?? f.personal;
  await f.project.saveTask(task());
  await f.project.saveReview({ ...review(), entries: [
    { id: "entry-1", actor: "human", kind: "response", content: "A synthetic explanation", at, evidence: [] },
    { id: "entry-2", actor: "human", kind: "transfer-answer", content: "A synthetic transfer", at, evidence: [] },
  ] });
  const concept: ConceptRecord = { id: conceptId, reviewId: "review-1", taskId: "task-1", ordinal: 1, principle: "Preserve proof", boundary: "Within reviewed tasks", evidence: [{ kind: "task", id: "task-1" }], status: "approved", confidence: .8, reviewedAt: at, history: [] };
  await personal.saveConcept(concept);
  let generated = 0;
  const service = new KnowledgeService(personal, f.project, { clock: f.clock, id: () => `op-${++generated}` });
  const growth = new GrowthRepository(f.project, personal, { clock: f.clock, id: f.id });
  return { ...f, personal, service, growth, concept, generated: () => generated };
}
const legacy = (conceptId = "concept-1") => ({ version: 1 as const, records: [{ conceptId, level: "understood" as const, evidence: a, updatedAt: at }] });

describe("atomic capability history", () => {
  it("reads legacy bytes unchanged and exposes honest unknown baseline history", async () => {
    const f = await setup();
    await f.personal.saveCapabilities(legacy());
    const before = await readFile(f.paths.personal.capabilities, "utf8");
    const snapshot = await f.growth.readSnapshot();
    expect(snapshot.capabilities).toEqual(legacy());
    expect(capabilityHistory(snapshot)).toMatchObject([{ kind: "baseline", newLevel: "understood", warnings: ["history-gap", "unknown-content"] }]);
    expect(capabilityHistory(snapshot)[0]?.contentFingerprint).toBeUndefined();
    expect(await readFile(f.paths.personal.capabilities, "utf8")).toBe(before);
  });

  it("seeds all baselines once and distinguishes rises, downgrades and same-level assessments", async () => {
    const f = await setup();
    await f.personal.saveCapabilities({ version: 1, records: [...legacy().records, ...legacy("missing-concept").records] });
    await f.service.updateCapability(f.concept.id, { level: "explainable", evidence: a });
    await f.service.updateCapability(f.concept.id, { level: "understood", evidence: a });
    await f.service.updateCapability(f.concept.id, { level: "understood", evidence: b });
    const state = await f.personal.readCapabilities();
    expect(state).toMatchObject({ version: 2, history: [
      { kind: "baseline", conceptId: "concept-1", at, newLevel: "understood" },
      { kind: "baseline", conceptId: "missing-concept", at },
      { kind: "transition", previousLevel: "understood", newLevel: "explainable" },
      { kind: "transition", previousLevel: "explainable", newLevel: "understood" },
      { kind: "assessment", previousLevel: "understood", newLevel: "understood" },
    ] });
    const bytes = await readFile(f.paths.personal.capabilities, "utf8");
    await f.service.updateCapability(f.concept.id, { level: "understood", evidence: b });
    expect(await readFile(f.paths.personal.capabilities, "utf8")).toBe(bytes);
    expect(f.generated()).toBe(3);
    const views = capabilityHistory(await f.growth.readSnapshot());
    expect(views.find((v) => v.conceptId === "missing-concept")?.warnings).toContain("missing-concept");
  });

  it("replays explicit IDs before changed, obsolete or deleted concept/evidence lookup", async () => {
    const f = await setup();
    const input = { level: "explainable" as const, evidence: a, operationId: "first", rationale: "Human assessment" };
    const original = await f.service.updateCapability(f.concept.id, input);
    f.setTime("2026-10-28T10:00:00.000Z");
    await f.service.updateCapability(f.concept.id, { level: "seen", evidence: b, operationId: "second" });
    await f.personal.saveConcept({ ...f.concept, principle: "Changed", status: "obsolete" });
    expect(await f.service.updateCapability(f.concept.id, input)).toEqual(original);
    await rm(join(f.paths.personal.concepts, `${f.concept.id}.json`));
    await rm(join(f.paths.project.reviews, "review-1.json"));
    expect(await f.service.updateCapability(f.concept.id, input)).toEqual(original);
    expect((await f.personal.readCapabilities()).records[0]?.level).toBe("seen");
    for (const change of [{ level: "seen" }, { evidence: b }, { rationale: "Different" }]) {
      await expect(f.service.updateCapability(f.concept.id, { ...input, ...change } as typeof input)).rejects.toMatchObject({ code: "CAPABILITY_OPERATION_CONFLICT" });
    }
    await expect(f.service.updateCapability("other", input)).rejects.toMatchObject({ code: "CAPABILITY_OPERATION_CONFLICT" });
  });

  it("persists explicit no-op receipts without changing record time or counting an assessment", async () => {
    const f = await setup();
    const first = await f.service.updateCapability(f.concept.id, { level: "understood", evidence: a });
    f.setTime("2026-10-28T10:00:00.000Z");
    const input = { level: "understood" as const, evidence: a, operationId: "noop-id" };
    expect(await f.service.updateCapability(f.concept.id, input)).toEqual(first);
    expect(await f.personal.readCapabilities()).toMatchObject({ version: 2, history: [{ kind: "assessment" }, { kind: "noop", returnedRecord: first }] });
    expect(capabilityHistory(await f.growth.readSnapshot())).toHaveLength(1);
    await f.service.updateCapability(f.concept.id, { level: "seen", evidence: b });
    expect(await f.service.updateCapability(f.concept.id, input)).toEqual(first);
    expect((await f.personal.readCapabilities()).records[0]?.level).toBe("seen");
    await expect(f.service.updateCapability(f.concept.id, { ...input, evidence: b })).rejects.toMatchObject({ code: "CAPABILITY_OPERATION_CONFLICT" });
    expect(capabilityHistory(await f.growth.readSnapshot())).toHaveLength(2);
  });

  it("assesses unknown legacy content and revised wording without fabricating improvement", async () => {
    const f = await setup(undefined, "c".repeat(160));
    await f.personal.saveCapabilities(legacy(f.concept.id));
    await f.service.updateCapability(f.concept.id, { level: "understood", evidence: a, operationId: "current" });
    await f.personal.saveConcept({ ...f.concept, boundary: "Revised boundary" });
    await f.service.updateCapability(f.concept.id, { level: "understood", evidence: a });
    const views = capabilityHistory(await f.growth.readSnapshot(), f.concept.id);
    expect(views.map((v) => v.kind)).toEqual(["baseline", "assessment", "assessment"]);
    expect(views[1]?.warnings).toContain("stale-content");
    expect(views[2]?.warnings).not.toContain("stale-content");
    await f.personal.saveConcept({ ...f.concept, status: "obsolete" });
    await expect(f.service.updateCapability(f.concept.id, { level: "seen", evidence: a })).rejects.toMatchObject({ code: "CONCEPT_OBSOLETE" });
    expect(capabilityHistory(await f.growth.readSnapshot())[0]?.warnings).toContain("obsolete-concept");
  });

  it.each(["before", "after"] as const)("keeps current/history atomic when save fails %s commit and retries once", async (phase) => {
    const f = await setup((base) => new class extends PersonalRepository {
      failed = false;
      override async saveCapabilities(state: Parameters<PersonalRepository["saveCapabilities"]>[0]) {
        if (phase === "after") await super.saveCapabilities(state);
        if (!this.failed) { this.failed = true; throw new Error("interrupted save"); }
        if (phase === "before") await super.saveCapabilities(state);
      }
    }(base.paths));
    const input = { level: "understood" as const, evidence: a, operationId: "atomic-op" };
    await expect(f.service.updateCapability(f.concept.id, input)).rejects.toThrow("interrupted save");
    expect(await f.personal.readCapabilities()).toMatchObject(phase === "before" ? { version: 1, records: [] } : { version: 2, records: [{ level: "understood" }], history: [{ operationId: "atomic-op" }] });
    await f.service.updateCapability(f.concept.id, input);
    expect(await f.personal.readCapabilities()).toMatchObject({ version: 2, history: [{ operationId: "atomic-op" }] });
  });

  it("serializes simultaneous independent repository writers without dropping assessments", async () => {
    const f = await setup();
    const other = new KnowledgeService(new PersonalRepository(f.paths), f.project, { clock: f.clock, id: f.id });
    await Promise.all([
      f.service.updateCapability(f.concept.id, { level: "understood", evidence: a, operationId: "one" }),
      other.updateCapability(f.concept.id, { level: "seen", evidence: b, operationId: "two" }),
    ]);
    const views = capabilityHistory(await f.growth.readSnapshot());
    expect(views).toHaveLength(2);
    expect(new Set(views.map((v) => v.operationId))).toEqual(new Set(["one", "two"]));
    expect((await f.personal.readCapabilities()).records[0]?.level).toBe(views[1]?.newLevel);
  });

  it("rejects unsafe IDs, unknown versions and unknown v2 fields instead of discarding history", async () => {
    const f = await setup();
    await expect(f.service.updateCapability(f.concept.id, { level: "seen", evidence: a, operationId: "../bad" })).rejects.toMatchObject({ code: "INVALID_CAPABILITY_UPDATE" });
    await f.service.updateCapability(f.concept.id, { level: "seen", evidence: a });
    const state = await f.personal.readCapabilities();
    expect(capabilityStateSchema.safeParse({ ...state, extra: true }).success).toBe(false);
    expect(capabilityStateSchema.safeParse({ ...state, version: 3 }).success).toBe(false);
    const oldWriterSchema = z.object({ version: z.literal(1), records: z.array(capabilityRecordSchema).default([]) });
    expect(oldWriterSchema.safeParse(state).success).toBe(false);
  });

  it("rejects unknown nested v2 fields and retains unsupported-version bytes on mutation", async () => {
    const f = await setup();
    await f.service.updateCapability(f.concept.id, { level: "seen", evidence: a });
    const state = JSON.parse(await readFile(f.paths.personal.capabilities, "utf8"));
    state.history[0].evidence[0].futureProof = true;
    expect(capabilityStateSchema.safeParse(state).success).toBe(false);
    const unsupported = JSON.stringify({ version: 9, records: [], futureHistory: ["retain"] });
    await writeFile(f.paths.personal.capabilities, unsupported);
    await expect(f.service.updateCapability(f.concept.id, { level: "understood", evidence: a })).rejects.toThrow();
    expect(await readFile(f.paths.personal.capabilities, "utf8")).toBe(unsupported);
  });

  it("flags a current record which has no matching latest historical assessment", async () => {
    const f = await setup();
    await f.service.updateCapability(f.concept.id, { level: "seen", evidence: a });
    const snapshot = await f.growth.readSnapshot();
    snapshot.capabilities.records[0]!.level = "understood";
    expect(capabilityHistory(snapshot)[0]?.warnings).toContain("history-gap");
  });

  it.each(["root", "lock", "concept", "review"] as const)("rejects a symlinked %s before writing capabilities", async (target) => {
    const f = await setup();
    const outside = join(f.root, "outside");
    if (target === "root") {
      await mkdir(outside);
      await rm(f.paths.personal.base, { recursive: true });
      await symlink(outside, f.paths.personal.base);
    } else if (target === "lock") {
      await mkdir(outside);
      await symlink(outside, join(f.paths.personal.base, ".mutation.lock"));
    } else {
      const path = target === "concept" ? join(f.paths.personal.concepts, `${f.concept.id}.json`) : join(f.paths.project.reviews, "review-1.json");
      await writeFile(outside, await readFile(path));
      await rm(path);
      await symlink(outside, path);
    }
    await expect(f.service.updateCapability(f.concept.id, { level: "seen", evidence: a })).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(readFile(f.paths.personal.capabilities)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinked capability files before consuming or overwriting an external target", async () => {
    const f = await setup();
    const outside = join(f.root, "external.json");
    await writeFile(outside, JSON.stringify(legacy()));
    await mkdir(f.paths.personal.base, { recursive: true });
    await symlink(outside, f.paths.personal.capabilities);
    await expect(f.service.updateCapability(f.concept.id, { level: "seen", evidence: a })).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(JSON.parse(await readFile(outside, "utf8"))).toEqual(legacy());
  });
});
