import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PersonalRepository } from "../../src/storage/personal-repository.js";
import { ProjectRepository } from "../../src/storage/project-repository.js";
import { resolvePaths } from "../../src/storage/paths.js";
import { ProjectService } from "../../src/project/project-service.js";
import { ReviewService } from "../../src/review/review-service.js";
import type { ReviewSession, TaskRecord } from "../../src/domain/schema.js";

const roots: string[] = [];
export async function cleanupFixtures() {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}
export async function fixture(tempRoot = tmpdir()) {
  const root = await mkdtemp(join(tempRoot, "growth-records-"));
  roots.push(root);
  const paths = resolvePaths(join(root, "project"), join(root, "personal"));
  let time = "2026-10-28T09:00:00.000Z";
  let serial = 0;
  const clock = () => new Date(time);
  const id = () => `record-${++serial}`;
  const project = new ProjectRepository(paths);
  const personal = new PersonalRepository(paths);
  const projectService = new ProjectService(project, { clock, id });
  const reviewService = new ReviewService(project, projectService, { clock, id });
  return { root, paths, project, personal, projectService, reviewService, clock, id,
    setTime(value: string) { time = value; } };
}
export function task(id = "task-1"): TaskRecord {
  return { id, title: "Synthetic task", goal: "Test local records", status: "completed",
    startedAt: "2026-10-27T08:00:00.000Z", completedAt: "2026-10-27T09:00:00.000Z" };
}
export function review(id = "review-1", taskId = "task-1"): ReviewSession {
  return { id, taskId, level: "quick", selectedBy: "human", status: "completed",
    phase: "complete", startedAt: "2026-10-27T08:30:00.000Z", entries: [] };
}
