import { mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonalRepository } from "../../src/storage/personal-repository.js";
import { ProjectRepository } from "../../src/storage/project-repository.js";
import { resolvePaths } from "../../src/storage/paths.js";
import { KnowledgeService } from "../../src/personal/knowledge-service.js";
import { GrowthRepository } from "../../src/growth/repository.js";
import { cleanupFixtures, fixture, review, task } from "../growth/fixtures.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupFixtures();
});

describe("project and personal root ownership", () => {
  // Catches namespace collision destroying the original completed human review.
  it.each(["equal", "ancestor-alias", "default-home", "environment-default"])(
    "rejects %s ownership before proposal or direct review writes and retains human bytes",
    async (configuration) => {
      const f = await fixture();
      const completed = { ...review(), entries: [{
        id: "human-entry", actor: "human" as const,
        kind: "response" as const, content: "Original human reasoning", evidence: [],
        at: "2026-10-27T08:35:00.000Z",
      }] };
      await f.project.saveTask(task());
      await f.project.saveReview(completed);
      const reviewPath = join(f.paths.project.reviews, "review-1.json");
      const bytes = await readFile(reviewPath, "utf8");
      let paths = resolvePaths(dirname(f.paths.project.base), f.paths.project.base);
      if (configuration === "ancestor-alias") {
        const alias = join(f.root, "ancestor-alias");
        await symlink(await realpath(f.root), alias);
        paths = resolvePaths(join(alias, "project"), f.paths.project.base);
      } else if (configuration === "default-home") {
        vi.stubEnv("HOME", dirname(f.paths.project.base));
        vi.stubEnv("GROWTH_MEMORY_HOME", undefined);
        paths = resolvePaths(dirname(f.paths.project.base));
      } else if (configuration === "environment-default") {
        vi.stubEnv("GROWTH_MEMORY_HOME", f.paths.project.base);
        paths = resolvePaths(dirname(f.paths.project.base));
      }
      const project = new ProjectRepository(paths);
      const personal = new PersonalRepository(paths);
      const service = new KnowledgeService(personal, project, { clock: f.clock, id: f.id });
      const before = await readdir(paths.project.base);

      await expect(service.propose(completed, [{
        principle: "Retain human work", boundary: "When ownership conflicts",
        evidence: [{ kind: "task", id: "task-1" }],
      }])).rejects.toMatchObject({ code: "STORAGE_ROOT_CONFLICT" });
      await expect(project.saveReview(review())).rejects.toMatchObject({ code: "STORAGE_ROOT_CONFLICT" });
      await expect(personal.saveReviewState({ version: 1, reviewId: "review-1", taskId: "task-1", proposedAt: f.clock().toISOString(), candidates: [] }))
        .rejects.toMatchObject({ code: "STORAGE_ROOT_CONFLICT" });
      await expect(new GrowthRepository(project, personal, { clock: f.clock, id: f.id }).readSnapshot())
        .rejects.toMatchObject({ code: "STORAGE_ROOT_CONFLICT" });

      expect(await readFile(reviewPath, "utf8")).toBe(bytes);
      expect(await readdir(paths.project.base)).toEqual(before);
      expect(await f.project.readReview("review-1")).toMatchObject({ entries: [{ content: "Original human reasoning" }] });
    },
  );

  // Catches canonical checks that overlook an alias when the storage base is absent.
  it("rejects aliased missing roots before a project lock or write creates directories", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "project"));
    await symlink(await realpath(f.root), join(f.root, "alias"));
    const paths = resolvePaths(join(f.root, "alias", "project"), f.paths.project.base);
    const project = new ProjectRepository(paths);

    await expect(project.withMutationLock(async () => project.saveTask(task())))
      .rejects.toMatchObject({ code: "STORAGE_ROOT_CONFLICT" });
    expect(await readdir(join(f.root, "project"))).toEqual([]);
  });

  // Catches generic import/removal paths bypassing ownership via harmless path normalization.
  it.each(["write", "remove"])("blocks generic review %s through a normalized child path", async (operation) => {
    const f = await fixture();
    const paths = resolvePaths(dirname(f.paths.project.base), f.paths.project.base);
    await mkdir(paths.project.reviews, { recursive: true });
    const reviewPath = join(paths.project.reviews, "review-1.json");
    const bytes = JSON.stringify(review());
    await writeFile(reviewPath, bytes);
    const personal = new PersonalRepository(paths);
    const child = "concepts/../reviews/review-1.json";

    const action = operation === "write"
      ? personal.writePersonalFile(child, Buffer.from("{}"))
      : personal.removePersonalFile(child);
    await expect(action).rejects.toMatchObject({ code: "STORAGE_ROOT_CONFLICT" });

    expect(await readFile(reviewPath, "utf8")).toBe(bytes);
  });

  // Catches case-insensitive directory identity bypassing generic mutation ownership checks.
  it.each([
    ["write", "Reviews/review-1.json"],
    ["remove", "Reviews/review-1.json"],
    ["write", "concepts/../rEvIeWs/review-1.json"],
    ["remove", "concepts/../rEvIeWs/review-1.json"],
  ])("preserves human bytes when generic %s uses case alias %s", async (operation, child) => {
    const f = await fixture();
    const paths = resolvePaths(dirname(f.paths.project.base), f.paths.project.base);
    await mkdir(paths.project.reviews, { recursive: true });
    const reviewPath = join(paths.project.reviews, "review-1.json");
    const bytes = JSON.stringify({ ...review(), entries: [{
      id: "human-response", actor: "human", kind: "response",
      content: "Preserve this original human reasoning", evidence: [],
      at: "2026-10-27T08:35:00.000Z",
    }] });
    await writeFile(reviewPath, bytes);
    const personal = new PersonalRepository(paths);
    const proposed = Buffer.from(JSON.stringify({
      version: 1, reviewId: "review-1", taskId: "task-1",
      proposedAt: f.clock().toISOString(), candidates: [],
    }));

    const action = operation === "write"
      ? personal.writePersonalFile(child, proposed)
      : personal.removePersonalFile(child);
    await expect(action).rejects.toMatchObject({ code: "STORAGE_ROOT_CONFLICT" });

    expect(await readFile(reviewPath, "utf8")).toBe(bytes);
  });

  // Catches an alias guard that blocks otherwise safe separated-root personal operations.
  it("keeps generic case-alias writes and removals available with separated storage roots", async () => {
    const f = await fixture();
    const child = "Reviews/review-1.json";
    const bytes = Buffer.from(JSON.stringify({
      version: 1, reviewId: "review-1", taskId: "task-1",
      proposedAt: f.clock().toISOString(), candidates: [],
    }));

    await f.personal.writePersonalFile(child, bytes);
    expect(await f.personal.readPersonalFile(child)).toEqual(bytes);
    await f.personal.removePersonalFile(child);

    expect(await readdir(f.paths.personal.base)).toEqual(["Reviews"]);
    expect(await readdir(join(f.paths.personal.base, "Reviews"))).toEqual([]);
  });

  // Catches overbroad resolution/construction rejection for safe personal-only usage at HOME.
  it("allows personal-only capability operations when the selected cwd is disposable HOME", async () => {
    const f = await fixture();
    const syntheticHome = join(f.root, "home");
    vi.stubEnv("HOME", syntheticHome);
    vi.stubEnv("GROWTH_MEMORY_HOME", undefined);
    const paths = resolvePaths(syntheticHome);
    const personal = new PersonalRepository(paths);

    await personal.withMutationLock(() => personal.saveCapabilities({ version: 1, records: [] }));

    expect(await personal.readCapabilities()).toEqual({ version: 1, records: [] });
    expect(await readdir(paths.personal.base)).toEqual(["capabilities.json"]);
  });
});
