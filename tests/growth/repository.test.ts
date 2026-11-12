import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePaths } from "../../src/storage/paths.js";
import { recommendGrowth } from "../../src/growth/recommendation.js";
import { GrowthRepository } from "../../src/growth/repository.js";
import { ProjectRepository } from "../../src/storage/project-repository.js";
import { cleanupFixtures, fixture, review, task } from "./fixtures.js";

// Only timing/failure boundaries are intercepted: all directory reads, bytes,
// writes and atomic renames still use the real filesystem.
const directoryHook = vi.hoisted(() => ({
  afterList: undefined as undefined | ((path: string) => Promise<void>),
  beforeRename: undefined as undefined | ((destination: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
    readdir: async (path: string, ...args: unknown[]) => {
      const result = await (actual.readdir as Function)(path, ...args);
      await directoryHook.afterList?.(path);
      return result;
    },
    rename: async (source: string, destination: string) => {
      await directoryHook.beforeRename?.(destination);
      return actual.rename(source, destination);
    },
  };
});
afterEach(async () => { directoryHook.afterList = undefined; directoryHook.beforeRename = undefined; await cleanupFixtures(); });

describe("growth source metadata", () => {
  it("preserves explicit task type and concept relationships through start and reload", async () => {
    const f = await fixture();
    const started = await f.projectService.startTask({ title: "Synthetic task", goal: "Keep metadata",
      type: "debugging", conceptIds: ["concept-1", "concept-2"] });
    expect(await new ProjectRepository(f.paths).readTask(started.id)).toMatchObject({
      type: "debugging", conceptIds: ["concept-1", "concept-2"],
    });
  });

  it("keeps explicit template identity and timestamps actual review completion", async () => {
    const f = await fixture();
    await f.project.saveTask(task());
    const started = await f.reviewService.start({ taskId: "task-1", level: "quick", selectedBy: "human" });
    await f.reviewService.addEntry(started.id, { actor: "human", kind: "decision", content: "Choose quick", evidence: [] });
    await f.reviewService.advance(started.id);
    const entry = await f.reviewService.addEntry(started.id, {
      actor: "human", kind: "response", content: "Synthetic private answer", evidence: [], templateId: "aar",
    });
    f.setTime("2026-10-28T10:00:00.000Z");
    await f.reviewService.advance(started.id);
    expect(await new ProjectRepository(f.paths).readReview(started.id)).toMatchObject({
      completedAt: "2026-10-28T10:00:00.000Z", status: "completed",
      entries: expect.arrayContaining([expect.objectContaining({ templateId: "aar" })]),
    });
  });

  it("retains template identity on a newly added entry", async () => {
    const f = await fixture();
    await f.project.saveTask(task());
    const started = await f.reviewService.start({ taskId: "task-1", level: "quick", selectedBy: "human" });
    const entry = await f.reviewService.addEntry(started.id, {
      actor: "human", kind: "decision", content: "Choose aar", evidence: [], templateId: "aar",
    });
    expect(entry).toMatchObject({ templateId: "aar" });
  });

  it("enumerates all task and review files rather than only latest state entries", async () => {
    const f = await fixture();
    await f.project.saveTask(task("task-2"));
    await f.project.saveTask(task("task-1"));
    await f.project.saveReview(review("review-2"));
    await f.project.saveReview(review("review-1"));
    expect((await f.project.listTasks()).map((row) => row.id)).toEqual(["task-1", "task-2"]);
    expect((await f.project.listReviews()).map((row) => row.id)).toEqual(["review-1", "review-2"]);
  });
});

async function growth(f: Awaited<ReturnType<typeof fixture>>) {
  return new GrowthRepository(f.project, f.personal, { clock: f.clock, id: f.id });
}

describe("growth durable capture", () => {
  it("reads absent roots without creating files or locks", async () => {
    const f = await fixture();
    const repository = await growth(f);
    expect(await repository.readSnapshot()).toMatchObject({ concepts: [], observations: [], capturedReviews: [],
      tasks: [], reviews: [], checkpoints: [], events: [], decisionReceipts: [], personalReviewStates: [],
      capabilities: { version: 1, records: [] } });
    expect(await readdir(f.root)).toEqual([]);
  });

  it("captures completed reviews minimally and preserves capturedAt across a later retry", async () => {
    const f = await fixture();
    await f.project.saveTask({ ...task(), type: "research", conceptIds: ["concept-1"] });
    await f.project.saveReview({ ...review(), completedAt: "2026-10-27T09:00:00.000Z",
      recommendation: { level: "quick", score: 1, reasons: [], signals: ["ai-heavy"] },
      entries: [{ id: "entry-1", actor: "human", kind: "response", content: "Private synthetic transcript /secret/path",
        at: "2026-10-27T09:00:00.000Z", evidence: [], templateId: "aar" }] });
    await f.project.saveReview({ ...review("interrupted"), status: "interrupted", phase: "correct" });
    const repository = await growth(f);
    const result = await repository.capture();
    expect(result.reused).toEqual([]);
    expect(result.captured).toHaveLength(1);
    expect(result.captured[0]).toMatchObject({ version: 1, taskType: "research", conceptIds: ["concept-1"],
      signals: ["ai-heavy"], templateIds: ["aar"], completedAt: "2026-10-27T09:00:00.000Z",
      capturedAt: "2026-10-28T09:00:00.000Z" });
    const record = result.captured[0]!;
    const raw = await readFile(join(f.paths.personal.base, "growth/reviews", `${record.id}.json`), "utf8");
    expect(raw).not.toContain("Private synthetic transcript");
    expect(raw).not.toContain("/secret/path");
    expect(raw).not.toContain(f.root);
    f.setTime("2026-10-29T09:00:00.000Z");
    expect(await repository.capture()).toEqual({ captured: [], reused: [record.id], skipped: [] });
    expect((await repository.readSnapshot()).capturedReviews[0]?.capturedAt).toBe("2026-10-28T09:00:00.000Z");
    expect(await readFile(join(f.paths.personal.base, "growth/reviews", `${record.id}.json`), "utf8")).toBe(raw);
  });

  it("marks legacy completion as unknown and never infers it from capture or start", async () => {
    const f = await fixture();
    await f.project.saveTask(task());
    await f.project.saveReview(review());
    const result = await (await growth(f)).capture();
    expect(result.captured[0]).toMatchObject({ taskType: "general", conceptIds: [], templateIds: [], completedAt: null });
  });

  it("rejects conflicting intrinsic review data without overwriting history", async () => {
    const f = await fixture();
    await f.project.saveTask(task());
    await f.project.saveReview(review());
    const repository = await growth(f);
    const first = await repository.capture();
    await f.project.saveReview({ ...review(), completedAt: "2026-10-27T09:00:00.000Z" });
    await expect(repository.capture()).rejects.toMatchObject({ code: "GROWTH_CAPTURE_CONFLICT" });
    expect((await repository.readSnapshot()).capturedReviews).toEqual(first.captured);
  });

  it("rejects a completed review with a missing task before creating personal files", async () => {
    const f = await fixture();
    await f.project.saveReview(review());
    await expect((await growth(f)).capture()).rejects.toMatchObject({ code: "GROWTH_INVALID_SOURCE" });
    await expect(stat(f.paths.personal.base)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("growth snapshot validation and immutable observations", () => {
  it("loads original review candidates and receipts alongside all selected source records", async () => {
    const f = await fixture();
    await f.personal.saveReviewState({ version: 1, reviewId: "review-1", taskId: "task-1",
      proposedAt: "2026-10-27T09:00:00.000Z", candidates: [{ id: "review-1-candidate-1", reviewId: "review-1",
        ordinal: 1, principle: "Synthetic principle", boundary: "Synthetic boundary", status: "approved",
        evidence: [{ kind: "task", id: "task-1" }] }] });
    await f.personal.appendDecisionReceipt({ id: "receipt-1", candidateId: "review-1-candidate-1", candidateDigest: "a".repeat(64),
      actor: "human", at: "2026-10-27T09:00:00.000Z", decision: "approve", source: "Synthetic test" });
    await f.project.saveCheckpoint({ id: "checkpoint-1", taskId: "task-1", at: "2026-10-27T09:00:00.000Z",
      reason: "manual", snapshot: {} });
    const snapshot = await (await growth(f)).readSnapshot();
    expect(snapshot.personalReviewStates[0]?.candidates[0]?.principle).toBe("Synthetic principle");
    expect(snapshot.decisionReceipts[0]?.id).toBe("receipt-1");
    expect(snapshot.checkpoints[0]?.id).toBe("checkpoint-1");
  });

  it("saves exactly one immutable operation file and rejects a changed operation payload", async () => {
    const f = await fixture();
    const repository = await growth(f);
    const input = observation();
    await repository.saveObservation(input);
    await repository.saveObservation(input);
    expect(await readdir(join(f.paths.personal.base, "growth/observations"))).toEqual(["operation-1.json"]);
    await expect(repository.saveObservation({ ...input, result: "forgotten" })).rejects.toMatchObject({ code: "GROWTH_OPERATION_CONFLICT" });
    expect((await repository.readSnapshot()).observations).toEqual([input]);
  });

  it.each([
    { id: "../escape" }, { id: "/absolute" }, { source: "   " }, { actor: "ai" },
    { version: 2 }, { recordedAt: "yesterday" }, { extra: "unexpected" }, { result: "great" },
    { kind: "defer", until: "invalid", result: undefined },
  ])("rejects invalid observation input before any write: %j", async (change) => {
    const f = await fixture();
    await expect((await growth(f)).saveObservation({ ...observation(), ...change } as never)).rejects.toMatchObject({ code: "INVALID_GROWTH_OBSERVATION" });
    expect(await readdir(f.root)).toEqual([]);
  });

  it("hashes only concept identity and wording, preserving confidence-independent identity", async () => {
    const { contentFingerprint } = await import("../../src/growth/schema.js");
    const concept = { id: "concept-1", principle: "Principle", boundary: "Boundary" };
    // Independently calculated canonical SHA-256 is asserted, so changing the
    // hash input or including unrelated metadata breaks the contract.
    expect(contentFingerprint(concept)).toBe("163f52eb7359930eb0258b34ae1843880102fb6e7c1121fd49c3c7edd2fd0003");
    expect(contentFingerprint({ ...concept, confidence: 0.1 } as typeof concept)).toBe(contentFingerprint({ ...concept, confidence: 0.9 } as typeof concept));
    expect(contentFingerprint({ ...concept, principle: "Revised" })).not.toBe(contentFingerprint(concept));
  });

  it.each([
    ["growth/observations/operation-1.json", '{"version":2}'],
    ["growth/reviews/capture-1.json", '{broken'],
    ["concepts/concept-1.json", '{}'],
    ["capabilities.json", '{"version":99,"records":[]}'],
  ])("reports actionable corruption at %s", async (relative, content) => {
    const f = await fixture();
    const path = join(f.paths.personal.base, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    await expect((await growth(f)).readSnapshot()).rejects.toMatchObject({ code: "INVALID_STORED_DATA", details: { sourcePath: path } });
  });

  it("rejects record filename/payload identity mismatches", async () => {
    const f = await fixture();
    const path = join(f.paths.personal.base, "growth/observations/other.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(observation()));
    await expect((await growth(f)).readSnapshot()).rejects.toMatchObject({ code: "INVALID_STORED_DATA", details: { sourcePath: path } });
  });

  it.each(["growth", "growth/observations", "growth/observations/operation-1.json"])("rejects symlink components for reads and writes at %s", async (relative) => {
    const f = await fixture();
    const outside = join(f.root, "unrelated");
    await mkdir(outside);
    const path = join(f.paths.personal.base, relative);
    await mkdir(dirname(path), { recursive: true });
    await symlink(outside, path);
    const repository = await growth(f);
    await expect(repository.readSnapshot()).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(repository.saveObservation(observation())).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects project root symlinks before taking a capture lock", async () => {
    const f = await fixture();
    const outside = join(f.root, "unrelated");
    await mkdir(outside);
    await mkdir(dirname(f.paths.project.base), { recursive: true });
    await symlink(outside, f.paths.project.base);
    await expect((await growth(f)).capture()).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects nonregular record files", async () => {
    const f = await fixture();
    await mkdir(join(f.paths.personal.base, "growth/observations/operation-1.json"), { recursive: true });
    await expect((await growth(f)).readSnapshot()).rejects.toMatchObject({ code: "INVALID_STORED_DATA" });
  });
});

function observation() {
  return { version: 1 as const, id: "operation-1", kind: "recall" as const, conceptId: "concept-1",
    contentFingerprint: "a".repeat(64), recordedAt: "2026-10-28T09:00:00.000Z", actor: "human" as const,
    source: "Synthetic human report", result: "recalled" as const };
}

describe("growth concurrent sources and storage boundaries", () => {
  it("retries a changing byte snapshot and returns one coherent version", async () => {
    const f = await fixture();
    await f.project.saveTask(task());
    let reads = 0;
    directoryHook.afterList = async (path) => {
      if (path !== f.paths.project.tasks || ++reads !== 2) return;
      await writeFile(join(path, "task-1.json"), JSON.stringify({ ...task(), title: "Updated source" }));
    };
    const result = await (await growth(f)).readSnapshot();
    expect(result.tasks[0]?.title).toBe("Updated source");
  });

  it("compares complete file sets and retries when a record is added", async () => {
    const f = await fixture();
    await f.project.saveTask(task());
    let reads = 0;
    directoryHook.afterList = async (path) => {
      if (path !== f.paths.project.tasks || ++reads !== 2) return;
      await writeFile(join(path, "task-2.json"), JSON.stringify(task("task-2")));
    };
    const result = await (await growth(f)).readSnapshot();
    expect(result.tasks.map((row) => row.id)).toEqual(["task-1", "task-2"]);
  });

  it("fails after three persistently changing snapshot attempts", async () => {
    const f = await fixture();
    await f.project.saveTask(task());
    let reads = 0;
    directoryHook.afterList = async (path) => {
      if (path !== f.paths.project.tasks) return;
      reads++;
      await writeFile(join(path, "task-1.json"), JSON.stringify({ ...task(), title: `Version ${reads}` }));
    };
    await expect((await growth(f)).readSnapshot()).rejects.toMatchObject({ code: "GROWTH_SOURCE_CHANGED" });
    expect(reads).toBe(12);
  });

  it("reports completed capture IDs after a partial filesystem write and reuses them on retry", async () => {
    const f = await fixture();
    await f.project.saveTask(task());
    await f.project.saveReview(review());
    await f.project.saveReview(review("review-2"));
    const repository = await growth(f);
    let writes = 0;
    directoryHook.beforeRename = async (destination) => {
      if (destination.startsWith(repository.capturedReviewDirectory) && ++writes === 2) throw new Error("Synthetic disk failure");
    };
    let failed: unknown;
    try { await repository.capture(); } catch (error) { failed = error; }
    expect(failed).toMatchObject({ code: "GROWTH_CAPTURE_PARTIAL", details: { completedIds: [expect.any(String)] } });
    const completed = (failed as { details: { completedIds: string[] } }).details.completedIds;
    directoryHook.beforeRename = undefined;
    const retried = await repository.capture();
    expect(retried.reused).toEqual(completed);
    expect(retried.captured).toHaveLength(1);
  });

  it("serializes competing observation operations without overwriting the first payload", async () => {
    const f = await fixture();
    const repository = await growth(f);
    const results = await Promise.allSettled([
      repository.saveObservation(observation()),
      repository.saveObservation({ ...observation(), result: "forgotten" }),
    ]);
    expect(results.map((row) => row.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await repository.readSnapshot()).observations).toHaveLength(1);
  });

  it.each(["tasks", "reviews", "checkpoints"] as const)("list APIs reject symlink %s records", async (kind) => {
    const f = await fixture();
    const outside = join(f.root, "unrelated.json");
    await writeFile(outside, JSON.stringify(task()));
    await mkdir(f.paths.project[kind], { recursive: true });
    await symlink(outside, join(f.paths.project[kind], "task-1.json"));
    const list = { tasks: () => f.project.listTasks(), reviews: () => f.project.listReviews(), checkpoints: () => f.project.listCheckpoints() };
    await expect(list[kind]()).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });

  it("rejects unsupported source identity versions before creating personal data", async () => {
    const f = await fixture();
    await mkdir(f.paths.project.base, { recursive: true });
    const path = join(f.paths.project.base, "project-identity.json");
    await writeFile(path, '{"version":2,"sourceId":"source-1"}');
    const repository = await growth(f);
    await expect(repository.readSnapshot()).rejects.toMatchObject({ code: "INVALID_STORED_DATA", details: { sourcePath: path } });
    await expect(repository.capture()).rejects.toMatchObject({ code: "INVALID_STORED_DATA", details: { sourcePath: path } });
    await expect(stat(f.paths.personal.base)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("growth source identity and portable boundaries", () => {
  it("isolates identical review IDs in separate source identities and preserves copied-source retries", async () => {
    const f = await fixture();
    await f.project.saveTask(task());
    await f.project.saveReview(review());
    const repository = new GrowthRepository(f.project, f.personal, { clock: f.clock, id: () => "source-one" });
    const first = await repository.capture();
    const otherPaths = resolvePaths(join(f.root, "other-project"), f.paths.personal.base);
    const otherProject = new ProjectRepository(otherPaths);
    await otherProject.saveTask(task());
    await otherProject.saveReview(review());
    const other = new GrowthRepository(otherProject, f.personal, { clock: f.clock, id: () => "source-two" });
    const second = await other.capture();
    expect(second.captured[0]?.id).not.toBe(first.captured[0]?.id);
    expect((await repository.readSnapshot()).capturedReviews).toHaveLength(2);
    await writeFile(join(otherPaths.project.base, "project-identity.json"), '{"version":1,"sourceId":"source-one"}');
    expect(await other.capture()).toEqual({ captured: [], reused: [first.captured[0]!.id], skipped: [] });
  });

  it("does not resolve provenance paths or unrelated project references during snapshots", async () => {
    const f = await fixture();
    const outside = join(f.root, "unrelated-project");
    await mkdir(outside);
    await writeFile(join(outside, "invalid.json"), "not JSON");
    await f.personal.saveConcept({ id: "concept-1", reviewId: "review-1", taskId: "task-1", ordinal: 1,
      principle: "Synthetic principle", boundary: "Synthetic boundary", status: "approved", confidence: 0.5,
      reviewedAt: "2026-10-27T09:00:00.000Z", evidence: [{ kind: "task", id: "task-1", path: outside }], history: [],
      provenance: { candidateId: "review-1-candidate-1", reviewId: "review-1", taskId: "task-1",
        sourceProject: outside, sourceSummary: "Imported synthetic source", evidenceRefs: [] } });
    const result = await (await growth(f)).readSnapshot();
    expect(result.concepts).toHaveLength(1);
    expect(result.tasks).toEqual([]);
    expect(await readdir(outside)).toEqual(["invalid.json"]);
  });

  it("preserves valid defer and resume operation variants without adding recall results", async () => {
    const f = await fixture();
    const repository = await growth(f);
    const { result, ...fields } = observation();
    await repository.saveObservation({ ...fields, id: "defer-1", kind: "defer", until: "2026-10-29T09:00:00.000Z" });
    await repository.saveObservation({ ...fields, id: "resume-1", kind: "resume" });
    expect((await repository.readSnapshot()).observations).toEqual([
      { ...fields, id: "defer-1", kind: "defer", until: "2026-10-29T09:00:00.000Z" },
      { ...fields, id: "resume-1", kind: "resume" },
    ]);
  });

  it("prevalidates all capture conflicts before writing any new captured review", async () => {
    const f = await fixture();
    await f.project.saveTask(task());
    await f.project.saveReview(review("z-conflict"));
    const repository = await growth(f);
    await repository.capture();
    await f.project.saveReview({ ...review("z-conflict"), completedAt: "2026-10-27T09:00:00.000Z" });
    await f.project.saveReview(review("a-new"));
    await expect(repository.capture()).rejects.toMatchObject({ code: "GROWTH_CAPTURE_CONFLICT" });
    expect(await readdir(repository.capturedReviewDirectory)).toHaveLength(1);
  });

  it("captures a single stable source under concurrent explicit capture calls", async () => {
    const f = await fixture();
    await f.project.saveTask(task());
    await f.project.saveReview(review());
    const repository = await growth(f);
    const results = await Promise.all([repository.capture(), repository.capture()]);
    expect(results.flatMap((result) => result.captured)).toHaveLength(1);
    expect(results.flatMap((result) => result.reused)).toHaveLength(1);
    expect((await repository.readSnapshot()).capturedReviews).toHaveLength(1);
  });

  it("fails on malformed project source JSON before personal writes", async () => {
    const f = await fixture();
    await f.project.saveTask(task());
    const path = join(f.paths.project.tasks, "task-1.json");
    await writeFile(path, "corrupt source");
    await expect((await growth(f)).capture()).rejects.toMatchObject({ code: "INVALID_STORED_DATA", details: { sourcePath: path } });
    await expect(stat(f.paths.personal.base)).rejects.toMatchObject({ code: "ENOENT" });
  });
});


describe("growth selected-root path boundary", () => {
  it("accepts ordinary roots below /tmp including standard platform ancestor aliases", async () => {
    const f = await fixture("/tmp");
    await f.project.saveTask(task());
    await f.project.saveReview(review());
    const repository = await growth(f);
    expect((await repository.readSnapshot()).tasks).toHaveLength(1);
    expect((await repository.capture()).captured).toHaveLength(1);
    await repository.saveObservation(observation());
    expect((await repository.readSnapshot()).observations).toHaveLength(1);
  });

  it.each(["project", "personal"] as const)("rejects the selected %s root itself when it is a symlink", async (kind) => {
    const f = await fixture("/tmp");
    const outside = join(f.root, "unrelated");
    await mkdir(outside);
    const selectedRoot = kind === "project" ? dirname(f.paths.project.base) : f.paths.personal.base;
    await symlink(outside, selectedRoot);
    const repository = await growth(f);
    await expect(repository.readSnapshot()).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    if (kind === "project") await expect(repository.capture()).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    else await expect(repository.saveObservation(observation())).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("growth capture identity consistency", () => {
  it("rejects a source identity changed during capture before personal writes", async () => {
    const f = await fixture();
    await f.project.saveTask(task());
    await f.project.saveReview(review());
    let changed = false;
    directoryHook.afterList = async (path) => {
      if (path !== f.paths.project.tasks || changed) return;
      changed = true;
      await writeFile(join(f.paths.project.base, "project-identity.json"), '{"version":1,"sourceId":"replacement-source"}');
    };
    await expect((await growth(f)).capture()).rejects.toMatchObject({ code: "GROWTH_SOURCE_CHANGED" });
    await expect(stat(f.paths.personal.base)).rejects.toMatchObject({ code: "ENOENT" });
  });
});


describe("completed task evidence prerequisite", () => {
  // Catches completed reviews on open tasks creating false completed-task risk samples.
  it("captures only closed tasks and admits an open task only after normal task completion", async () => {
    const f = await fixture(); const repository = await growth(f);
    await f.project.saveTask({ ...task("closed"), type: "implementation" });
    const active = await f.projectService.startTask({ title: "Synthetic active task", goal: "Keep closure explicit", type: "implementation" });
    const failure = { level: "deep" as const, score: 3, reasons: [], signals: ["failure-or-rework" as const] };
    await f.project.saveReview({ ...review("closed-review", "closed"), completedAt: "2026-10-27T08:45:00.000Z", recommendation: failure });
    await f.project.saveReview({ ...review("active-review", active.id), completedAt: f.clock().toISOString(), recommendation: failure });
    const first = await repository.capture();
    expect(first).toMatchObject({ captured: [{ taskId: "closed", taskCompletedAt: "2026-10-27T09:00:00.000Z" }], reused: [], skipped: [{ taskId: active.id, reviewId: "active-review", taskStatus: "active", reason: "task-not-completed" }] });
    expect(first.captured).toHaveLength(1);
    expect(recommendGrowth(await repository.readSnapshot(), { type: "implementation" }, f.clock())).toMatchObject({ score: 0, history: { relevantTaskCount: 1, failureTaskCount: 1, samples: [{ taskId: "closed", completedAt: "2026-10-27T09:00:00.000Z" }] } });
    f.setTime("2026-10-28T10:00:00.000Z");
    await f.projectService.completeTask(active.id, "Human closed the synthetic task");
    const second = await repository.capture();
    expect(second).toMatchObject({ captured: [{ taskId: active.id, reviewId: "active-review", taskCompletedAt: "2026-10-28T10:00:00.000Z" }], reused: [first.captured[0]!.id], skipped: [] });
    expect(recommendGrowth(await repository.readSnapshot(), { type: "implementation" }, f.clock())).toMatchObject({ score: 2, level: "deep", history: { relevantTaskCount: 2, failureTaskCount: 2 } });
  });

  // Catches root/lock creation for deferred captures and treating abandoned completion dates as closed tasks.
  it("returns explicit active and abandoned skips without creating any personal files", async () => {
    const f = await fixture(); const repository = await growth(f);
    await f.project.saveTask({ ...task("active"), status: "active" });
    await f.project.saveTask({ ...task("abandoned"), status: "abandoned" });
    await f.project.saveReview(review("active-review", "active"));
    await f.project.saveReview(review("abandoned-review", "abandoned"));
    expect(await repository.capture()).toEqual({ captured: [], reused: [], skipped: [
      { taskId: "abandoned", reviewId: "abandoned-review", taskStatus: "abandoned", reason: "task-not-completed" },
      { taskId: "active", reviewId: "active-review", taskStatus: "active", reason: "task-not-completed" },
    ] });
    await expect(stat(f.paths.personal.base)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(repository.identityPath, "utf8"))).toMatchObject({ version: 1, sourceId: expect.any(String) });
    await f.project.saveReview(review("missing-review", "missing"));
    await expect(repository.capture()).rejects.toMatchObject({ code: "GROWTH_INVALID_SOURCE" });
    await expect(stat(f.paths.personal.base)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Catches legacy missing/null incompatibility and silently upgrading immutable task completion evidence.
  it("reuses missing and null task completion as unknown but rejects unknown-to-known upgrades", async () => {
    const f = await fixture(); const repository = await growth(f); const legacy = task(); delete legacy.completedAt;
    await f.project.saveTask(legacy); await f.project.saveReview(review());
    const first = await repository.capture();
    expect(first.captured[0]).toHaveProperty("taskCompletedAt", null);
    const path = join(repository.capturedReviewDirectory, `${first.captured[0]!.id}.json`);
    const without = { ...first.captured[0]! }; delete without.taskCompletedAt;
    for (const stored of [without, { ...without, taskCompletedAt: null }]) {
      const bytes = JSON.stringify(stored); await writeFile(path, bytes);
      f.setTime("2026-10-29T09:00:00.000Z");
      expect(await repository.capture()).toEqual({ captured: [], reused: [first.captured[0]!.id], skipped: [] });
      expect(await readFile(path, "utf8")).toBe(bytes);
    }
    const bytes = await readFile(path, "utf8");
    await f.project.saveTask(task());
    await expect(repository.capture()).rejects.toMatchObject({ code: "GROWTH_CAPTURE_CONFLICT" });
    expect(await readFile(path, "utf8")).toBe(bytes);
  });

  // Catches changes to a known task witness overwriting immutable bytes/capture time.
  it("rejects a changed known task completion witness while retaining original bytes", async () => {
    const f = await fixture(); const repository = await growth(f);
    await f.project.saveTask(task()); await f.project.saveReview(review());
    const first = await repository.capture();
    const path = join(repository.capturedReviewDirectory, `${first.captured[0]!.id}.json`);
    const bytes = await readFile(path, "utf8");
    await f.project.saveTask({ ...task(), completedAt: "2026-10-28T08:00:00.000Z" });
    await expect(repository.capture()).rejects.toMatchObject({ code: "GROWTH_CAPTURE_CONFLICT" });
    expect(await readFile(path, "utf8")).toBe(bytes);
  });
});
