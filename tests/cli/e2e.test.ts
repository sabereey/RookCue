import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  CloudService,
  KnowledgeService,
  PersonalRepository,
  ProjectRepository,
  ProjectService,
  ReviewService,
  resolvePaths,
  type ConceptRecord,
} from "../../src/index.js";

type CliEnvelope<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        details: Record<string, unknown>;
      };
    };

const createdPaths: string[] = [];
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

function parseEnvelope<T>(stdout: string): CliEnvelope<T> {
  const trimmed = stdout.trim();
  expect(trimmed).not.toHaveLength(0);
  const lines = trimmed.split(/\r?\n/);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "") as CliEnvelope<T>;
}

function runCli(
  args: string[],
  options: {
    env?: Record<string, string | undefined>;
  } = {},
) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_UPDATE_NOTIFIER: "1", ...options.env },
  });
}

it("exposes rookcue with compatible gmem and growth-memory commands", async () => {
  const packageJson = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  ) as { bin?: Record<string, string> };

  const lock = JSON.parse(await readFile(join(repoRoot, "package-lock.json"), "utf8"));
  for (const command of ["rookcue", "gmem", "growth-memory"]) {
    expect(packageJson.bin?.[command]).toBe("./dist/src/cli.js");
    expect(lock.packages[""].bin[command]).toBe("dist/src/cli.js");
  }
  const result = runCli(["--help"]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Usage: rookcue [options] [command]");
});

it("reports the same release identity from development and compiled commands", async () => {
  const metadata = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(repoRoot, "package-lock.json"), "utf8"));
  expect(metadata.version).toBe("0.1.0-beta.8");
  expect(lock.version).toBe(metadata.version);
  expect(lock.packages[""].version).toBe(metadata.version);
  for (const result of [runCli(["--version"]), spawnSync(process.execPath, ["dist/src/cli.js", "--version"], { cwd: repoRoot, encoding: "utf8" })]) {
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(metadata.version);
  }
});

async function createRoots() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "growth-memory-cli-"));
  const projectRoot = join(workspaceRoot, "project");
  const personalRoot = join(workspaceRoot, "personal");
  createdPaths.push(workspaceRoot);
  return { projectRoot, personalRoot };
}

async function createCliCloudConflict() {
  const { projectRoot, personalRoot } = await createRoots();
  const paths = resolvePaths(projectRoot, personalRoot);
  const clock = () => new Date("2026-07-03T00:00:00.000Z");
  const repository = new PersonalRepository(paths, { clock });
  const service = new CloudService(repository, { clock });
  const concept: ConceptRecord = {
    id: "review-cli-cloud-candidate-1",
    reviewId: "review-cli-cloud",
    ordinal: 1,
    principle: "Keep conflict recovery explicit.",
    boundary: "Use when validating cloud conflict CLI behavior.",
    evidence: [{ kind: "task", id: "task-cli-cloud" }],
    status: "approved",
    confidence: 0.8,
    reviewedAt: "2026-07-03T00:00:00.000Z",
    taskId: "task-cli-cloud",
    history: [],
  };
  await repository.saveConcept(concept);
  await repository.writeConceptMarkdown(concept.id, "# Cloud\n");

  const remoteRoot = await mkdtemp(join(tmpdir(), "growth-memory-cli-cloud-remote-"));
  createdPaths.push(remoteRoot);
  await service.backup({
    dryRun: false,
    passphrase: "secret",
    remoteTarget: remoteRoot,
  });

  const otherRoot = await mkdtemp(join(tmpdir(), "growth-memory-cli-cloud-other-"));
  createdPaths.push(otherRoot);
  const otherPaths = resolvePaths(join(otherRoot, "project"), join(otherRoot, "personal"));
  const otherRepository = new PersonalRepository(otherPaths, { clock });
  const otherService = new CloudService(otherRepository, { clock });
  await mkdir(join(otherPaths.personal.base, ".cloud"), { recursive: true });
  await writeFile(
    join(otherPaths.personal.base, ".cloud", "state.json"),
    await readFile(join(personalRoot, ".cloud", "state.json"), "utf8"),
    "utf8",
  );
  const conflictPath = `concepts/${concept.id}.md`;
  await otherRepository.writePersonalFile(conflictPath, Buffer.from("# Remote side change\n"));
  await otherService.backup({
    dryRun: false,
    passphrase: "secret",
    remoteTarget: remoteRoot,
  });
  await repository.writePersonalFile(conflictPath, Buffer.from("# Local side change\n"));

  return {
    conflictPath,
    personalRoot,
    projectRoot,
    remoteRoot,
  };
}

async function seedCandidate() {
  const { projectRoot, personalRoot } = await createRoots();
  const paths = resolvePaths(projectRoot, personalRoot);
  const clock = () => new Date("2026-06-21T08:00:00.000Z");
  let idCounter = 0;
  const id = () => `seed-${++idCounter}`;

  const projectRepository = new ProjectRepository(paths, { clock });
  const personalRepository = new PersonalRepository(paths, { clock });
  const projectService = new ProjectService(projectRepository, { clock, id });
  const reviewService = new ReviewService(projectRepository, projectService, {
    clock,
    id,
  });
  const knowledgeService = new KnowledgeService(
    personalRepository,
    projectRepository,
    { clock, id },
  );

  const task = await projectService.startTask({
    title: "Promotion gate",
    goal: "Verify human approval remains required",
  });
  const review = await reviewService.start({
    taskId: task.id,
    level: "deep",
    selectedBy: "human",
    recommendation: {
      level: "deep",
      score: 4,
      reasons: ["Transferable learning was detected."],
      signals: ["transferable-learning", "ai-heavy"],
    },
  });

  await reviewService.addEntry(review.id, {
    actor: "human",
    kind: "decision",
    content: "Proceed with deep review.",
    evidence: [],
  });
  await reviewService.advance(review.id);
  await reviewService.addEntry(review.id, {
    actor: "human",
    kind: "response",
    content: "Baseline plus delta.",
    evidence: [{ kind: "task", id: task.id }],
  });
  await reviewService.advance(review.id);
  await reviewService.addEntry(review.id, {
    actor: "ai",
    kind: "question",
    content: "What breaks without proof?",
    evidence: [],
  });
  await reviewService.addEntry(review.id, {
    actor: "human",
    kind: "response",
    content: "The lesson is no longer trustworthy.",
    evidence: [{ kind: "review", id: review.id }],
  });
  await reviewService.advance(review.id);
  await reviewService.addEntry(review.id, {
    actor: "ai",
    kind: "correction",
    content: "Keep proof attached to the promoted concept.",
    evidence: [{ kind: "commit", id: "commit-99" }],
  });
  await reviewService.advance(review.id);
  await reviewService.addEntry(review.id, {
    actor: "human",
    kind: "transfer-answer",
    content: "Carry principle, boundary, and source evidence together.",
    evidence: [{ kind: "test", id: "test-transfer" }],
  });
  const completedReview = await reviewService.advance(review.id);
  const [candidate] = await knowledgeService.propose(completedReview, [
    {
      principle: "Promotion keeps proof attached.",
      boundary: "Only after a completed review with project evidence.",
      evidence: [{ kind: "commit", id: "commit-99" }],
    },
  ]);

  return {
    candidateId: candidate?.id ?? "",
    personalRoot,
    projectRoot,
  };
}

async function seedCompletedReview(options: { transferAnswerContent?: string } = {}) {
  const { projectRoot, personalRoot } = await createRoots();
  const paths = resolvePaths(projectRoot, personalRoot);
  const clock = () => new Date("2026-06-21T08:00:00.000Z");
  let idCounter = 0;
  const id = () => `auto-${++idCounter}`;

  const projectRepository = new ProjectRepository(paths, { clock });
  const projectService = new ProjectService(projectRepository, { clock, id });
  const reviewService = new ReviewService(projectRepository, projectService, {
    clock,
    id,
  });

  const task = await projectService.startTask({
    title: "Auto proposal",
    goal: "Generate a candidate from review transfer",
  });
  const review = await reviewService.start({
    taskId: task.id,
    level: "deep",
    selectedBy: "human",
    recommendation: {
      level: "deep",
      score: 4,
      reasons: ["Transferable learning was detected."],
      signals: ["transferable-learning"],
    },
  });

  await reviewService.addEntry(review.id, {
    actor: "human",
    kind: "decision",
    content: "Proceed with deep review.",
    evidence: [],
  });
  await reviewService.advance(review.id);
  await reviewService.addEntry(review.id, {
    actor: "human",
    kind: "response",
    content: "The task exposed a reusable output contract.",
    evidence: [{ kind: "task", id: task.id }],
  });
  await reviewService.advance(review.id);
  await reviewService.addEntry(review.id, {
    actor: "ai",
    kind: "question",
    content: "What should transfer to the next tool?",
    evidence: [],
  });
  await reviewService.addEntry(review.id, {
    actor: "human",
    kind: "response",
    content: "Human and agent outputs should use different defaults.",
    evidence: [{ kind: "review", id: review.id }],
  });
  await reviewService.advance(review.id);
  await reviewService.addEntry(review.id, {
    actor: "ai",
    kind: "correction",
    content: "Keep readable defaults while preserving structured output.",
    evidence: [{ kind: "commit", id: "commit-auto-propose" }],
  });
  await reviewService.advance(review.id);
  await reviewService.addEntry(review.id, {
    actor: "human",
    kind: "transfer-answer",
    content:
      options.transferAnswerContent ??
      "Tools that serve agents and humans should preserve structured output for agents and readable defaults for humans.",
    evidence: [{ kind: "test", id: "test-auto-transfer" }],
  });
  const completedReview = await reviewService.advance(review.id);

  return {
    personalRoot,
    projectRoot,
    reviewId: completedReview.id,
    taskId: task.id,
  };
}

async function seedApprovedConcept() {
  const { candidateId, projectRoot, personalRoot } = await seedCandidate();
  const paths = resolvePaths(projectRoot, personalRoot);
  const clock = () => new Date("2026-06-21T08:00:00.000Z");
  const personalRepository = new PersonalRepository(paths, { clock });
  const projectRepository = new ProjectRepository(paths, { clock });
  const knowledgeService = new KnowledgeService(
    personalRepository,
    projectRepository,
    {
      clock,
      id: () => "unused-id",
    },
  );

  await knowledgeService.decide(candidateId, {
    actor: "human",
    decision: "approve",
    source: "CLI fixture approval",
  });
  const concept = await knowledgeService.promote(candidateId, { confidence: 0.9 });

  return {
    conceptId: concept.id,
    personalRoot,
    projectRoot,
  };
}

describe("cli/e2e", () => {
  it("auto-proposes a knowledge candidate from a completed review", async () => {
    const { projectRoot, personalRoot, reviewId, taskId } = await seedCompletedReview();

    const proposed = runCli([
      "knowledge",
      "propose",
      "--project",
      projectRoot,
      "--personal",
      personalRoot,
      "--review",
      reviewId,
      "--json",
    ]);

    expect(proposed.status).toBe(0);
    const envelope = parseEnvelope<
      Array<{
        principle: string;
        boundary: string;
        evidence: Array<{ kind: string; id: string }>;
        status: string;
      }>
    >(proposed.stdout);
    expect(envelope).toMatchObject({
      ok: true,
      data: [
        {
          principle:
            "Tools that serve agents and humans should preserve structured output for agents and readable defaults for humans.",
          boundary:
            "Use this when a completed deep review includes a human transfer answer and concrete project evidence.",
          evidence: [{ kind: "task", id: taskId }],
          status: "candidate",
        },
      ],
    });
  });

  it("auto-proposes up to three knowledge candidates from a numbered transfer answer", async () => {
    const { projectRoot, personalRoot, reviewId, taskId } = await seedCompletedReview({
      transferAnswerContent: [
        "全部沉淀：1. BYO 云服务不等于无隐私责任。",
        "2. Remote 抽象层要显式声明 capabilities。",
        "3. 同步冲突判断应基于 base、local、remote 三方差异。",
        "4. 同步产品目标是恢复可继续使用状态。",
      ].join(" "),
    });

    const proposed = runCli([
      "knowledge",
      "propose",
      "--project",
      projectRoot,
      "--personal",
      personalRoot,
      "--review",
      reviewId,
      "--json",
    ]);

    expect(proposed.status).toBe(0);
    const envelope = parseEnvelope<
      Array<{
        ordinal: number;
        principle: string;
        boundary: string;
        evidence: Array<{ kind: string; id: string }>;
        status: string;
      }>
    >(proposed.stdout);
    expect(envelope).toMatchObject({
      ok: true,
      data: [
        {
          ordinal: 1,
          principle: "BYO 云服务不等于无隐私责任。",
          boundary:
            "Use this when a completed deep review includes a human transfer answer and concrete project evidence.",
          evidence: [{ kind: "task", id: taskId }],
          status: "candidate",
        },
        {
          ordinal: 2,
          principle: "Remote 抽象层要显式声明 capabilities。",
          evidence: [{ kind: "task", id: taskId }],
          status: "candidate",
        },
        {
          ordinal: 3,
          principle: "同步冲突判断应基于 base、local、remote 三方差异。",
          evidence: [{ kind: "task", id: taskId }],
          status: "candidate",
        },
      ],
    });
  });

  it("emits one JSON envelope per successful command across the core CLI flow", async () => {
    const { projectRoot, personalRoot } = await createRoots();

    const init = runCli([
      "init",
      "--project",
      projectRoot,
      "--personal",
      personalRoot,
      "--json",
    ]);
    expect(init.status).toBe(0);
    const initEnvelope = parseEnvelope<{ roots: { project: string; personal: string } }>(
      init.stdout,
    );
    expect(initEnvelope).toMatchObject({
      ok: true,
      data: {
        roots: {
          project: join(projectRoot, ".growth-memory"),
          personal: personalRoot,
        },
      },
    });
    expect(init.stderr).toBe("");

    const started = runCli([
      "task",
      "start",
      "--project",
      projectRoot,
      "--title",
      "Recovery",
      "--goal",
      "Restore work",
      "--json",
    ]);
    expect(started.status).toBe(0);
    const taskEnvelope = parseEnvelope<{ id: string; status: string }>(started.stdout);
    expect(taskEnvelope).toMatchObject({
      ok: true,
      data: { status: "active" },
    });

    const recommended = runCli([
      "review",
      "recommend",
      "--project",
      projectRoot,
      "--signal",
      "architecture-change",
      "--signal",
      "ai-heavy",
      "--json",
    ]);
    expect(recommended.status).toBe(0);
    const recommendationEnvelope = parseEnvelope<{
      level: string;
      score: number;
      signals: string[];
    }>(recommended.stdout);
    expect(recommendationEnvelope).toMatchObject({
      ok: true,
      data: {
        level: "deep",
        score: 4,
        signals: ["architecture-change", "ai-heavy"],
      },
    });

    const taskId =
      taskEnvelope.ok ? taskEnvelope.data.id : (() => { throw new Error("task missing"); })();
    const startedReview = runCli([
      "review",
      "start",
      "--project",
      projectRoot,
      "--task",
      taskId,
      "--level",
      "deep",
      "--json",
    ]);
    expect(startedReview.status).toBe(0);
    const reviewEnvelope = parseEnvelope<{ id: string; phase: string }>(startedReview.stdout);
    expect(reviewEnvelope).toMatchObject({
      ok: true,
      data: { phase: "context" },
    });

    const reviewId =
      reviewEnvelope.ok
        ? reviewEnvelope.data.id
        : (() => { throw new Error("review missing"); })();
    const selected = runCli([
      "review",
      "respond",
      "--project",
      projectRoot,
      "--review",
      reviewId,
      "--phase",
      "context",
      "--text",
      "I accept the deep review level for this task.",
      "--json",
    ]);
    expect(selected.status).toBe(0);
    const advanced = runCli([
      "review",
      "advance",
      "--project",
      projectRoot,
      "--review",
      reviewId,
      "--json",
    ]);
    expect(advanced.status).toBe(0);
    const responded = runCli([
      "review",
      "respond",
      "--project",
      projectRoot,
      "--review",
      reviewId,
      "--phase",
      "reconstruct",
      "--text",
      "Baseline plus delta",
      "--json",
    ]);
    expect(responded.status).toBe(0);
    const responseEnvelope = parseEnvelope<{
      entry: { kind: string; content: string };
      review: { id: string; phase: string };
    }>(responded.stdout);
    expect(responseEnvelope).toMatchObject({
      ok: true,
      data: {
        entry: { kind: "response", content: "Baseline plus delta" },
        review: { id: reviewId, phase: "reconstruct" },
      },
    });
    expect(responded.stderr).toBe("");
  });

  it("rejects CLI phase bypass without fabricating a human context decision", async () => {
    const { projectRoot } = await createRoots();
    const started = runCli([
      "task", "start", "--project", projectRoot,
      "--title", "No phase bypass",
      "--goal", "Require an explicit context decision",
      "--json",
    ]);
    const taskEnvelope = parseEnvelope<{ id: string }>(started.stdout);
    const taskId = taskEnvelope.ok ? taskEnvelope.data.id : "";
    const review = runCli([
      "review", "start", "--project", projectRoot,
      "--task", taskId,
      "--level", "deep",
      "--signal", "architecture-change",
      "--json",
    ]);
    const reviewEnvelope = parseEnvelope<{ id: string }>(review.stdout);
    const reviewId = reviewEnvelope.ok ? reviewEnvelope.data.id : "";

    const bypass = runCli([
      "review", "respond", "--project", projectRoot,
      "--review", reviewId,
      "--phase", "reconstruct",
      "--text", "This must not auto-approve context.",
      "--json",
    ]);

    expect(bypass.status).toBe(2);
    expect(parseEnvelope<never>(bypass.stdout)).toMatchObject({
      ok: false,
      error: { code: "REVIEW_PHASE_MISMATCH" },
    });
  });

  it("rejects traversal identifiers at the CLI boundary", async () => {
    const { projectRoot } = await createRoots();
    const result = runCli([
      "task", "complete", "--project", projectRoot,
      "--task", "../../escaped",
      "--summary", "Must stay inside the task root",
      "--json",
    ]);

    expect(result.status).toBe(2);
    expect(parseEnvelope<never>(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "INVALID_IDENTIFIER" },
    });
  });

  it("requires explicit actor and source for CLI knowledge decisions", async () => {
    const { candidateId, projectRoot, personalRoot } = await seedCandidate();
    const result = runCli([
      "knowledge", "decide",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--candidate", candidateId,
      "--decision", "approve",
      "--json",
    ]);

    expect(result.status).toBe(64);
    expect(parseEnvelope<never>(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "COMMANDER_PARSE_ERROR" },
    });
  });

  it("shows a promoted personal knowledge concept by id", async () => {
    const { conceptId, projectRoot, personalRoot } = await seedApprovedConcept();
    const result = runCli([
      "knowledge", "show",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--concept", conceptId,
      "--json",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseEnvelope<{
      id: string;
      principle: string;
      provenance?: { sourceSummary: string; evidenceRefs: Array<{ kind: string; id: string }> };
      status: string;
      timestamps?: { promotedAt: string };
    }>(result.stdout)).toMatchObject({
      ok: true,
      data: {
        id: conceptId,
        principle: "Promotion keeps proof attached.",
        provenance: {
          sourceSummary: expect.stringContaining("Promotion gate"),
          evidenceRefs: expect.arrayContaining([
            expect.objectContaining({ kind: "review" }),
            expect.objectContaining({ kind: "commit", id: "commit-99" }),
          ]),
        },
        status: "approved",
        timestamps: {
          promotedAt: "2026-06-21T08:00:00.000Z",
        },
      },
    });
  });

  it("lists promoted personal knowledge concepts", async () => {
    const { conceptId, projectRoot, personalRoot } = await seedApprovedConcept();
    const result = runCli([
      "knowledge", "list",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--json",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseEnvelope<Array<{ id: string; principle: string; status: string }>>(
      result.stdout,
    )).toMatchObject({
      ok: true,
      data: [
        {
          id: conceptId,
          principle: "Promotion keeps proof attached.",
          status: "approved",
        },
      ],
    });
  });

  it("renders knowledge show as Markdown by default for human readers", async () => {
    const { conceptId, projectRoot, personalRoot } = await seedApprovedConcept();
    const result = runCli([
      "knowledge", "show",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--concept", conceptId,
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("# Promotion keeps proof attached.");
    expect(result.stdout).toContain("- Status: approved");
    expect(result.stdout).toContain("- Confidence: 0.9");
    expect(result.stdout).toContain("- Promoted:");
    expect(result.stdout).toContain("(2026-06-21T08:00:00.000Z)");
    expect(result.stdout).toContain("- Source: Promotion gate, 2026-06-21");
    expect(result.stdout).toContain("Promotion gate");
    expect(result.stdout).toContain("knowledge provenance");
    expect(result.stdout).not.toContain("## Source Chain");
    expect(result.stdout).not.toContain("Promoted from task");
  });

  it("exports personal assets with a manifest through the CLI", async () => {
    const { conceptId, projectRoot, personalRoot } = await seedApprovedConcept();
    const outRoot = await mkdtemp(join(tmpdir(), "growth-memory-cli-export-"));
    createdPaths.push(outRoot);
    const result = runCli([
      "personal", "export",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--out", outRoot,
      "--json",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = parseEnvelope<{
      bytes: number;
      exportRoot: string;
      files: number;
      manifestPath: string;
    }>(result.stdout);
    expect(envelope).toMatchObject({
      ok: true,
      data: {
        files: expect.any(Number),
        bytes: expect.any(Number),
      },
    });
    if (!envelope.ok) {
      throw new Error("Expected export to succeed");
    }
    expect(envelope.data.exportRoot).toContain("growth-memory-export-");
    const manifest = JSON.parse(await readFile(envelope.data.manifestPath, "utf8")) as {
      files: Array<{ path: string; sha256: string }>;
      schemaVersion: number;
      version: number;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: `concepts/${conceptId}.json` }),
        expect.objectContaining({ path: `concepts/${conceptId}.md` }),
      ]),
    );

    const verify = runCli([
      "personal", "verify",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--bundle", envelope.data.exportRoot,
      "--json",
    ]);
    expect(verify.status).toBe(0);
    expect(parseEnvelope<{ valid: boolean; missing: unknown[]; changed: unknown[] }>(
      verify.stdout,
    )).toMatchObject({
      ok: true,
      data: {
        valid: true,
        missing: [],
        changed: [],
      },
    });

    const dryRun = runCli([
      "personal", "import",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--bundle", envelope.data.exportRoot,
      "--dry-run",
      "--json",
    ]);
    expect(dryRun.status).toBe(0);
    expect(parseEnvelope<{ mode: string; wouldSkip: string[] }>(
      dryRun.stdout,
    )).toMatchObject({
      ok: true,
      data: {
        mode: "dry-run",
        wouldSkip: expect.arrayContaining([`concepts/${conceptId}.json`]),
      },
    });

    const importWithoutDryRun = runCli([
      "personal", "import",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--bundle", envelope.data.exportRoot,
      "--json",
    ]);
    expect(importWithoutDryRun.status).toBe(2);
    expect(parseEnvelope<never>(importWithoutDryRun.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "IMPORT_REQUIRES_DRY_RUN",
      },
    });
  });

  it("backs up personal knowledge to an encrypted filesystem cloud remote", async () => {
    const { conceptId, projectRoot, personalRoot } = await seedApprovedConcept();
    const remoteRoot = await mkdtemp(join(tmpdir(), "growth-memory-cloud-remote-"));
    createdPaths.push(remoteRoot);

    const emptyStatus = runCli([
      "cloud", "status",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--remote", remoteRoot,
      "--json",
    ]);
    expect(emptyStatus.status).toBe(0);
    expect(parseEnvelope<{ configured: boolean; objects: number }>(
      emptyStatus.stdout,
    )).toMatchObject({
      ok: true,
      data: {
        configured: false,
        objects: 0,
      },
    });

    const dryRun = runCli([
      "cloud", "backup",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--remote", remoteRoot,
      "--passphrase", "secret",
      "--dry-run",
      "--json",
    ]);
    expect(dryRun.status).toBe(0);
    expect(parseEnvelope<{
      conflicts: string[];
      dryRun: boolean;
      uploaded: string[];
      wouldUpload: string[];
    }>(
      dryRun.stdout,
    )).toMatchObject({
      ok: true,
      data: {
        conflicts: [],
        dryRun: true,
        uploaded: [],
        wouldUpload: expect.arrayContaining([`concepts/${conceptId}.json`]),
      },
    });

    const backup = runCli([
      "cloud", "backup",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--remote", remoteRoot,
      "--passphrase", "secret",
      "--json",
    ]);
    expect(backup.status).toBe(0);
    expect(parseEnvelope<{ conflicts: string[]; uploaded: string[] }>(
      backup.stdout,
    )).toMatchObject({
      ok: true,
      data: {
        conflicts: [],
        uploaded: expect.arrayContaining([`concepts/${conceptId}.json`]),
      },
    });

    const manifest = await readFile(join(remoteRoot, "manifest.json"), "utf8");
    expect(manifest).not.toContain("concepts/");
    expect(manifest).not.toContain("reviews/");
    expect(manifest).not.toContain("practice/");
    const objectNames = JSON.parse(manifest) as {
      objects: Array<{ objectKey: string; path?: string; sha256?: string }>;
    };
    expect(objectNames.objects.every((object) => object.path === undefined)).toBe(true);
    expect(objectNames.objects.every((object) => object.sha256 === undefined)).toBe(true);
    for (const object of objectNames.objects) {
      const encrypted = await readFile(
        join(remoteRoot, "objects", object.objectKey),
        "utf8",
      );
      expect(encrypted).not.toContain("Promotion keeps proof attached.");
    }

    const restore = runCli([
      "cloud", "restore",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--remote", remoteRoot,
      "--passphrase", "secret",
      "--dry-run",
      "--json",
    ]);
    expect(restore.status).toBe(0);
    expect(parseEnvelope<{ wouldSkip: string[]; conflicts: string[] }>(
      restore.stdout,
    )).toMatchObject({
      ok: true,
      data: {
        wouldSkip: expect.arrayContaining([`concepts/${conceptId}.json`]),
        conflicts: [],
      },
    });

    const sync = runCli([
      "cloud", "sync",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--remote", remoteRoot,
      "--passphrase", "secret",
      "--dry-run",
      "--json",
    ]);
    expect(sync.status).toBe(0);
    expect(parseEnvelope<{ wouldSkip: string[]; conflicts: string[] }>(
      sync.stdout,
    )).toMatchObject({
      ok: true,
      data: {
        wouldSkip: expect.arrayContaining([`concepts/${conceptId}.json`]),
        conflicts: [],
      },
    });

    const applied = runCli([
      "cloud", "sync",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--remote", remoteRoot,
      "--passphrase", "secret",
      "--apply",
      "--json",
    ]);
    expect(applied.status).toBe(0);
    expect(parseEnvelope<{
      applied: boolean;
      conflicts: string[];
      downloaded: string[];
      uploaded: string[];
    }>(
      applied.stdout,
    )).toMatchObject({
      ok: true,
      data: {
        applied: true,
        conflicts: [],
        downloaded: [],
        uploaded: [],
      },
    });

    const restoreWithoutDryRun = runCli([
      "cloud", "restore",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--remote", remoteRoot,
      "--passphrase", "secret",
      "--json",
    ]);
    expect(restoreWithoutDryRun.status).toBe(2);
    expect(parseEnvelope<never>(restoreWithoutDryRun.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "CLOUD_RESTORE_REQUIRES_DRY_RUN",
      },
    });
  });

  it("previews and applies filesystem cloud cleanup", async () => {
    const { projectRoot, personalRoot } = await seedApprovedConcept();
    const remoteRoot = await mkdtemp(join(tmpdir(), "growth-memory-cloud-cleanup-"));
    createdPaths.push(remoteRoot);
    const backup = runCli([
      "cloud",
      "backup",
      "--project",
      projectRoot,
      "--personal",
      personalRoot,
      "--remote",
      remoteRoot,
      "--passphrase",
      "secret",
      "--json",
    ]);
    expect(backup.status).toBe(0);
    await writeFile(join(remoteRoot, "objects", "orphan.bin"), "orphan");

    const dryRun = runCli([
      "cloud",
      "cleanup",
      "--project",
      projectRoot,
      "--personal",
      personalRoot,
      "--remote",
      remoteRoot,
      "--dry-run",
      "--json",
    ]);
    expect(dryRun.status).toBe(0);
    expect(parseEnvelope<{ deletedObjects: string[]; orphanObjects: string[] }>(
      dryRun.stdout,
    )).toMatchObject({
      ok: true,
      data: { deletedObjects: [], orphanObjects: ["orphan.bin"] },
    });

    const apply = runCli([
      "cloud",
      "cleanup",
      "--project",
      projectRoot,
      "--personal",
      personalRoot,
      "--remote",
      remoteRoot,
      "--apply",
      "--json",
    ]);
    expect(apply.status).toBe(0);
    expect(parseEnvelope<{ deletedObjects: string[] }>(apply.stdout)).toMatchObject({
      ok: true,
      data: { deletedObjects: ["orphan.bin"] },
    });
    await expect(readFile(join(remoteRoot, "objects", "orphan.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires an explicit cloud sync mode", async () => {
    const { projectRoot, personalRoot } = await createRoots();
    const remoteRoot = await mkdtemp(join(tmpdir(), "growth-memory-cloud-remote-"));
    createdPaths.push(remoteRoot);

    const sync = runCli([
      "cloud", "sync",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--remote", remoteRoot,
      "--passphrase", "secret",
      "--json",
    ]);

    expect(sync.status).toBe(2);
    expect(parseEnvelope<never>(sync.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "CLOUD_SYNC_MODE_REQUIRED",
      },
    });
  });

  it("rejects conflicting cloud sync modes", async () => {
    const { projectRoot, personalRoot } = await createRoots();
    const remoteRoot = await mkdtemp(join(tmpdir(), "growth-memory-cloud-remote-"));
    createdPaths.push(remoteRoot);

    const sync = runCli([
      "cloud", "sync",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--remote", remoteRoot,
      "--passphrase", "secret",
      "--dry-run",
      "--apply",
      "--json",
    ]);

    expect(sync.status).toBe(2);
  expect(parseEnvelope<never>(sync.stdout)).toMatchObject({
    ok: false,
    error: {
      code: "CLOUD_SYNC_MODE_CONFLICT",
    },
  });
});

it("lists, shows, and resolves cloud conflicts", async () => {
  const { conflictPath, personalRoot, projectRoot, remoteRoot } =
    await createCliCloudConflict();

  const list = runCli([
    "cloud", "conflict", "list",
    "--project", projectRoot,
    "--personal", personalRoot,
    "--remote", remoteRoot,
    "--passphrase", "secret",
    "--json",
  ]);
  expect(list.status).toBe(0);
  expect(parseEnvelope<{ conflicts: string[] }>(list.stdout)).toMatchObject({
    ok: true,
    data: { conflicts: [conflictPath] },
  });

  const show = runCli([
    "cloud", "conflict", "show",
    "--project", projectRoot,
    "--personal", personalRoot,
    "--remote", remoteRoot,
    "--passphrase", "secret",
    "--path", conflictPath,
    "--json",
  ]);
  expect(show.status).toBe(0);
  expect(parseEnvelope<{
    local: { preview: string };
    remoteObject: { preview: string };
  }>(show.stdout)).toMatchObject({
    ok: true,
    data: {
      local: { preview: "# Local side change" },
      remoteObject: { preview: "# Remote side change" },
    },
  });

  const resolve = runCli([
    "cloud", "conflict", "resolve",
    "--project", projectRoot,
    "--personal", personalRoot,
    "--remote", remoteRoot,
    "--passphrase", "secret",
    "--path", conflictPath,
    "--strategy", "remote",
    "--json",
  ]);
  expect(resolve.status).toBe(0);
  expect(parseEnvelope<{ resolved: boolean; strategy: string }>(
    resolve.stdout,
  )).toMatchObject({
    ok: true,
    data: { resolved: true, strategy: "remote" },
  });
});

it("checks a BYO filesystem remote without creating remote data", async () => {
  const { personalRoot, projectRoot } = await createRoots();
  const remoteRoot = await mkdtemp(join(tmpdir(), "growth-memory-cli-remote-check-"));
  createdPaths.push(remoteRoot);

  const result = runCli([
    "cloud", "remote", "check", "--project", projectRoot,
    "--personal", personalRoot, "--remote", remoteRoot, "--json",
  ]);

  expect(result.status).toBe(0);
  expect(parseEnvelope(result.stdout)).toMatchObject({
    ok: true,
    data: { kind: "filesystem", remote: remoteRoot, warnings: [] },
  });
  await expect(readFile(join(remoteRoot, "manifest.json"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("does not expose retired hosted login commands", async () => {
  const { projectRoot } = await createRoots();
  const result = runCli(["cloud", "login", "--project", projectRoot, "--json"]);

  expect(result.status).toBe(64);
  expect(parseEnvelope(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "COMMANDER_PARSE_ERROR" },
  });
});

  it("searches, timelines, and shows provenance through the CLI", async () => {
    const { conceptId, projectRoot, personalRoot } = await seedApprovedConcept();

    const search = runCli([
      "knowledge", "search",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--query", "proof",
      "--json",
    ]);
    expect(search.status).toBe(0);
    expect(parseEnvelope<Array<{ id: string; matchedFields: string[] }>>(
      search.stdout,
    )).toMatchObject({
      ok: true,
      data: [
        {
          id: conceptId,
          matchedFields: expect.arrayContaining(["principle"]),
        },
      ],
    });

    const timeline = runCli([
      "knowledge", "timeline",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--json",
    ]);
    expect(timeline.status).toBe(0);
    expect(parseEnvelope<Array<{ id: string; promotedAt: string }>>(
      timeline.stdout,
    )).toMatchObject({
      ok: true,
      data: [
        {
          id: conceptId,
          promotedAt: "2026-06-21T08:00:00.000Z",
        },
      ],
    });

    const searchHuman = runCli([
      "knowledge", "search",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--query", "proof",
    ]);
    expect(searchHuman.status).toBe(0);
    expect(searchHuman.stdout).toContain("1. Promotion keeps proof attached.");
    expect(searchHuman.stdout).toContain("Matched: principle");
    expect(searchHuman.stdout).toContain("Why: matched the knowledge principle.");

    const timelineHuman = runCli([
      "knowledge", "timeline",
      "--project", projectRoot,
      "--personal", personalRoot,
    ]);
    expect(timelineHuman.status).toBe(0);
    expect(timelineHuman.stdout).toContain("1. ");
    expect(timelineHuman.stdout).toContain("Promotion keeps proof attached.");
    expect(timelineHuman.stdout).toContain("Status: approved; confidence: 0.9");

    const digest = runCli([
      "knowledge", "digest",
      "--project", projectRoot,
      "--personal", personalRoot,
    ]);
    expect(digest.status).toBe(0);
    expect(digest.stdout).toContain("# Personal Knowledge Digest");
    expect(digest.stdout).toContain("Total promoted concepts: 1");
    expect(digest.stdout).toContain("## Recent");
    expect(digest.stdout).toContain("Promotion keeps proof attached.");

    const digestJson = runCli([
      "knowledge", "digest",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--json",
    ]);
    expect(digestJson.status).toBe(0);
    expect(parseEnvelope<{ total: number; recent: Array<{ id: string }> }>(
      digestJson.stdout,
    )).toMatchObject({
      ok: true,
      data: {
        total: 1,
        recent: [{ id: conceptId }],
      },
    });

    const provenance = runCli([
      "knowledge", "provenance",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--concept", conceptId,
    ]);
    expect(provenance.status).toBe(0);
    expect(provenance.stdout).toContain(`# Provenance: ${conceptId}`);
    expect(provenance.stdout).toContain("## Source Chain");
    expect(provenance.stdout).toContain("- review:");
    expect(provenance.stdout).toContain("- commit: commit-99");
  });

  it("summarizes project and personal roots with status", async () => {
    const { conceptId, projectRoot, personalRoot } = await seedApprovedConcept();
    const result = runCli([
      "status",
      "--project", projectRoot,
      "--personal", personalRoot,
      "--json",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseEnvelope<{
      activeTask: null | { id: string };
      counts: { concepts: number };
      initialized: { personal: boolean; project: boolean };
      latestConcept: null | { id: string };
      roots: { personal: string; project: string };
    }>(result.stdout)).toMatchObject({
      ok: true,
      data: {
        activeTask: { id: "seed-1" },
        counts: { concepts: 1 },
        initialized: { personal: true, project: true },
        latestConcept: { id: conceptId },
        roots: {
          personal: personalRoot,
          project: join(projectRoot, ".growth-memory"),
        },
      },
    });
  });

  it("maps missing required roots to a JSON parse error with exit code 64", async () => {
    const result = runCli([
      "task",
      "start",
      "--title",
      "Recovery",
      "--goal",
      "Restore work",
      "--json",
    ]);

    expect(result.status).toBe(64);
    const envelope = parseEnvelope<never>(result.stdout);
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "COMMANDER_PARSE_ERROR",
      },
    });
    expect(result.stderr).toBe("");
  });

  it("completes a quick review through explicit context and correct phases", async () => {
    const { projectRoot, personalRoot } = await createRoots();

    const init = runCli(
      ["init", "--project", projectRoot, "--json"],
      { env: { GROWTH_MEMORY_HOME: personalRoot } },
    );
    expect(init.status).toBe(0);
    expect(parseEnvelope<{ roots: { personal: string } }>(init.stdout)).toMatchObject({
      ok: true,
      data: { roots: { personal: personalRoot } },
    });

    const started = runCli([
      "task",
      "start",
      "--project",
      projectRoot,
      "--title",
      "Quick review",
      "--goal",
      "Finish a lightweight check",
      "--json",
    ]);
    expect(started.status).toBe(0);
    const taskEnvelope = parseEnvelope<{ id: string }>(started.stdout);
    const taskId =
      taskEnvelope.ok ? taskEnvelope.data.id : (() => { throw new Error("task missing"); })();

    const startedReview = runCli([
      "review",
      "start",
      "--project",
      projectRoot,
      "--task",
      taskId,
      "--level",
      "quick",
      "--json",
    ]);
    expect(startedReview.status).toBe(0);
    const reviewEnvelope = parseEnvelope<{ id: string; phase: string }>(startedReview.stdout);
    const reviewId =
      reviewEnvelope.ok
        ? reviewEnvelope.data.id
        : (() => { throw new Error("review missing"); })();

    const decided = runCli([
      "review",
      "respond",
      "--project",
      projectRoot,
      "--review",
      reviewId,
      "--phase",
      "context",
      "--text",
      "I accept the quick review level for this task.",
      "--json",
    ]);
    expect(decided.status).toBe(0);
    expect(parseEnvelope<{ entry: { kind: string }; review: { phase: string } }>(decided.stdout))
      .toMatchObject({
        ok: true,
        data: {
          entry: { kind: "decision" },
          review: { phase: "context" },
        },
      });

    const advancedToCorrect = runCli([
      "review",
      "advance",
      "--project",
      projectRoot,
      "--review",
      reviewId,
      "--json",
    ]);
    expect(advancedToCorrect.status).toBe(0);
    expect(parseEnvelope<{ phase: string }>(advancedToCorrect.stdout)).toMatchObject({
      ok: true,
      data: { phase: "correct" },
    });

    const corrected = runCli([
      "review",
      "respond",
      "--project",
      projectRoot,
      "--review",
      reviewId,
      "--phase",
      "correct",
      "--text",
      "The quick pass confirms the task behavior matches the intended change.",
      "--json",
    ]);
    expect(corrected.status).toBe(0);
    expect(
      parseEnvelope<{ entry: { kind: string; content: string }; review: { phase: string } }>(
        corrected.stdout,
      ),
    ).toMatchObject({
      ok: true,
      data: {
        entry: {
          kind: "response",
          content: "The quick pass confirms the task behavior matches the intended change.",
        },
        review: { phase: "correct" },
      },
    });

    const completed = runCli([
      "review",
      "advance",
      "--project",
      projectRoot,
      "--review",
      reviewId,
      "--json",
    ]);
    expect(completed.status).toBe(0);
    expect(parseEnvelope<{ phase: string; status: string }>(completed.stdout)).toMatchObject({
      ok: true,
      data: {
        phase: "complete",
        status: "completed",
      },
    });
    expect(completed.stderr).toBe("");
  });

  it("fails fast with exit 64 when required evidence is omitted", async () => {
    const { conceptId, projectRoot, personalRoot } = await seedApprovedConcept();

    const cases = [
      {
        args: [
          "context",
          "update",
          "--project",
          projectRoot,
          "--markdown",
          "Stable knowledge",
          "--json",
        ],
      },
      {
        args: [
          "evolution",
          "add",
          "--project",
          projectRoot,
          "--title",
          "Boundary change",
          "--before",
          "Before",
          "--after",
          "After",
          "--reason",
          "Reason",
          "--impact",
          "Impact",
          "--json",
        ],
      },
      {
        args: [
          "knowledge",
          "revise",
          "--project",
          projectRoot,
          "--personal",
          personalRoot,
          "--concept",
          conceptId,
          "--summary",
          "Clarify the principle",
          "--principle",
          "Updated principle",
          "--json",
        ],
      },
      {
        args: [
          "capability",
          "update",
          "--project",
          projectRoot,
          "--personal",
          personalRoot,
          "--concept",
          conceptId,
          "--level",
          "seen",
          "--json",
        ],
      },
    ];

    for (const testCase of cases) {
      const result = runCli(testCase.args);

      expect(result.status).toBe(64);
      const envelope = parseEnvelope<never>(result.stdout);
      expect(envelope).toMatchObject({
        ok: false,
        error: {
          code: "COMMANDER_PARSE_ERROR",
        },
      });
      expect(result.stdout).not.toContain("\n    at ");
      expect(result.stderr).toBe("");
    }
  });

  it("returns domain errors as exit code 2 without stack traces in JSON mode", async () => {
    const { candidateId, projectRoot, personalRoot } = await seedCandidate();

    const result = runCli([
      "knowledge",
      "promote",
      "--project",
      projectRoot,
      "--personal",
      personalRoot,
      "--candidate",
      candidateId,
      "--confidence",
      "0.8",
      "--json",
    ]);

    expect(result.status).toBe(2);
    const envelope = parseEnvelope<never>(result.stdout);
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "HUMAN_APPROVAL_REQUIRED",
        message: "A human must approve the candidate before promotion",
      },
    });
    if (!envelope.ok) {
      expect(envelope.error).not.toHaveProperty("stack");
    }
    expect(result.stdout).not.toContain("\n    at ");
    expect(result.stderr).toBe("");
  });
});
