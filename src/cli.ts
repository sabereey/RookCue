#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Command, CommanderError } from "commander";
import { z } from "zod";
import packageMetadata from "../package.json" with { type: "json" };

import { GrowthService } from "./growth/service.js";
import { registerGrowthCommands } from "./growth/cli.js";
import { registerPeerCommands } from "./peer/cli.js";
import { taskTypeSchema } from "./domain/schema.js";
import { CloudService } from "./cloud/cloud-service.js";
import type {
  CloudBackupResult,
  CloudCleanupResult,
  CloudConflictListResult,
  CloudConflictResolveResult,
  CloudConflictShowResult,
  CloudConflictStrategy,
  CloudRestoreDryRunResult,
  CloudRemoteCheckResult,
  CloudStatusResult,
  CloudSyncApplyResult,
  CloudSyncDryRunResult,
} from "./cloud/cloud-types.js";
import { DomainError } from "./domain/errors.js";
import {
  capabilityEvidenceSchema,
  evidenceRefSchema,
  reviewLevelSchema,
  reviewPhaseSchema,
  reviewRecommendationSchema,
  reviewSignalSchema,
  restrictedIdSchema,
  type ConceptRecord,
  type EvidenceRef,
  type ReviewPhase,
  type ReviewRecommendation,
  type ReviewSession,
  type TaskRecord,
} from "./domain/schema.js";
import { KnowledgeService } from "./personal/knowledge-service.js";
import {
  PersonalAssetService,
  promotedAt,
  provenanceFor,
  type KnowledgeDigest,
  type KnowledgeProvenanceView,
  type KnowledgeSearchResult,
  type KnowledgeTimelineItem,
  type PersonalExportResult,
  type PersonalImportDryRunResult,
  type PersonalVerifyResult,
} from "./personal/personal-asset-service.js";
import { ProjectService } from "./project/project-service.js";
import { recommendReview } from "./review/recommendation.js";
import {
  renderChallengeQuestion,
  renderTransferAnswer,
  reviewTemplateIdSchema,
} from "./review/templates.js";
import { ReviewService } from "./review/review-service.js";
import { readJson, writeJsonAtomic, writeTextAtomic } from "./storage/files.js";
import { resolvePaths, safeChildPath } from "./storage/paths.js";
import { PersonalRepository } from "./storage/personal-repository.js";
import { ProjectRepository } from "./storage/project-repository.js";
import { withLocalRootLock, withRootLock } from "./storage/root-lock.js";

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

type CliError = {
  code: string;
  message: string;
  details: Record<string, unknown>;
};

type CommonOptions = {
  json?: boolean;
  personal?: string;
  project: string;
};

class CliInputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CliInputError";
  }
}

const reviewRecommendationFileSchema = z.object({
  taskId: restrictedIdSchema,
  recommendation: reviewRecommendationSchema,
});

function createServices(projectRoot: string, personalRoot?: string) {
  const paths = resolvePaths(projectRoot, personalRoot);
  const clock = () => new Date();
  const id = () => randomUUID();
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
  const personalAssetService = new PersonalAssetService(
    personalRepository,
    { clock },
  );
  const cloudService = new CloudService(personalRepository, { clock });

  return {
    growthService: new GrowthService(projectRepository, personalRepository, { clock, id }),
    cloudService,
    knowledgeService,
    personalAssetService,
    paths,
    personalRepository,
    projectRepository,
    projectService,
    reviewService,
  };
}

function addJsonOption(command: Command): Command {
  return command.option("--json", "emit a stable JSON envelope");
}

function addProjectOption(command: Command, required = true): Command {
  return required
    ? command.requiredOption("--project <dir>", "project root")
    : command.option("--project <dir>", "project root");
}

function addPersonalOption(command: Command): Command {
  return command.option("--personal <dir>", "personal knowledge root");
}

function respondSuccess<T>(json: boolean, data: T): void {
  if (json) {
    writeEnvelope({ ok: true, data });
    return;
  }

  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function respondText(json: boolean, data: unknown, text: string): void {
  if (json) {
    respondSuccess(true, data);
    return;
  }

  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function writeEnvelope<T>(envelope: CliEnvelope<T>): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function serializeError(error: unknown): CliError {
  if (error instanceof DomainError || error instanceof CliInputError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof CommanderError) {
    return {
      code: "COMMANDER_PARSE_ERROR",
      message: error.message,
      details: { exitCode: 64 },
    };
  }

  return {
    code: "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : "Unexpected error",
    details: {},
  };
}

function exitCodeFor(error: unknown): number {
  if (error instanceof DomainError) {
    return 2;
  }

  if (error instanceof CliInputError || error instanceof CommanderError) {
    return 64;
  }

  return 1;
}

function parseEvidenceTokens(values: string[] = []): EvidenceRef[] {
  return values.map((value) => {
    const [kind, id, ...pathParts] = value.split(":");
    return parseWithSchema(
      evidenceRefSchema,
      {
        kind,
        id,
        ...(pathParts.length > 0 ? { path: pathParts.join(":") } : {}),
      },
      "INVALID_EVIDENCE",
      `Evidence must use kind:id or kind:id:path, received "${value}"`,
    );
  });
}

function parseJsonValue<T>(
  label: string,
  raw: string,
  schema: z.ZodType<T>,
): T {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CliInputError("INVALID_INPUT", `${label} must be valid JSON`, {
      raw,
      ...(error instanceof Error ? { cause: error.message } : {}),
    });
  }

  return parseWithSchema(schema, parsed, "INVALID_INPUT", `${label} is invalid`);
}

function parseWithSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: string,
  message: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new CliInputError(code, message, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  return result.data;
}

async function ensureFile(filePath: string, value: string): Promise<void> {
  try {
    await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      await writeTextAtomic(filePath, value);
      return;
    }

    throw error;
  }
}

async function ensureJsonFile<T>(filePath: string, value: T): Promise<void> {
  try {
    await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      await writeJsonAtomic(filePath, value);
      return;
    }

    throw error;
  }
}

function isFileNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isFileNotFound(error)) {
      return false;
    }

    throw error;
  }
}

function renderConceptMarkdown(concept: ConceptRecord): string {
  const provenance = provenanceFor(concept);
  const conceptPromotedAt = promotedAt(concept);
  const history = concept.history.length > 0
    ? `\n\n## History\n${concept.history.map((entry) => `- ${entry.recordedAt}: ${entry.summary}`).join("\n")}`
    : "";

  return [
    `# ${concept.principle}`,
    "",
    `- Status: ${concept.status}`,
    `- Confidence: ${concept.confidence}`,
    `- Boundary: ${concept.boundary}`,
    `- Promoted: ${formatLocalTimestamp(conceptPromotedAt)} (${conceptPromotedAt})`,
    `- Source: ${compactSourceSummary(provenance, conceptPromotedAt)}`,
    "",
    `Run \`gmem knowledge provenance --concept ${concept.id} --project <project> --personal <personal>\` for the full source chain.`,
    history,
  ].join("\n");
}

function renderProvenance(view: KnowledgeProvenanceView): string {
  const sourceChain = view.provenance.evidenceRefs
    .map((item) => `- ${item.kind}: ${item.id}${item.path ? `:${item.path}` : ""}`)
    .join("\n");
  const evidence = view.evidence
    .map((item) => `- ${item.kind}: ${item.id}${item.path ? `:${item.path}` : ""}`)
    .join("\n");

  return [
    `# Provenance: ${view.conceptId}`,
    "",
    `- Candidate: ${view.provenance.candidateId}`,
    `- Review: ${view.provenance.reviewId}`,
    `- Task: ${view.provenance.taskId}`,
    `- Decision receipt: ${view.provenance.decisionReceiptId ?? "unknown"}`,
    `- Source project: ${view.provenance.sourceProject ?? "unknown"}`,
    "",
    "## Source Summary",
    view.provenance.sourceSummary,
    "",
    "## Source Chain",
    sourceChain || "- No source chain recorded.",
    "",
    "## Concept Evidence",
    evidence || "- No concept evidence recorded.",
  ].join("\n");
}

function renderSearchResults(results: KnowledgeSearchResult[]): string {
  if (results.length === 0) {
    return "No matching knowledge found.\n";
  }

  return results
    .map((result, index) =>
      [
        `${index + 1}. ${result.principle}`,
        `   ID: ${result.id}`,
        `   Confidence: ${result.confidence}; promoted: ${formatLocalTimestamp(result.promotedAt)}`,
        `   Matched: ${formatMatchedFields(result.matchedFields)}`,
        `   Why: ${searchReason(result.matchedFields)}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function renderTimeline(items: KnowledgeTimelineItem[]): string {
  if (items.length === 0) {
    return "No promoted personal knowledge found.\n";
  }

  return items
    .map((item, index) =>
      [
        `${index + 1}. ${formatLocalTimestamp(item.promotedAt)}`,
        `   ${item.principle}`,
        `   ID: ${item.id}`,
        `   Status: ${item.status}; confidence: ${item.confidence}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function renderDigest(digest: KnowledgeDigest): string {
  if (digest.total === 0) {
    return "No promoted personal knowledge found.\n";
  }

  return [
    "# Personal Knowledge Digest",
    "",
    `Total promoted concepts: ${digest.total}`,
    "",
    "## Recent",
    renderDigestItems(digest.recent),
    "",
    "## Recurring Themes",
    digest.themes.length > 0
      ? digest.themes.map((theme) => `- ${theme.label} (${theme.count})`).join("\n")
      : "- No recurring themes yet.",
    "",
    "## Oldest",
    renderDigestItems(digest.stale),
  ].join("\n");
}

function renderDigestItems(items: KnowledgeDigest["recent"]): string {
  if (items.length === 0) {
    return "- None.";
  }

  return items
    .map((item) => `- ${formatLocalTimestamp(item.promotedAt)}: ${item.principle}`)
    .join("\n");
}

function renderExportResult(result: PersonalExportResult): string {
  return [
    "# Personal Export",
    "",
    `- Export root: ${result.exportRoot}`,
    `- Manifest: ${result.manifestPath}`,
    `- Files: ${result.files}`,
    `- Bytes: ${result.bytes}`,
  ].join("\n");
}

function renderVerifyResult(result: PersonalVerifyResult): string {
  const sections = [
    "# Personal Export Verify",
    "",
    `- Bundle: ${result.bundle}`,
    `- Manifest: ${result.manifestPath}`,
    `- Valid: ${result.valid ? "yes" : "no"}`,
    `- Checked files: ${result.checkedFiles}`,
    `- Missing: ${result.missing.length}`,
    `- Changed: ${result.changed.length}`,
    `- Extra: ${result.extra.length}`,
  ];

  return [
    ...sections,
    ...renderIssueSection("Missing Files", result.missing),
    ...renderIssueSection("Changed Files", result.changed),
    ...renderIssueSection("Extra Files", result.extra),
  ].join("\n");
}

function renderIssueSection(
  title: string,
  issues: PersonalVerifyResult["missing"],
): string[] {
  if (issues.length === 0) {
    return [];
  }

  return [
    "",
    `## ${title}`,
    ...issues.map((issue) => `- ${issue.path}`),
  ];
}

function renderImportDryRun(result: PersonalImportDryRunResult): string {
  return [
    "# Personal Import Dry Run",
    "",
    `- Bundle: ${result.bundle}`,
    `- Would add: ${result.wouldAdd.length}`,
    `- Would skip: ${result.wouldSkip.length}`,
    `- Unsupported: ${result.unsupported.length}`,
    "",
    "## Would Add",
    renderPathList(result.wouldAdd),
    "",
    "## Would Skip",
    renderPathList(result.wouldSkip),
    "",
    "## Unsupported",
    renderPathList(result.unsupported),
  ].join("\n");
}

function renderCloudStatus(result: CloudStatusResult): string {
  return [
    "# Cloud Status",
    "",
    `- Remote: ${result.remote}`,
    `- Configured: ${result.configured ? "yes" : "no"}`,
    `- Objects: ${result.objects}`,
    `- Created: ${result.createdAt ?? "never"}`,
    `- Atomic manifest write: ${result.capabilities.atomicManifestWrite ? "yes" : "no"}`,
    `- Conditional manifest write: ${result.capabilities.conditionalManifestWrite ? "yes" : "no"}`,
    `- Object listing: ${result.capabilities.objectListing ? "yes" : "no"}`,
    `- Object delete: ${result.capabilities.objectDelete ? "yes" : "no"}`,
    `- Object versioning: ${result.capabilities.objectVersioning ? "yes" : "no"}`,
  ].join("\n");
}

function renderCloudBackup(result: CloudBackupResult): string {
  return [
    "# Cloud Backup",
    "",
    `- Remote: ${result.remote}`,
    `- Dry run: ${result.dryRun ? "yes" : "no"}`,
    `- Would upload: ${result.wouldUpload.length}`,
    `- Would skip: ${result.wouldSkip.length}`,
    `- Conflicts: ${result.conflicts.length}`,
    `- Uploaded: ${result.uploaded.length}`,
    `- Bytes: ${result.bytes}`,
    "",
    "## Would Upload",
    renderPathList(result.wouldUpload),
    "",
    "## Would Skip",
    renderPathList(result.wouldSkip),
    "",
    "## Conflicts",
    renderPathList(result.conflicts),
  ].join("\n");
}

function renderCloudRestoreDryRun(result: CloudRestoreDryRunResult): string {
  return [
    "# Cloud Restore Dry Run",
    "",
    `- Remote: ${result.remote}`,
    `- Would add: ${result.wouldAdd.length}`,
    `- Would skip: ${result.wouldSkip.length}`,
    `- Conflicts: ${result.conflicts.length}`,
    "",
    "## Would Add",
    renderPathList(result.wouldAdd),
    "",
    "## Would Skip",
    renderPathList(result.wouldSkip),
    "",
    "## Conflicts",
    renderPathList(result.conflicts),
  ].join("\n");
}

function renderCloudSync(result: CloudSyncDryRunResult | CloudSyncApplyResult): string {
  const applied = "applied" in result ? result.applied : false;
  const uploaded = "uploaded" in result ? result.uploaded : [];
  const downloaded = "downloaded" in result ? result.downloaded : [];
  return [
    applied ? "# Cloud Sync Apply" : "# Cloud Sync Dry Run",
    "",
    `- Remote: ${result.remote}`,
    `- Applied: ${applied ? "yes" : "no"}`,
    `- Would upload: ${result.wouldUpload.length}`,
    `- Would download: ${result.wouldDownload.length}`,
    `- Would skip: ${result.wouldSkip.length}`,
    `- Conflicts: ${result.conflicts.length}`,
    `- Uploaded: ${uploaded.length}`,
    `- Downloaded: ${downloaded.length}`,
    "",
    "## Would Upload",
    renderPathList(result.wouldUpload),
    "",
    "## Would Download",
    renderPathList(result.wouldDownload),
    "",
    "## Would Skip",
    renderPathList(result.wouldSkip),
    "",
    "## Conflicts",
    renderPathList(result.conflicts),
    "",
    "## Uploaded",
    renderPathList(uploaded),
    "",
    "## Downloaded",
    renderPathList(downloaded),
  ].join("\n");
}

function renderCloudCleanup(result: CloudCleanupResult): string {
  return [
    result.dryRun ? "# Cloud Cleanup Dry Run" : "# Cloud Cleanup Apply",
    "",
    `- Remote: ${result.remote}`,
    `- Dry run: ${result.dryRun ? "yes" : "no"}`,
    `- Referenced objects: ${result.referencedObjects.length}`,
    `- Orphan objects: ${result.orphanObjects.length}`,
    `- Tombstones: ${result.tombstones.length}`,
    `- Conflict copies: ${result.retainedConflictCopies.length}`,
    `- Would delete objects: ${result.wouldDeleteObjects.length}`,
    `- Deleted objects: ${result.deletedObjects.length}`,
    "",
    "## Orphan Objects",
    renderPathList(result.orphanObjects),
    "",
    "## Deleted Objects",
    renderPathList(result.deletedObjects),
  ].join("\n");
}

function renderCloudConflictList(result: CloudConflictListResult): string {
  return [
    "# Cloud Conflicts",
    "",
    `- Remote: ${result.remote}`,
    `- Conflicts: ${result.conflicts.length}`,
    "",
    "## Conflicts",
    renderPathList(result.conflicts),
  ].join("\n");
}

function renderCloudConflictShow(result: CloudConflictShowResult): string {
  return [
    "# Cloud Conflict",
    "",
    `- Remote: ${result.remote}`,
    `- Path: ${result.path}`,
    `- Local bytes: ${result.local.bytes}`,
    `- Remote bytes: ${result.remoteObject.bytes}`,
    "",
    "## Local Preview",
    result.local.preview || "- Empty.",
    "",
    "## Remote Preview",
    result.remoteObject.preview || "- Empty.",
  ].join("\n");
}

function renderCloudConflictResolve(result: CloudConflictResolveResult): string {
  return [
    "# Cloud Conflict Resolve",
    "",
    `- Remote: ${result.remote}`,
    `- Path: ${result.path}`,
    `- Strategy: ${result.strategy}`,
    `- Resolved: ${result.resolved ? "yes" : "no"}`,
    "",
    "## Written Local",
    renderPathList(result.writtenLocal),
    "",
    "## Uploaded",
    renderPathList(result.uploaded),
    "",
    "## Skipped",
    renderPathList(result.skipped),
  ].join("\n");
}

function renderCloudRemoteCheck(result: CloudRemoteCheckResult): string {
  return [
    "# Cloud Remote Check",
    "",
    `- Remote: ${result.remote}`,
    `- Kind: ${result.kind}`,
    `- Safe existing manifest writes: ${result.safeExistingManifestWrite ? "yes" : "no"}`,
    ...result.warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n");
}

function renderPathList(paths: string[]): string {
  if (paths.length === 0) {
    return "- None.";
  }

  return paths.map((path) => `- ${path}`).join("\n");
}

function resolveCloudPassphrase(option?: string): string {
  const passphrase = option ?? process.env.GROWTH_MEMORY_CLOUD_PASSPHRASE;
  if (!passphrase) {
    throw new DomainError(
      "CLOUD_PASSPHRASE_REQUIRED",
      "Cloud commands require --passphrase or GROWTH_MEMORY_CLOUD_PASSPHRASE",
      {},
    );
  }
  return passphrase;
}

function compactSourceSummary(
  provenance: KnowledgeProvenanceView["provenance"],
  conceptPromotedAt: string,
): string {
  const title = sourceTitle(provenance.sourceSummary);
  const date = conceptPromotedAt.slice(0, 10);
  if (title.length > 0) {
    return `${title}, ${date}`;
  }
  return `review ${provenance.reviewId}, ${date}`;
}

function sourceTitle(sourceSummary: string): string {
  const marker = sourceSummary.match(/review [^:]+: (.+)$/);
  const summary = marker?.[1] ?? sourceSummary;
  return summary.split(":")[0]?.trim() ?? "";
}

function formatLocalTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function formatMatchedFields(fields: string[]): string {
  return fields.map((field) => fieldLabel(field)).join(", ");
}

function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    principle: "principle",
    boundary: "boundary",
    "provenance.sourceSummary": "source summary",
    evidence: "evidence",
    "provenance.evidenceRefs": "source chain",
  };
  return labels[field] ?? field;
}

function searchReason(fields: string[]): string {
  if (fields.includes("principle")) {
    return "matched the knowledge principle.";
  }
  if (fields.includes("boundary")) {
    return "matched the usage boundary.";
  }
  if (fields.includes("provenance.sourceSummary")) {
    return "matched the source context.";
  }
  return "matched recorded evidence or source-chain references.";
}

function renderConceptList(concepts: ConceptRecord[]): string {
  if (concepts.length === 0) {
    return "No promoted personal knowledge found.\n";
  }

  return concepts
    .map((concept) =>
      [
        `- ${concept.id}`,
        `  Principle: ${concept.principle}`,
        `  Status: ${concept.status}; confidence: ${concept.confidence}`,
        `  Promoted: ${concept.timestamps?.promotedAt ?? concept.reviewedAt}`,
        `  Source: ${concept.provenance?.sourceSummary ?? `task ${concept.taskId}; review ${concept.reviewId}`}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function renderStatus(status: {
  activeTask: TaskRecord | null;
  counts: { capabilities: number; concepts: number };
  initialized: { personal: boolean; project: boolean };
  latestConcept: ConceptRecord | null;
  latestReview: ReviewSession | null;
  roots: { personal: string; project: string };
}): string {
  return [
    "# Growth Memory Status",
    "",
    `- Project root: ${status.roots.project}`,
    `- Personal root: ${status.roots.personal}`,
    `- Project initialized: ${status.initialized.project ? "yes" : "no"}`,
    `- Personal initialized: ${status.initialized.personal ? "yes" : "no"}`,
    `- Active task: ${status.activeTask ? `${status.activeTask.id} (${status.activeTask.title})` : "none"}`,
    `- Latest review: ${status.latestReview ? `${status.latestReview.id} (${status.latestReview.status})` : "none"}`,
    `- Latest concept: ${status.latestConcept ? status.latestConcept.id : "none"}`,
    `- Concepts: ${status.counts.concepts}`,
    `- Capabilities: ${status.counts.capabilities}`,
  ].join("\n");
}

function recommendationPath(projectBase: string, taskId: string): string {
  const parsedTaskId = parseWithSchema(
    restrictedIdSchema,
    taskId,
    "INVALID_IDENTIFIER",
    "Task identifier is invalid",
  );
  return safeChildPath(
    join(projectBase, "review-recommendations"),
    `${parsedTaskId}.json`,
  );
}

async function readCachedRecommendation(
  projectBase: string,
  taskId: string,
): Promise<ReviewRecommendation | undefined> {
  try {
    const stored = await readJson(
      recommendationPath(projectBase, taskId),
      reviewRecommendationFileSchema,
    );
    return stored.recommendation;
  } catch (error) {
    if (isFileNotFound(error)) {
      return undefined;
    }

    throw error;
  }
}

async function writeRecommendation(
  projectBase: string,
  taskId: string,
  recommendation: ReviewRecommendation,
): Promise<void> {
  await writeJsonAtomic(recommendationPath(projectBase, taskId), {
    taskId,
    recommendation,
  });
}

async function activeTaskId(projectRepository: ProjectRepository): Promise<string | undefined> {
  const state = await projectRepository.readState();
  return state.activeTaskId;
}

function assertPhase(current: ReviewPhase, expected: ReviewPhase, reviewId: string): void {
  if (current === expected) {
    return;
  }

  throw new DomainError(
    "REVIEW_PHASE_MISMATCH",
    `Review ${reviewId} is in ${current}, expected ${expected}`,
    {
      reviewId,
      currentPhase: current,
      expectedPhase: expected,
    },
  );
}

async function materializeRoots(projectRoot: string, personalRoot?: string) {
  const paths = resolvePaths(projectRoot, personalRoot);

  await Promise.all([
    withRootLock(paths.project.base, async () => {
      await Promise.all([
        ensureFile(paths.project.current, ""),
        ensureFile(
          paths.project.working,
          "# Working Memory\n\n## Active Task\nNo active task.\n",
        ),
        ensureJsonFile(paths.project.state, {
          version: 1,
          latestCheckpointByTaskId: {},
          latestReviewByTaskId: {},
        }),
      ]);
    }),
    withLocalRootLock(paths.personal.base, async () => {
      await Promise.all([
        ensureFile(paths.personal.index, "# Personal Knowledge Index\n\n"),
        ensureJsonFile(paths.personal.capabilities, { version: 1, records: [] }),
      ]);
    }),
  ]);

  return paths;
}

async function main(argv = process.argv): Promise<void> {
  const wantsJson = argv.includes("--json");
  const program = new Command();

  program
    .name("rookcue")
    .version(packageMetadata.version)
    .description("RookCue local-first experience library. Short command: gmem. Compatibility alias: growth-memory.")
    .showHelpAfterError(false)
    .exitOverride()
    .configureOutput({
      writeErr: () => undefined,
    });

  addJsonOption(addPersonalOption(addProjectOption(program.command("init"))))
    .description("materialize project and personal roots")
    .action(async (options: { json?: boolean; personal?: string; project: string }) => {
      const paths = await materializeRoots(options.project, options.personal);
      respondSuccess(Boolean(options.json), {
        roots: {
          project: paths.project.base,
          personal: paths.personal.base,
        },
      });
    });

  addJsonOption(addPersonalOption(addProjectOption(program.command("status"))))
    .description("show project and personal growth-memory status")
    .action(async (options: CommonOptions) => {
      const services = createServices(options.project, options.personal);
      const state = await services.projectRepository.readState();
      const concepts = await services.personalRepository.listConcepts();
      const capabilities = await services.personalRepository.readCapabilities();
      const latestReviewId = Object.values(state.latestReviewByTaskId).at(-1);
      const activeTask = state.activeTaskId
        ? await services.projectRepository.readTask(state.activeTaskId)
        : null;
      const latestReview = latestReviewId
        ? await services.projectRepository.readReview(latestReviewId)
        : null;
      const latestConcept = [...concepts].sort((left, right) =>
        right.reviewedAt.localeCompare(left.reviewedAt),
      )[0] ?? null;
      const status = {
        roots: {
          project: services.paths.project.base,
          personal: services.paths.personal.base,
        },
        initialized: {
          project: await pathExists(services.paths.project.base),
          personal: await pathExists(services.paths.personal.base),
        },
        activeTask,
        latestReview,
        latestConcept,
        counts: {
          concepts: concepts.length,
          capabilities: capabilities.records.length,
        },
      };

      respondText(Boolean(options.json), status, renderStatus(status));
    });

  registerGrowthCommands(program, { createServices, addJsonOption, addProjectOption, addPersonalOption, respondSuccess, respondText, parseWithSchema, parseEvidenceTokens, inputError: (message) => new CliInputError("INVALID_INPUT", message) });
  registerPeerCommands(program, { createServices, addJsonOption, addProjectOption, addPersonalOption, respondSuccess });

  const task = program.command("task").description("task lifecycle commands");

  addJsonOption(addProjectOption(task.command("start")))
    .description("start a task")
    .option("--type <type>", "explicit task type")
    .option("--concept <id...>", "related concept ids")
    .requiredOption("--title <text>", "task title")
    .requiredOption("--goal <text>", "task goal")
    .action(async (options: CommonOptions & { title: string; goal: string; type?: string; concept?: string[] }) => {
      const services = createServices(options.project, options.personal);
      const record = await services.projectService.startTask({
        title: options.title,
        goal: options.goal,
        ...(options.type ? { type: parseWithSchema(taskTypeSchema, options.type, "INVALID_INPUT", "Invalid task type") } : {}),
        ...(options.concept ? { conceptIds: options.concept } : {}),
      });
      respondSuccess(Boolean(options.json), record);
    });

  addJsonOption(addProjectOption(task.command("event")))
    .description("record a task event")
    .option("--task <id>", "task id")
    .requiredOption("--type <name>", "event type")
    .requiredOption("--summary <text>", "event summary")
    .option("--evidence <ref...>", "evidence in kind:id form")
    .action(
      async (
        options: CommonOptions & {
          evidence?: string[];
          summary: string;
          task?: string;
          type: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const event = await services.projectService.recordEvent({
          ...(options.task ? { taskId: options.task } : {}),
          type: options.type,
          summary: options.summary,
          evidence: parseEvidenceTokens(options.evidence),
        });
        respondSuccess(Boolean(options.json), event);
      },
    );

  addJsonOption(addProjectOption(task.command("checkpoint")))
    .description("record a checkpoint")
    .requiredOption("--task <id>", "task id")
    .requiredOption("--reason <reason>", "manual|interval|trigger|interrupt|review")
    .requiredOption("--snapshot <json>", "snapshot JSON object")
    .option("--phase <phase>", "review phase")
    .action(
      async (
        options: CommonOptions & {
          phase?: string;
          reason: string;
          snapshot: string;
          task: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const reason = parseWithSchema(
          z.enum(["manual", "interval", "trigger", "interrupt", "review"]),
          options.reason,
          "INVALID_INPUT",
          "Checkpoint reason is invalid",
        );
        const phase =
          options.phase === undefined
            ? undefined
            : parseWithSchema(
                reviewPhaseSchema,
                options.phase,
                "INVALID_INPUT",
                "Checkpoint phase is invalid",
              );
        const snapshot = parseJsonValue(
          "Checkpoint snapshot",
          options.snapshot,
          z.record(z.string(), z.unknown()),
        );
        const checkpoint = await services.projectService.checkpoint(
          options.task,
          reason,
          snapshot,
          phase,
        );
        respondSuccess(Boolean(options.json), checkpoint);
      },
    );

  addJsonOption(addProjectOption(task.command("complete")))
    .description("complete a task")
    .requiredOption("--task <id>", "task id")
    .requiredOption("--summary <text>", "completion summary")
    .action(async (options: CommonOptions & { summary: string; task: string }) => {
      const services = createServices(options.project, options.personal);
      const taskRecord = await services.projectService.completeTask(
        options.task,
        options.summary,
      );
      respondSuccess(Boolean(options.json), taskRecord);
    });

  const context = program.command("context").description("context inspection commands");

  addJsonOption(addProjectOption(context.command("show")))
    .description("show current and working context")
    .action(async (options: CommonOptions) => {
      const services = createServices(options.project, options.personal);
      const loaded = await services.projectService.loadContext();
      respondSuccess(Boolean(options.json), loaded);
    });

  addJsonOption(addProjectOption(context.command("update")))
    .description("replace stable current context")
    .requiredOption("--markdown <text>", "current knowledge markdown")
    .requiredOption("--evidence <ref...>", "evidence in kind:id form")
    .action(async (options: CommonOptions & { evidence: string[]; markdown: string }) => {
      const services = createServices(options.project, options.personal);
      await services.projectService.updateCurrent(
        options.markdown,
        parseEvidenceTokens(options.evidence),
      );
      respondSuccess(Boolean(options.json), { updated: true });
    });

  const personal = program.command("personal").description("personal asset commands");

  addJsonOption(addPersonalOption(addProjectOption(personal.command("export"))))
    .description("export the personal knowledge root as a portable bundle")
    .requiredOption("--out <dir>", "directory that will receive a timestamped export")
    .action(async (options: CommonOptions & { out: string }) => {
      const services = createServices(options.project, options.personal);
      const result = await services.personalAssetService.exportPersonal(options.out);
      respondText(Boolean(options.json), result, renderExportResult(result));
    });

  addJsonOption(addPersonalOption(addProjectOption(personal.command("verify"))))
    .description("verify a personal export bundle manifest and file digests")
    .requiredOption("--bundle <dir>", "export bundle directory")
    .action(async (options: CommonOptions & { bundle: string }) => {
      const services = createServices(options.project, options.personal);
      const result = await services.personalAssetService.verifyPersonalBundle(
        options.bundle,
      );
      respondText(Boolean(options.json), result, renderVerifyResult(result));
    });

  addJsonOption(addPersonalOption(addProjectOption(personal.command("import"))))
    .description("preview importing a personal export bundle")
    .requiredOption("--bundle <dir>", "export bundle directory")
    .option("--dry-run", "preview import without writing data")
    .action(async (options: CommonOptions & { bundle: string; dryRun?: boolean }) => {
      if (!options.dryRun) {
        throw new DomainError(
          "IMPORT_REQUIRES_DRY_RUN",
          "Personal import currently supports --dry-run only",
          {},
        );
      }
      const services = createServices(options.project, options.personal);
      const result = await services.personalAssetService.importPersonalBundleDryRun(
        options.bundle,
      );
      respondText(Boolean(options.json), result, renderImportDryRun(result));
    });

  const cloud = program.command("cloud").description("optional encrypted cloud commands");

  const remote = cloud.command("remote").description("user-owned cloud remote commands");

  addJsonOption(addPersonalOption(addProjectOption(remote.command("check"))))
    .description("check a user-owned remote without writing knowledge data")
    .requiredOption("--remote <target>", "remote target, such as ./remote or s3://bucket/prefix")
    .action(async (options: CommonOptions & { remote: string }) => {
      const services = createServices(options.project, options.personal);
      const result = await services.cloudService.checkRemote(options.remote);
      respondText(Boolean(options.json), result, renderCloudRemoteCheck(result));
    });

  addJsonOption(addPersonalOption(addProjectOption(cloud.command("status"))))
    .description("show encrypted cloud remote status")
    .requiredOption("--remote <target>", "cloud remote target, such as ./remote or s3://bucket/prefix")
    .action(async (options: CommonOptions & { remote: string }) => {
      const services = createServices(options.project, options.personal);
      const result = await services.cloudService.status(options.remote);
      respondText(Boolean(options.json), result, renderCloudStatus(result));
    });

  addJsonOption(addPersonalOption(addProjectOption(cloud.command("backup"))))
    .description("backup personal knowledge to an encrypted cloud remote")
    .requiredOption("--remote <target>", "cloud remote target, such as ./remote or s3://bucket/prefix")
    .option("--dry-run", "preview backup without writing remote objects")
    .option("--passphrase <text>", "encryption passphrase")
    .action(
      async (
        options: CommonOptions & {
          dryRun?: boolean;
          passphrase?: string;
          remote: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const result = await services.cloudService.backup({
          dryRun: Boolean(options.dryRun),
          passphrase: resolveCloudPassphrase(options.passphrase),
          remoteTarget: options.remote,
        });
        respondText(Boolean(options.json), result, renderCloudBackup(result));
      },
    );

  addJsonOption(addPersonalOption(addProjectOption(cloud.command("restore"))))
    .description("preview restoring personal knowledge from an encrypted remote")
    .requiredOption("--remote <target>", "cloud remote target, such as ./remote or s3://bucket/prefix")
    .option("--dry-run", "preview restore without writing local data")
    .option("--passphrase <text>", "encryption passphrase")
    .action(
      async (
        options: CommonOptions & {
          dryRun?: boolean;
          passphrase?: string;
          remote: string;
        },
      ) => {
        if (!options.dryRun) {
          throw new DomainError(
            "CLOUD_RESTORE_REQUIRES_DRY_RUN",
            "Cloud restore currently supports --dry-run only",
            {},
          );
        }
        const services = createServices(options.project, options.personal);
        const result = await services.cloudService.restoreDryRun({
          passphrase: resolveCloudPassphrase(options.passphrase),
          remoteTarget: options.remote,
        });
        respondText(Boolean(options.json), result, renderCloudRestoreDryRun(result));
      },
    );

  addJsonOption(addPersonalOption(addProjectOption(cloud.command("sync"))))
    .description("sync personal knowledge with an encrypted remote")
    .requiredOption("--remote <target>", "cloud remote target, such as ./remote or s3://bucket/prefix")
    .option("--dry-run", "preview sync without writing local or remote data")
    .option("--apply", "apply a conflict-free sync plan")
    .option("--passphrase <text>", "encryption passphrase")
    .action(
      async (
        options: CommonOptions & {
          apply?: boolean;
          dryRun?: boolean;
          passphrase?: string;
          remote: string;
        },
      ) => {
        if (options.dryRun && options.apply) {
          throw new DomainError(
            "CLOUD_SYNC_MODE_CONFLICT",
            "Cloud sync accepts either --dry-run or --apply, not both",
            {},
          );
        }
        if (!options.dryRun && !options.apply) {
          throw new DomainError(
            "CLOUD_SYNC_MODE_REQUIRED",
            "Cloud sync requires either --dry-run or --apply",
            {},
          );
        }
        const services = createServices(options.project, options.personal);
        const result = options.apply
          ? await services.cloudService.syncApply({
              passphrase: resolveCloudPassphrase(options.passphrase),
              remoteTarget: options.remote,
            })
          : await services.cloudService.syncDryRun({
              passphrase: resolveCloudPassphrase(options.passphrase),
              remoteTarget: options.remote,
            });
        respondText(Boolean(options.json), result, renderCloudSync(result));
      },
    );

  const conflict = cloud.command("conflict").description("inspect and resolve cloud sync conflicts");

  addJsonOption(addPersonalOption(addProjectOption(conflict.command("list"))))
    .description("list cloud sync conflicts")
    .requiredOption("--remote <target>", "cloud remote target, such as ./remote or s3://bucket/prefix")
    .option("--passphrase <text>", "encryption passphrase")
    .action(async (options: CommonOptions & { passphrase?: string; remote: string }) => {
      const services = createServices(options.project, options.personal);
      const result = await services.cloudService.listConflicts({
        passphrase: resolveCloudPassphrase(options.passphrase),
        remoteTarget: options.remote,
      });
      respondText(Boolean(options.json), result, renderCloudConflictList(result));
    });

  addJsonOption(addPersonalOption(addProjectOption(conflict.command("show"))))
    .description("show one cloud sync conflict")
    .requiredOption("--remote <target>", "cloud remote target, such as ./remote or s3://bucket/prefix")
    .requiredOption("--path <path>", "conflicted personal path")
    .option("--passphrase <text>", "encryption passphrase")
    .action(
      async (
        options: CommonOptions & { passphrase?: string; path: string; remote: string },
      ) => {
        const services = createServices(options.project, options.personal);
        const result = await services.cloudService.showConflict({
          passphrase: resolveCloudPassphrase(options.passphrase),
          remoteTarget: options.remote,
          path: options.path,
        });
        respondText(Boolean(options.json), result, renderCloudConflictShow(result));
      },
    );

  addJsonOption(addPersonalOption(addProjectOption(conflict.command("resolve"))))
    .description("resolve one cloud sync conflict")
    .requiredOption("--remote <target>", "cloud remote target, such as ./remote or s3://bucket/prefix")
    .requiredOption("--path <path>", "conflicted personal path")
    .requiredOption("--strategy <strategy>", "local, remote, both, or skip")
    .option("--passphrase <text>", "encryption passphrase")
    .action(
      async (
        options: CommonOptions & {
          passphrase?: string;
          path: string;
          remote: string;
          strategy: CloudConflictStrategy;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const result = await services.cloudService.resolveConflict({
          passphrase: resolveCloudPassphrase(options.passphrase),
          remoteTarget: options.remote,
          path: options.path,
          strategy: options.strategy,
        });
        respondText(Boolean(options.json), result, renderCloudConflictResolve(result));
      },
    );

  addJsonOption(addPersonalOption(addProjectOption(cloud.command("cleanup"))))
    .description("preview or apply cloud remote cleanup")
    .requiredOption("--remote <target>", "cloud remote target, such as ./remote or s3://bucket/prefix")
    .option("--dry-run", "preview cleanup without deleting remote objects")
    .option("--apply", "delete eligible orphan remote objects")
    .action(
      async (
        options: CommonOptions & {
          apply?: boolean;
          dryRun?: boolean;
          remote: string;
        },
      ) => {
        if (options.dryRun && options.apply) {
          throw new DomainError(
            "CLOUD_CLEANUP_MODE_CONFLICT",
            "Cloud cleanup accepts either --dry-run or --apply, not both",
            {},
          );
        }
        if (!options.dryRun && !options.apply) {
          throw new DomainError(
            "CLOUD_CLEANUP_MODE_REQUIRED",
            "Cloud cleanup requires either --dry-run or --apply",
            {},
          );
        }
        const services = createServices(options.project, options.personal);
        const result = options.apply
          ? await services.cloudService.cleanupApply({ remoteTarget: options.remote })
          : await services.cloudService.cleanupDryRun({ remoteTarget: options.remote });
        respondText(Boolean(options.json), result, renderCloudCleanup(result));
      },
    );

  const evolution = program.command("evolution").description("evolution history commands");

  addJsonOption(addProjectOption(evolution.command("add")))
    .description("append an evolution entry")
    .requiredOption("--title <text>", "evolution title")
    .requiredOption("--before <text>", "before state")
    .requiredOption("--after <text>", "after state")
    .requiredOption("--reason <text>", "reason")
    .requiredOption("--impact <text>", "impact")
    .requiredOption("--evidence <ref...>", "evidence in kind:id form")
    .action(
      async (
        options: CommonOptions & {
          after: string;
          before: string;
          evidence: string[];
          impact: string;
          reason: string;
          title: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const path = await services.projectService.recordEvolution({
          title: options.title,
          before: options.before,
          after: options.after,
          reason: options.reason,
          impact: options.impact,
          evidence: parseEvidenceTokens(options.evidence),
        });
        respondSuccess(Boolean(options.json), { path });
      },
    );

  const review = program.command("review").description("review protocol commands");

  addJsonOption(addPersonalOption(addProjectOption(review.command("recommend"))))
    .description("compute and optionally cache a review recommendation")
    .option("--history", "use personal growth history")
    .option("--task <id>", "task id to associate with the recommendation")
    .option("--signal <signal...>", "review signal")
    .action(
      async (
        options: CommonOptions & {
          signal?: string[];
          task?: string;
          history?: boolean;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const signals = (options.signal ?? []).map((signal) =>
          parseWithSchema(
            reviewSignalSchema,
            signal,
            "INVALID_INPUT",
            "Review signal is invalid",
          ),
        );
        const taskId = options.task ?? (await activeTaskId(services.projectRepository));
        const recommendation = options.history ? await services.growthService.recommend({ ...(taskId ? {taskId} : {}), signals }) : recommendReview(signals);

        if (taskId) {
          await services.projectRepository.withMutationLock(async () => {
            await services.projectRepository.readTask(taskId);
            await writeRecommendation(
              services.paths.project.base,
              taskId,
              recommendation,
            );
          });
        }

        respondSuccess(Boolean(options.json), recommendation);
      },
    );

  addJsonOption(addProjectOption(review.command("start")))
    .description("start a review")
    .requiredOption("--task <id>", "task id")
    .requiredOption("--level <level>", "skip|quick|deep")
    .option("--signal <signal...>", "signals to generate a fresh recommendation")
    .action(
      async (
        options: CommonOptions & {
          level: string;
          signal?: string[];
          task: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const level = parseWithSchema(
          reviewLevelSchema,
          options.level,
          "INVALID_INPUT",
          "Review level is invalid",
        );
        const recommendation =
          level === "deep"
            ? options.signal && options.signal.length > 0
              ? recommendReview(
                  options.signal.map((signal) =>
                    parseWithSchema(
                      reviewSignalSchema,
                      signal,
                      "INVALID_INPUT",
                      "Review signal is invalid",
                    ),
                  ),
                )
              : await readCachedRecommendation(services.paths.project.base, options.task)
            : undefined;
        const started = await services.reviewService.start({
          taskId: options.task,
          level,
          recommendation,
          selectedBy: "human",
        });
        respondSuccess(Boolean(options.json), started);
      },
    );

  addJsonOption(addProjectOption(review.command("respond")))
    .description("record human review input")
    .requiredOption("--review <id>", "review id")
    .requiredOption("--phase <phase>", "context|reconstruct|challenge|correct")
    .requiredOption("--text <text>", "response text")
    .option("--evidence <ref...>", "evidence in kind:id form")
    .action(
      async (
        options: CommonOptions & {
          evidence?: string[];
          phase: string;
          review: string;
          text: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const phase = parseWithSchema(
          z.enum(["context", "reconstruct", "challenge", "correct"]),
          options.phase,
          "INVALID_INPUT",
          "Review response phase is invalid",
        );
        const currentPhase = (
          await services.projectRepository.readReview(options.review)
        ).phase;
        assertPhase(currentPhase, phase, options.review);
        const entry = await services.reviewService.addEntry(options.review, {
          actor: "human",
          kind: phase === "context" ? "decision" : "response",
          content: options.text,
          evidence: parseEvidenceTokens(options.evidence),
        });
        const updated = await services.projectRepository.readReview(options.review);
        respondSuccess(Boolean(options.json), {
          review: updated,
          entry,
        });
      },
    );

  addJsonOption(addProjectOption(review.command("question")))
    .description("record an AI challenge question")
    .requiredOption("--review <id>", "review id")
    .requiredOption("--text <text>", "question text")
    .option("--template <id>", "optional challenge template: five-whys|aar|kpt|feynman")
    .option("--evidence <ref...>", "evidence in kind:id form")
    .action(
      async (
        options: CommonOptions & {
          evidence?: string[];
          review: string;
          template?: string;
          text: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const current = await services.projectRepository.readReview(options.review);
        assertPhase(current.phase, "challenge", options.review);
        const template = options.template
          ? parseWithSchema(
              reviewTemplateIdSchema,
              options.template,
              "INVALID_REVIEW_TEMPLATE",
              "Review template must be one of five-whys, aar, kpt, or feynman",
            )
          : undefined;
        const entry = await services.reviewService.addEntry(options.review, {
          actor: "ai",
          kind: "question",
          content: renderChallengeQuestion(template, options.text),
          templateId: template,
          evidence: parseEvidenceTokens(options.evidence),
        });
        respondSuccess(Boolean(options.json), entry);
      },
    );

  addJsonOption(addProjectOption(review.command("correct")))
    .description("record an AI correction")
    .requiredOption("--review <id>", "review id")
    .requiredOption("--text <text>", "correction text")
    .option("--evidence <ref...>", "evidence in kind:id form")
    .action(
      async (
        options: CommonOptions & {
          evidence?: string[];
          review: string;
          text: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const current = await services.projectRepository.readReview(options.review);
        assertPhase(current.phase, "correct", options.review);
        const entry = await services.reviewService.addEntry(options.review, {
          actor: "ai",
          kind: "correction",
          content: options.text,
          evidence: parseEvidenceTokens(options.evidence),
        });
        respondSuccess(Boolean(options.json), entry);
      },
    );

  addJsonOption(addProjectOption(review.command("transfer")))
    .description("record a human transfer answer")
    .requiredOption("--review <id>", "review id")
    .requiredOption("--text <text>", "transfer answer")
    .option("--template <id>", "optional transfer template: five-whys|aar|kpt|feynman")
    .option("--evidence <ref...>", "evidence in kind:id form")
    .action(
      async (
        options: CommonOptions & {
          evidence?: string[];
          review: string;
          template?: string;
          text: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const current = await services.projectRepository.readReview(options.review);
        assertPhase(current.phase, "transfer", options.review);
        const template = options.template
          ? parseWithSchema(
              reviewTemplateIdSchema,
              options.template,
              "INVALID_REVIEW_TEMPLATE",
              "Review template must be one of five-whys, aar, kpt, or feynman",
            )
          : undefined;
        const entry = await services.reviewService.addEntry(options.review, {
          actor: "human",
          kind: "transfer-answer",
          content: renderTransferAnswer(template, options.text),
          templateId: template,
          evidence: parseEvidenceTokens(options.evidence),
        });
        respondSuccess(Boolean(options.json), entry);
      },
    );

  addJsonOption(addProjectOption(review.command("advance")))
    .description("advance a review to the next phase")
    .requiredOption("--review <id>", "review id")
    .action(async (options: CommonOptions & { review: string }) => {
      const services = createServices(options.project, options.personal);
      const updated = await services.reviewService.advance(options.review);
      respondSuccess(Boolean(options.json), updated);
    });

  addJsonOption(addProjectOption(review.command("interrupt")))
    .description("interrupt a review and checkpoint it")
    .requiredOption("--review <id>", "review id")
    .action(async (options: CommonOptions & { review: string }) => {
      const services = createServices(options.project, options.personal);
      const updated = await services.reviewService.interrupt(options.review);
      respondSuccess(Boolean(options.json), updated);
    });

  addJsonOption(addProjectOption(review.command("resume")))
    .description("resume an interrupted review")
    .requiredOption("--review <id>", "review id")
    .action(async (options: CommonOptions & { review: string }) => {
      const services = createServices(options.project, options.personal);
      const updated = await services.reviewService.resume(options.review);
      respondSuccess(Boolean(options.json), updated);
    });

  addJsonOption(addProjectOption(review.command("show")))
    .description("show a review")
    .requiredOption("--review <id>", "review id")
    .action(async (options: CommonOptions & { review: string }) => {
      const services = createServices(options.project, options.personal);
      const current = await services.projectRepository.readReview(options.review);
      respondSuccess(Boolean(options.json), current);
    });

  const knowledge = program.command("knowledge").description("personal knowledge commands");

  addJsonOption(addPersonalOption(addProjectOption(knowledge.command("show"))))
    .description("show a promoted personal knowledge concept")
    .requiredOption("--concept <id>", "concept id")
    .action(
      async (
        options: CommonOptions & {
          concept: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const concept = await services.personalRepository.readConcept(options.concept);
        respondText(Boolean(options.json), concept, renderConceptMarkdown(concept));
      },
    );

  addJsonOption(addPersonalOption(addProjectOption(knowledge.command("list"))))
    .description("list promoted personal knowledge concepts")
    .action(async (options: CommonOptions) => {
      const services = createServices(options.project, options.personal);
      const concepts = await services.personalRepository.listConcepts();
      respondText(Boolean(options.json), concepts, renderConceptList(concepts));
    });

  addJsonOption(addPersonalOption(addProjectOption(knowledge.command("search"))))
    .description("search promoted personal knowledge concepts")
    .requiredOption("--query <text>", "search query")
    .option("--limit <number>", "maximum number of results", "10")
    .action(
      async (
        options: CommonOptions & {
          limit: string;
          query: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const limit = parseWithSchema(
          z.coerce.number().int().min(1).max(100),
          options.limit,
          "INVALID_INPUT",
          "Search limit must be an integer between 1 and 100",
        );
        const results = await services.personalAssetService.searchKnowledge(
          options.query,
          limit,
        );
        respondText(Boolean(options.json), results, renderSearchResults(results));
      },
    );

  addJsonOption(addPersonalOption(addProjectOption(knowledge.command("timeline"))))
    .description("show promoted personal knowledge timeline")
    .action(async (options: CommonOptions) => {
      const services = createServices(options.project, options.personal);
      const timeline = await services.personalAssetService.knowledgeTimeline();
      respondText(Boolean(options.json), timeline, renderTimeline(timeline));
    });

  addJsonOption(addPersonalOption(addProjectOption(knowledge.command("digest"))))
    .description("summarize promoted personal knowledge for human review")
    .action(async (options: CommonOptions) => {
      const services = createServices(options.project, options.personal);
      const digest = await services.personalAssetService.knowledgeDigest();
      respondText(Boolean(options.json), digest, renderDigest(digest));
    });

  addJsonOption(addPersonalOption(addProjectOption(knowledge.command("provenance"))))
    .description("show full provenance for a promoted personal knowledge concept")
    .requiredOption("--concept <id>", "concept id")
    .action(async (options: CommonOptions & { concept: string }) => {
      const services = createServices(options.project, options.personal);
      const provenance = await services.personalAssetService.knowledgeProvenance(
        options.concept,
      );
      respondText(Boolean(options.json), provenance, renderProvenance(provenance));
    });

  addJsonOption(addPersonalOption(addProjectOption(knowledge.command("propose"))))
    .description("propose knowledge candidates from a completed review")
    .requiredOption("--review <id>", "review id")
    .option("--candidate <json...>", "candidate JSON object")
    .action(
      async (
        options: CommonOptions & {
          candidate?: string[];
          review: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const reviewSession = await services.projectRepository.readReview(options.review);
        const candidates = (options.candidate ?? []).map((candidate, index) =>
          parseJsonValue(
            `Candidate ${index + 1}`,
            candidate,
            z.object({
              principle: z.string().min(1),
              boundary: z.string().min(1),
              evidence: z.array(evidenceRefSchema).min(1),
            }),
          ),
        );
        const proposed = await services.knowledgeService.propose(
          reviewSession,
          candidates,
        );
        respondSuccess(Boolean(options.json), proposed);
      },
    );

  addJsonOption(addPersonalOption(addProjectOption(knowledge.command("decide"))))
    .description("approve or reject a knowledge candidate")
    .requiredOption("--candidate <id>", "candidate id")
    .requiredOption("--decision <decision>", "approve|reject")
    .requiredOption("--actor <actor>", "explicit decision actor; must be human")
    .requiredOption("--source <source>", "source of the explicit human decision")
    .action(
      async (
        options: CommonOptions & {
          actor: string;
          candidate: string;
          decision: string;
          source: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const candidate = await services.knowledgeService.decide(options.candidate, {
          actor: parseWithSchema(
            z.literal("human"),
            options.actor,
            "INVALID_INPUT",
            "Knowledge decision actor is invalid",
          ),
          decision: parseWithSchema(
            z.enum(["approve", "reject"]),
            options.decision,
            "INVALID_INPUT",
            "Knowledge decision is invalid",
          ),
          source: options.source,
        });
        respondSuccess(Boolean(options.json), candidate);
      },
    );

  addJsonOption(addPersonalOption(addProjectOption(knowledge.command("promote"))))
    .description("promote an approved candidate")
    .requiredOption("--candidate <id>", "candidate id")
    .requiredOption("--confidence <number>", "confidence 0..1")
    .action(
      async (
        options: CommonOptions & {
          candidate: string;
          confidence: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const confidence = parseWithSchema(
          z.coerce.number().min(0).max(1),
          options.confidence,
          "INVALID_INPUT",
          "Confidence must be a number between 0 and 1",
        );
        const concept = await services.knowledgeService.promote(options.candidate, {
          confidence,
        });
        respondSuccess(Boolean(options.json), concept);
      },
    );

  addJsonOption(addPersonalOption(addProjectOption(knowledge.command("revise"))))
    .description("revise an existing concept")
    .requiredOption("--concept <id>", "concept id")
    .requiredOption("--summary <text>", "revision summary")
    .option("--principle <text>", "updated principle")
    .option("--boundary <text>", "updated boundary")
    .option("--confidence <number>", "confidence 0..1")
    .option("--status <status>", "approved|obsolete")
    .requiredOption("--evidence <ref...>", "evidence in kind:id form")
    .action(
      async (
        options: CommonOptions & {
          boundary?: string;
          concept: string;
          confidence?: string;
          evidence: string[];
          principle?: string;
          status?: string;
          summary: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const concept = await services.knowledgeService.reviseEntry(options.concept, {
          ...(options.principle ? { principle: options.principle } : {}),
          ...(options.boundary ? { boundary: options.boundary } : {}),
          ...(options.confidence
            ? {
                confidence: parseWithSchema(
                  z.coerce.number().min(0).max(1),
                  options.confidence,
                  "INVALID_INPUT",
                  "Confidence must be a number between 0 and 1",
                ),
              }
            : {}),
          ...(options.status
            ? {
                status: parseWithSchema(
                  z.enum(["approved", "obsolete"]),
                  options.status,
                  "INVALID_INPUT",
                  "Knowledge status is invalid",
                ),
              }
            : {}),
          summary: options.summary,
          evidence: parseEvidenceTokens(options.evidence),
        });
        respondSuccess(Boolean(options.json), concept);
      },
    );

  const capability = program.command("capability").description("capability commands");

  addJsonOption(addPersonalOption(addProjectOption(capability.command("update"))))
    .description("update capability evidence for a concept")
    .option("--operation <id>", "stable retry identity")
    .option("--rationale <text>", "human rationale")
    .requiredOption("--concept <id>", "concept id")
    .requiredOption("--level <level>", "seen|understood|explainable|independent")
    .requiredOption("--evidence <json...>", "capability evidence JSON")
    .action(
      async (
        options: CommonOptions & {
          concept: string;
          evidence: string[];
          level: string;
          operation?: string;
          rationale?: string;
        },
      ) => {
        const services = createServices(options.project, options.personal);
        const record = await services.knowledgeService.updateCapability(options.concept, {
          operationId: options.operation,
          rationale: options.rationale,
          level: parseWithSchema(
            z.enum(["seen", "understood", "explainable", "independent"]),
            options.level,
            "INVALID_INPUT",
            "Capability level is invalid",
          ),
          evidence: options.evidence.map((item, index) =>
            parseJsonValue(`Capability evidence ${index + 1}`, item, capabilityEvidenceSchema),
          ),
        });
        respondSuccess(Boolean(options.json), record);
      },
    );

  addJsonOption(addPersonalOption(addProjectOption(capability.command("list"))))
    .description("list capability records")
    .action(async (options: CommonOptions) => {
      const services = createServices(options.project, options.personal);
      const state = await services.personalRepository.readCapabilities();
      respondSuccess(Boolean(options.json), state.records);
    });

  await program.parseAsync(argv);
}

main().catch((error: unknown) => {
  if (error instanceof CommanderError) {
    if (
      error.code === "commander.helpDisplayed" ||
      error.code === "commander.version"
    ) {
      process.exitCode = 0;
      return;
    }
  }

  const wantsJson = process.argv.includes("--json") || (process.argv.includes("growth") && process.argv.includes("report") && (process.argv.includes("--format=json") || process.argv.some((arg, index) => arg === "--format" && process.argv[index + 1] === "json")));
  if (wantsJson) {
    writeEnvelope({
      ok: false,
      error: serializeError(error),
    });
  } else if (error instanceof DomainError || error instanceof CliInputError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else if (error instanceof CommanderError) {
    process.stderr.write(`${error.message}\n`);
  } else if (error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write("Unexpected error\n");
  }

  process.exitCode = exitCodeFor(error);
});
