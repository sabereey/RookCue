import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProjectRepository, ProjectService, resolvePaths } from "../../src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rookcue-handoff-"));
  roots.push(root);
  const paths = resolvePaths(root, join(root, "personal"));
  const clock = () => new Date("2026-11-17T04:00:00.000Z");
  let id = 0;
  const repository = new ProjectRepository(paths, { clock });
  const service = new ProjectService(repository, { clock, id: () => `handoff-${++id}` });
  const task = await service.startTask({ title: "Brief", goal: "Prepare a brief; pause before retrieval" });
  return { repository, service, task };
}

const handoff = {
  version: 1,
  state: "awaiting-user",
  goal: "Deliver a sourced brief",
  scope: "Build the brief from collected posts",
  summary: "Brief and snapshot are ready",
  nextStep: "Ask the user to accept the brief or request changes",
  pendingDecision: "Accept the brief or specify corrections",
  constraints: ["Do not complete the task or start a review"],
  requiredTools: [],
  artifacts: ["snapshots/latest.html"],
  completedWork: [
    { summary: "Retrieved posts", agent: "grok", evidence: ["checkpoint:retrieval"] },
    { summary: "Screened posts", agent: "codex", evidence: ["screening.md"] },
  ],
};

it("recovers an explicit acceptance handoff without completing the task or attributing all work to the last agent", async () => {
  const { repository, service, task } = await fixture();
  const saved = await service.checkpoint(task.id, "interrupt", { handoff, query: "fixed query", page: { collected: 18, pageStop: "stop" } });
  const recovered = await service.loadContext();
  expect(recovered).toMatchObject({
    activeTask: { id: task.id, status: "active", goal: "Prepare a brief; pause before retrieval" },
    handoff,
    latestCheckpoint: { id: saved.id, snapshot: { query: "fixed query", page: { collected: 18, pageStop: "stop" } } },
  });
  expect(recovered.working).toContain("awaiting-user");
  expect(recovered.working).toContain("## Handoff");
  expect(recovered.working.indexOf("Ask the user to accept")).toBeLessThan(recovered.working.indexOf("```json"));
  expect((await repository.readState()).activeTaskId).toBe(task.id);
  expect((await repository.readEvents()).some(event => event.type === "task-completed")).toBe(false);
});

it.each([
  { ...handoff, pendingDecision: undefined },
  { ...handoff, pendingDecision: " " },
  { ...handoff, state: "done" },
  { ...handoff, artifacts: undefined },
  { ...handoff, completedWork: [{ summary: "Everything", evidence: [] }] },
  { ...handoff, version: 2 },
])("rejects incomplete handoff without replacing the recoverable checkpoint: %j", async invalid => {
  const { repository, service, task } = await fixture();
  const saved = await service.checkpoint(task.id, "interrupt", { status: "paused", nextStep: "Continue retrieval" });
  const before = await repository.readWorking();
  await expect(service.checkpoint(task.id, "interrupt", { handoff: invalid })).rejects.toMatchObject({ code: "INVALID_CHECKPOINT" });
  expect((await service.loadContext()).latestCheckpoint?.id).toBe(saved.id);
  expect(await repository.readWorking()).toBe(before);
  expect(await repository.listCheckpoints()).toHaveLength(1);
});

it("keeps legacy and review snapshots readable without inventing acceptance or executor information", async () => {
  const { service, task } = await fixture();
  const snapshot = { status: "Brief written", nextStep: "Do not complete or review", custom: { cursor: "123" } };
  await service.checkpoint(task.id, "interrupt", snapshot);
  expect(await service.loadContext()).toMatchObject({ latestCheckpoint: { snapshot } });
  expect(await service.loadContext()).not.toHaveProperty("handoff");
  await service.checkpoint(task.id, "review", { reviewId: "review-1" }, "context");
  expect(await service.loadContext()).not.toHaveProperty("handoff");
});

it.each(["Continue from cursor 123", { agent: "old-agent", next: "build" }, { version: 2, state: "future-state" }])(
  "reads a legacy free-form handoff key and allows a new checkpoint: %j", async legacyHandoff => {
    const { repository, service, task } = await fixture();
    // Legacy records could legally use any snapshot keys and values.
    const legacy = { id: "legacy-checkpoint", taskId: task.id, at: "2026-11-17T03:00:00.000Z", reason: "interrupt" as const, snapshot: { handoff: legacyHandoff } };
    await repository.saveCheckpoint(legacy);
    expect((await service.loadContext()).latestCheckpoint?.snapshot).toEqual({ handoff: legacyHandoff });
    expect(await service.loadContext()).not.toHaveProperty("handoff");
    await service.checkpoint(task.id, "interrupt", { handoff });
    expect(await service.loadContext()).toHaveProperty("handoff.state", "awaiting-user");
  },
);

it("allows older writers to keep using an unversioned free-form handoff key", async () => {
  const { service, task } = await fixture();
  await service.checkpoint(task.id, "interrupt", { handoff: "Resume at cursor 123" });
  expect((await service.loadContext()).latestCheckpoint?.snapshot.handoff).toBe("Resume at cursor 123");
  expect(await service.loadContext()).not.toHaveProperty("handoff");
});
