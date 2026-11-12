import { z } from "zod";
import { dirname, join } from "node:path";

import { DomainError } from "../domain/errors.js";
import { EvidenceResolver } from "../domain/evidence-resolver.js";
import {
  restrictedIdSchema,
  capabilityInputIdentitySchema,
  capabilityEvidenceSchema,
  capabilityRecordSchema,
  capabilityStateSchema,
  conceptRecordSchema,
  evidenceRefSchema,
  knowledgeCandidateSchema,
  knowledgeDecisionReceiptSchema,
  personalReviewStateSchema,
  reviewSessionSchema,
  type CapabilityEvidence,
  type CapabilityRecord,
  type ConceptRecord,
  type EvidenceRef,
  type KnowledgeCandidate,
  type KnowledgeDecisionReceipt,
  type KnowledgeProvenance,
  type KnowledgeTimestamps,
  type ReviewSession,
} from "../domain/schema.js";
import { PersonalRepository } from "../storage/personal-repository.js";
import { ProjectRepository } from "../storage/project-repository.js";
import { contentFingerprint } from "../growth/schema.js";
import { legacyCapabilityBaselines } from "../growth/capability-history.js";
import { assertSafePath } from "../storage/snapshot-files.js";
import { assertSeparateStorageRoots } from "../storage/paths.js";
import { candidateDigest, revisionDigest } from "./candidate-identity.js";

const candidateDraftSchema = z.object({
  principle: z.string().min(1),
  boundary: z.string().min(1),
  evidence: z.array(evidenceRefSchema).min(1),
});

const decisionInputSchema = z.object({
  actor: z.enum(["human", "ai", "system"]),
  decision: z.enum(["approve", "reject"]),
  source: z.string().trim().min(1),
});

const promoteInputSchema = z.object({
  confidence: z.number().min(0).max(1),
});

const capabilityUpdateInputSchema = z.object({
  operationId: restrictedIdSchema.optional(),
  rationale: z.string().min(1).optional(),
  level: z.enum(["seen", "understood", "explainable", "independent"]),
  evidence: z.array(capabilityEvidenceSchema).min(1),
});

const reviseEntryInputSchema = z
  .object({
    principle: z.string().min(1).optional(),
    boundary: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    status: z.enum(["approved", "obsolete"]).optional(),
    summary: z.string().min(1),
    evidence: z.array(evidenceRefSchema).min(1),
  })
  .refine(
    (value) =>
      value.principle !== undefined ||
      value.boundary !== undefined ||
      value.confidence !== undefined ||
      value.status !== undefined,
    {
      message: "At least one knowledge field must change",
      path: ["summary"],
    },
  );

type CandidateDraft = z.infer<typeof candidateDraftSchema>;
type DecisionInput = z.infer<typeof decisionInputSchema>;
type PromoteInput = z.infer<typeof promoteInputSchema>;
type CapabilityUpdateInput = z.infer<typeof capabilityUpdateInputSchema>;
type ReviseEntryInput = z.infer<typeof reviseEntryInputSchema>;

const projectEvidenceKinds = new Set<EvidenceRef["kind"]>([
  "task",
  "event",
  "checkpoint",
  "commit",
  "test",
]);

export class KnowledgeService {
  private readonly evidenceResolver: EvidenceResolver;

  constructor(
    private readonly repository: PersonalRepository,
    private readonly projectRepository: ProjectRepository,
    private readonly options: {
      clock: () => Date;
      id: () => string;
    },
  ) {
    this.evidenceResolver = new EvidenceResolver(this.projectRepository);
  }

  async propose(
    review: ReviewSession,
    candidates: CandidateDraft[],
  ): Promise<KnowledgeCandidate[]> {
    await this.assertReviewOwnership();
    return this.repository.withMutationLock(() =>
      this.proposeUnlocked(review, candidates),
    );
  }

  private async proposeUnlocked(
    review: ReviewSession,
    candidates: CandidateDraft[],
  ): Promise<KnowledgeCandidate[]> {
    const parsedReview = this.parseInput(
      "INVALID_REVIEW",
      "Review session is invalid",
      reviewSessionSchema,
      review,
    );

    if (parsedReview.status !== "completed" || parsedReview.phase !== "complete") {
      throw new DomainError(
        "REVIEW_NOT_COMPLETE",
        "Knowledge promotion requires a completed review",
        {
          reviewId: parsedReview.id,
          status: parsedReview.status,
          phase: parsedReview.phase,
        },
      );
    }
    const storedReview = await this.evidenceResolver.resolveCompletedReview(
      parsedReview.id,
      parsedReview.taskId,
    );

    if (candidates.length > 3) {
      throw new DomainError(
        "TOO_MANY_CANDIDATES",
        "A review may produce at most three knowledge candidates",
        {
          reviewId: parsedReview.id,
          candidateCount: candidates.length,
        },
      );
    }

    const candidateDrafts =
      candidates.length > 0 ? candidates : this.proposeFromReview(parsedReview);

    const parsedCandidates = candidateDrafts.map((candidate) =>
      this.parseInput(
        "INVALID_KNOWLEDGE_CANDIDATE",
        "Knowledge candidates require a principle, boundary, and evidence",
        candidateDraftSchema,
        candidate,
      ),
    );
    for (const candidate of parsedCandidates) {
      this.assertHasProjectEvidence(candidate.evidence);
      await this.evidenceResolver.resolveAll(candidate.evidence);
    }
    const reviewState = personalReviewStateSchema.parse({
      version: 1,
      reviewId: storedReview.id,
      taskId: storedReview.taskId,
      proposedAt: this.now(),
      candidates: parsedCandidates.map((candidate, index) =>
        knowledgeCandidateSchema.parse({
          id: this.candidateId(parsedReview.id, index + 1),
          reviewId: parsedReview.id,
          ordinal: index + 1,
          principle: candidate.principle,
          boundary: candidate.boundary,
          evidence: candidate.evidence,
          status: "candidate",
        }),
      ),
    });

    await this.repository.saveReviewState(reviewState);
    await this.repository.writePractice(
      parsedReview.id,
      this.renderPracticeMarkdown(storedReview),
    );

    return reviewState.candidates;
  }

  async decide(
    candidateId: string,
    input: DecisionInput,
  ): Promise<{ candidate: KnowledgeCandidate; receipt: KnowledgeDecisionReceipt }> {
    await this.assertReviewOwnership();
    return this.repository.withMutationLock(() => this.decideUnlocked(candidateId, input));
  }

  private async decideUnlocked(
    candidateId: string,
    input: DecisionInput,
  ): Promise<{ candidate: KnowledgeCandidate; receipt: KnowledgeDecisionReceipt }> {
    if (
      typeof input !== "object" ||
      input === null ||
      !("source" in input) ||
      typeof input.source !== "string" ||
      input.source.trim().length === 0
    ) {
      throw new DomainError(
        "DECISION_SOURCE_REQUIRED",
        "Human knowledge decisions require an explicit source",
        { candidateId },
      );
    }
    const parsedInput = this.parseInput(
      "INVALID_KNOWLEDGE_DECISION",
      "Knowledge decision is invalid",
      decisionInputSchema,
      input,
    );

    if (parsedInput.actor !== "human") {
      throw new DomainError(
        "HUMAN_DECISION_REQUIRED",
        "Only a human may approve or reject personal knowledge candidates",
        { candidateId, actor: parsedInput.actor },
      );
    }

    const reviewState = await this.requireReviewState(candidateId);
    const candidate = this.requireCandidate(reviewState.candidates, candidateId);
    const nextStatus = parsedInput.decision === "approve" ? "approved" : "rejected";
    const nextCandidate = knowledgeCandidateSchema.parse({
      ...candidate,
      status: nextStatus,
    });
    const nextState = personalReviewStateSchema.parse({
      ...reviewState,
      candidates: reviewState.candidates.map((item) =>
        item.id === candidateId ? nextCandidate : item,
      ),
    });

    const digest = candidateDigest(candidate);
    const existingReceipts = await this.repository.readDecisionReceipts(candidateId);
    const existingReceipt = [...existingReceipts].reverse().find(
      (receipt) =>
        receipt.candidateId === candidateId &&
        receipt.candidateDigest === digest &&
        receipt.decision === parsedInput.decision &&
        receipt.source === parsedInput.source,
    );
    const receipt =
      existingReceipt ??
      knowledgeDecisionReceiptSchema.parse({
        id: this.options.id(),
        candidateId,
        candidateDigest: digest,
        actor: "human",
        at: this.now(),
        decision: parsedInput.decision,
        source: parsedInput.source,
      });

    if (!existingReceipt) {
      await this.repository.appendDecisionReceipt(receipt);
    }
    await this.repository.saveReviewState(nextState);
    return { candidate: nextCandidate, receipt };
  }

  async promote(candidateId: string, input: PromoteInput): Promise<ConceptRecord> {
    await this.assertReviewOwnership();
    return this.repository.withMutationLock(() => this.promoteUnlocked(candidateId, input));
  }

  private async promoteUnlocked(
    candidateId: string,
    input: PromoteInput,
  ): Promise<ConceptRecord> {
    const parsedInput = this.parseInput(
      "INVALID_PROMOTION",
      "Promotion input is invalid",
      promoteInputSchema,
      input,
    );
    const reviewState = await this.requireReviewState(candidateId);
    const candidate = this.requireCandidate(reviewState.candidates, candidateId);

    if (candidate.status !== "approved") {
      throw new DomainError(
        "HUMAN_APPROVAL_REQUIRED",
        "A human must approve the candidate before promotion",
        { candidateId, status: candidate.status },
      );
    }
    this.assertHasProjectEvidence(candidate.evidence);
    await this.evidenceResolver.resolveAll(candidate.evidence);
    const receipts = await this.repository.readDecisionReceipts(candidateId);
    const latestReceipt = [...receipts].reverse().find(
      (receipt) => receipt.candidateId === candidateId,
    );
    if (!latestReceipt) {
      throw new DomainError(
        "HUMAN_APPROVAL_REQUIRED",
        "Promotion requires an immutable human approval receipt",
        { candidateId },
      );
    }
    if (latestReceipt.candidateDigest !== candidateDigest(candidate)) {
      throw new DomainError(
        "APPROVAL_RECEIPT_MISMATCH",
        "Candidate content no longer matches the immutable approval receipt",
        { candidateId, receiptId: latestReceipt.id },
      );
    }
    if (latestReceipt.decision !== "approve") {
      throw new DomainError(
        "HUMAN_APPROVAL_REQUIRED",
        "The latest immutable human decision does not approve this candidate",
        { candidateId, receiptId: latestReceipt.id, decision: latestReceipt.decision },
      );
    }

    const existingConcept = await this.readConceptIfExists(candidateId);
    if (existingConcept) {
      if (
        this.isEquivalentPromotion(
          existingConcept,
          candidate,
          reviewState.taskId,
          parsedInput.confidence,
        )
      ) {
        await this.repository.writeConceptMarkdown(
          existingConcept.id,
          this.renderConceptMarkdown(existingConcept),
        );
        return existingConcept;
      }
      throw new DomainError(
        "CONCEPT_ALREADY_PROMOTED",
        "Promoting the same candidate twice would overwrite existing knowledge",
        { candidateId, conceptId: existingConcept.id },
      );
    }

    const promotedAt = this.now();
    const task = await this.projectRepository.readTask(reviewState.taskId);
    const concept = conceptRecordSchema.parse({
      ...candidate,
      taskId: reviewState.taskId,
      status: "approved",
      confidence: parsedInput.confidence,
      reviewedAt: promotedAt,
      timestamps: {
        candidateCreatedAt: reviewState.proposedAt,
        approvedAt: latestReceipt.at,
        promotedAt,
      },
      provenance: this.buildProvenance(
        candidate,
        reviewState.taskId,
        latestReceipt,
        `${task.title}: ${task.goal}`,
      ),
      history: [],
    });

    await this.repository.saveConcept(concept);
    await this.repository.writeConceptMarkdown(
      concept.id,
      this.renderConceptMarkdown(concept),
    );

    return concept;
  }

  async updateCapability(
    conceptId: string,
    input: CapabilityUpdateInput,
  ): Promise<CapabilityRecord> {
    await this.assertCapabilityPaths();
    return this.repository.withMutationLock(async () => {
      await this.assertCapabilityPaths();
      return this.updateCapabilityUnlocked(conceptId, input);
    });
  }

  private async updateCapabilityUnlocked(
    conceptId: string,
    input: CapabilityUpdateInput,
  ): Promise<CapabilityRecord> {
    const parsedInput = this.parseInput(
      "INVALID_CAPABILITY_UPDATE",
      "Capability update is invalid",
      capabilityUpdateInputSchema,
      input,
    );
    const identity = this.parseInput(
      "INVALID_CAPABILITY_UPDATE", "Capability update is invalid",
      capabilityInputIdentitySchema, { conceptId, level: parsedInput.level, evidence: parsedInput.evidence, ...(parsedInput.rationale === undefined ? {} : { rationale: parsedInput.rationale }) },
    );
    const currentState = await this.repository.readCapabilities();
    const history = currentState.version === 2 ? currentState.history : legacyCapabilityBaselines(currentState.records);
    const replay = parsedInput.operationId === undefined ? undefined : history.find((entry) => entry.operationId === parsedInput.operationId);
    if (replay) {
      if (replay.kind === "baseline" || JSON.stringify(replay.input) !== JSON.stringify(identity)) {
        throw new DomainError("CAPABILITY_OPERATION_CONFLICT", "Capability operation ID already belongs to different input", { operationId: parsedInput.operationId });
      }
      return replay.returnedRecord;
    }
    await assertSafePath(join(this.repository.paths.personal.concepts, `${identity.conceptId}.json`), "file", this.repository.paths.personal.base);
    const concept = await this.repository.readConcept(identity.conceptId);
    if (concept.status === "obsolete") throw new DomainError("CONCEPT_OBSOLETE", "New capability assessments require an active concept", { conceptId });
    for (const evidence of parsedInput.evidence) {
      const path = evidence.kind === "independent-task"
        ? join(this.projectRepository.paths.project.tasks, `${evidence.taskId}.json`)
        : join(this.projectRepository.paths.project.reviews, `${evidence.reviewId}.json`);
      await assertSafePath(path, "file", dirname(this.projectRepository.paths.project.base));
    }
    await this.evidenceResolver.resolveCapability(concept, parsedInput.evidence);
    this.assertCapabilityEvidence(concept, parsedInput.level, parsedInput.evidence);

    const fingerprint = contentFingerprint(concept);
    const previous = currentState.records.find((record) => record.conceptId === conceptId);
    const latest = [...history].reverse().find((entry) => entry.conceptId === conceptId && entry.kind !== "noop");
    const unchanged = previous && latest && latest.kind !== "baseline"
      && latest.contentFingerprint === fingerprint
      && JSON.stringify(latest.returnedRecord) === JSON.stringify(previous)
      && previous.level === parsedInput.level
      && JSON.stringify(previous.evidence) === JSON.stringify(parsedInput.evidence);
    if (unchanged && parsedInput.operationId === undefined) return previous;

    const at = this.now();
    const nextRecord = unchanged ? previous : capabilityRecordSchema.parse({
      conceptId, level: parsedInput.level, evidence: parsedInput.evidence, updatedAt: at,
    });
    const operationId = parsedInput.operationId ?? this.options.id();
    if (history.some((entry) => entry.operationId === operationId)) {
      throw new DomainError("CAPABILITY_OPERATION_CONFLICT", "Generated capability operation ID already exists", { operationId });
    }
    const nextState = capabilityStateSchema.parse({
      version: 2,
      records: unchanged ? currentState.records : [
        ...currentState.records.filter((record) => record.conceptId !== conceptId), nextRecord,
      ],
      history: [...history, {
        kind: unchanged ? "noop" : previous && previous.level !== parsedInput.level ? "transition" : "assessment",
        operationId, conceptId, previousLevel: previous?.level ?? null,
        newLevel: parsedInput.level, evidence: parsedInput.evidence, at,
        contentFingerprint: fingerprint, returnedRecord: nextRecord, input: identity,
      }],
    });
    await assertSafePath(this.repository.paths.personal.capabilities, "file", this.repository.paths.personal.base);
    await this.repository.saveCapabilities(nextState);
    return nextRecord;
  }

  private async assertCapabilityPaths(): Promise<void> {
    const root = this.repository.paths.personal.base;
    await assertSafePath(root, "directory", root);
    await assertSafePath(join(root, ".mutation.lock"), "directory", root);
    await assertSafePath(this.repository.paths.personal.capabilities, "file", root);
  }

  reviseEntry(conceptId: string, input: ReviseEntryInput): Promise<ConceptRecord> {
    return this.repository.withMutationLock(() =>
      this.reviseEntryUnlocked(conceptId, input),
    );
  }

  private async reviseEntryUnlocked(
    conceptId: string,
    input: ReviseEntryInput,
  ): Promise<ConceptRecord> {
    const parsedInput = this.parseInput(
      "INVALID_KNOWLEDGE_REVISION",
      "Knowledge revision is invalid",
      reviseEntryInputSchema,
      input,
    );
    await this.evidenceResolver.resolveAll(parsedInput.evidence);
    const current = await this.repository.readConcept(conceptId);
    const revisionId = revisionDigest(conceptId, parsedInput);
    if (current.history.some((entry) => entry.revisionId === revisionId)) {
      await this.repository.writeConceptMarkdown(
        current.id,
        this.renderConceptMarkdown(current),
      );
      return current;
    }
    const recordedAt = this.now();
    const nextStatus = parsedInput.status ?? current.status;
    const nextConcept = conceptRecordSchema.parse({
      ...current,
      principle: parsedInput.principle ?? current.principle,
      boundary: parsedInput.boundary ?? current.boundary,
      confidence: parsedInput.confidence ?? current.confidence,
      status: nextStatus,
      reviewedAt: recordedAt,
      timestamps: {
        ...this.timestampsFor(current),
        updatedAt: recordedAt,
        ...(nextStatus === "obsolete" ? { supersededAt: recordedAt } : {}),
      },
      history: [
        ...current.history,
        {
          revisionId,
          principle: current.principle,
          boundary: current.boundary,
          status: current.status,
          confidence: current.confidence,
          reviewedAt: current.reviewedAt,
          recordedAt,
          summary: parsedInput.summary,
          evidence: parsedInput.evidence,
        },
      ],
    });

    await this.repository.saveConcept(nextConcept);
    await this.repository.writeConceptMarkdown(
      nextConcept.id,
      this.renderConceptMarkdown(nextConcept),
    );

    return nextConcept;
  }

  private isEquivalentPromotion(
    concept: ConceptRecord,
    candidate: KnowledgeCandidate,
    taskId: string,
    confidence: number,
  ): boolean {
    return (
      concept.id === candidate.id &&
      concept.reviewId === candidate.reviewId &&
      concept.taskId === taskId &&
      concept.principle === candidate.principle &&
      concept.boundary === candidate.boundary &&
      concept.status === "approved" &&
      concept.confidence === confidence &&
      concept.history.length === 0 &&
      JSON.stringify(concept.evidence) === JSON.stringify(candidate.evidence)
    );
  }

  private buildProvenance(
    candidate: KnowledgeCandidate,
    taskId: string,
    approvalReceipt: KnowledgeDecisionReceipt,
    taskSummary: string,
  ): KnowledgeProvenance {
    return {
      candidateId: candidate.id,
      reviewId: candidate.reviewId,
      taskId,
      sourceProject: dirname(this.projectRepository.paths.project.base),
      sourceSummary: `Promoted from task ${taskId} and review ${candidate.reviewId}: ${taskSummary}`,
      evidenceRefs: this.uniqueEvidenceRefs([
        { kind: "task", id: taskId },
        { kind: "review", id: candidate.reviewId },
        ...candidate.evidence,
      ]),
      decisionReceiptId: approvalReceipt.id,
    };
  }

  private timestampsFor(concept: ConceptRecord): KnowledgeTimestamps {
    return (
      concept.timestamps ?? {
        candidateCreatedAt: concept.reviewedAt,
        approvedAt: concept.reviewedAt,
        promotedAt: concept.reviewedAt,
      }
    );
  }

  private uniqueEvidenceRefs(evidence: EvidenceRef[]): EvidenceRef[] {
    const seen = new Set<string>();
    return evidence.filter((item) => {
      const key = `${item.kind}:${item.id}:${item.path ?? ""}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private assertCapabilityEvidence(
    concept: ConceptRecord,
    level: CapabilityRecord["level"],
    evidence: CapabilityEvidence[],
  ): void {
    if (
      level === "explainable" &&
      !evidence.some(
        (item) =>
          (item.kind === "explanation" || item.kind === "transfer") && item.passed,
      )
    ) {
      throw new DomainError(
        "EXPLAINABLE_EVIDENCE_REQUIRED",
        "Explainable capability requires a passed explanation or transfer exercise",
        { conceptId: concept.id },
      );
    }

    if (level !== "independent") {
      return;
    }

    const independentEvidence = evidence.filter(
      (item) => item.kind === "independent-task",
    );

    if (
      !independentEvidence.some(
        (item) =>
          item.originatingTaskId === concept.taskId && item.taskId !== concept.taskId,
      )
    ) {
      throw new DomainError(
        "INDEPENDENT_TASK_REQUIRED",
        "Independent capability requires success on a different task than the originating review",
        { conceptId: concept.id, originatingTaskId: concept.taskId },
      );
    }
  }

  private assertHasProjectEvidence(evidence: EvidenceRef[]): void {
    if (evidence.some((item) => projectEvidenceKinds.has(item.kind))) {
      return;
    }

    throw new DomainError(
      "PROJECT_EVIDENCE_REQUIRED",
      "Knowledge promotion requires at least one project evidence reference",
      {
        allowedKinds: [...projectEvidenceKinds],
        providedKinds: evidence.map((item) => item.kind),
      },
    );
  }

  private async requireReviewState(candidateId: string) {
    const reviewId = this.reviewIdFromCandidateId(candidateId);

    try {
      return await this.repository.readReviewState(reviewId);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        throw new DomainError(
          "KNOWLEDGE_CANDIDATE_NOT_FOUND",
          `Knowledge candidate ${candidateId} does not exist`,
          { candidateId, reviewId },
        );
      }

      throw error;
    }
  }

  private assertReviewOwnership(): Promise<void> {
    return assertSeparateStorageRoots({ project: this.projectRepository.paths.project, personal: this.repository.paths.personal });
  }

  private async readConceptIfExists(
    conceptId: string,
  ): Promise<ConceptRecord | undefined> {
    try {
      return await this.repository.readConcept(conceptId);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return undefined;
      }

      throw error;
    }
  }

  private requireCandidate(
    candidates: KnowledgeCandidate[],
    candidateId: string,
  ): KnowledgeCandidate {
    const candidate = candidates.find((item) => item.id === candidateId);
    if (!candidate) {
      throw new DomainError(
        "KNOWLEDGE_CANDIDATE_NOT_FOUND",
        `Knowledge candidate ${candidateId} does not exist`,
        { candidateId },
      );
    }

    return candidate;
  }

  private reviewIdFromCandidateId(candidateId: string): string {
    const match = /^(.*)-candidate-(\d+)$/.exec(candidateId);
    const reviewId = match?.[1];
    if (!reviewId) {
      throw new DomainError(
        "INVALID_CANDIDATE_ID",
        "Candidate IDs must be derived from a review",
        { candidateId },
      );
    }

    return reviewId;
  }

  private candidateId(reviewId: string, ordinal: number): string {
    return `${reviewId}-candidate-${ordinal}`;
  }

  private proposeFromReview(review: ReviewSession): CandidateDraft[] {
    const transferAnswer = review.entries
      .filter((entry) => entry.actor === "human" && entry.kind === "transfer-answer")
      .at(-1);

    if (!transferAnswer) {
      return [];
    }

    return this.extractTransferPrinciples(transferAnswer.content)
      .slice(0, 3)
      .map((principle) => ({
        principle,
        boundary:
          "Use this when a completed deep review includes a human transfer answer and concrete project evidence.",
        evidence: [{ kind: "task", id: review.taskId }],
      }));
  }

  private extractTransferPrinciples(content: string): string[] {
    const principleLine = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^Principle:\s*/i.test(line));

    if (principleLine) {
      return [principleLine.replace(/^Principle:\s*/i, "").trim()];
    }

    const numberedPrinciples = this.extractNumberedTransferPrinciples(content);
    if (numberedPrinciples.length > 0) {
      return numberedPrinciples;
    }

    const normalized = content.replace(/^Transfer principle:\s*/i, "").trim();
    return normalized ? [normalized] : [];
  }

  private extractNumberedTransferPrinciples(content: string): string[] {
    const normalized = content.replace(/\r?\n/g, " ").trim();
    const marker = /(^|[\s\u3000:：])(\d+)\.\s+/g;
    const matches = Array.from(normalized.matchAll(marker));
    if (matches.length === 0) {
      return [];
    }

    return matches
      .map((match, index) => {
        const start = match.index! + match[0].length;
        const end =
          index + 1 < matches.length
            ? matches[index + 1]!.index
            : normalized.length;
        return normalized.slice(start, end).trim();
      })
      .filter((principle) => principle.length > 0);
  }

  private renderPracticeMarkdown(review: ReviewSession): string {
    const transferEntries = review.entries.filter(
      (entry) => entry.kind === "question" || entry.kind === "transfer-answer",
    );
    const lines = transferEntries.length
      ? transferEntries.map(
          (entry) => `- ${entry.kind} (${entry.actor}): ${entry.content}`,
        )
      : ["- No transfer exercise captured."];

    return [
      "# Transfer Practice",
      "",
      `Review: ${review.id}`,
      `Task: ${review.taskId}`,
      "",
      "## Evidence",
      ...lines,
      "",
    ].join("\n");
  }

  private renderConceptMarkdown(concept: ConceptRecord): string {
    const timestamps = this.timestampsFor(concept);
    const provenance =
      concept.provenance ??
      this.buildFallbackProvenance(concept);
    const evidenceLines = concept.evidence.map(
      (item) => `- ${item.kind}: ${item.id}${item.path ? ` (${item.path})` : ""}`,
    );
    const provenanceLines = provenance.evidenceRefs.map(
      (item) => `- ${item.kind}: ${item.id}${item.path ? ` (${item.path})` : ""}`,
    );

    return [
      `# ${concept.principle}`,
      "",
      `- Status: ${concept.status}`,
      `- Confidence: ${concept.confidence}`,
      `- Boundary: ${concept.boundary}`,
      `- Candidate created: ${timestamps.candidateCreatedAt}`,
      `- Approved: ${timestamps.approvedAt}`,
      `- Promoted: ${timestamps.promotedAt}`,
      ...(timestamps.updatedAt ? [`- Updated: ${timestamps.updatedAt}`] : []),
      ...(timestamps.supersededAt ? [`- Superseded: ${timestamps.supersededAt}`] : []),
      `- Review: ${concept.reviewId}`,
      `- Task: ${concept.taskId}`,
      "",
      "## Provenance",
      "",
      provenance.sourceSummary,
      "",
      `- Candidate: ${provenance.candidateId}`,
      `- Decision receipt: ${provenance.decisionReceiptId ?? "unknown"}`,
      `- Source project: ${provenance.sourceProject ?? "unknown"}`,
      "",
      "## Source Chain",
      ...provenanceLines,
      "",
      "## Evidence",
      ...evidenceLines,
      "",
    ].join("\n");
  }

  private buildFallbackProvenance(concept: ConceptRecord): KnowledgeProvenance {
    return {
      candidateId: concept.id,
      reviewId: concept.reviewId,
      taskId: concept.taskId,
      sourceSummary: `Promoted from task ${concept.taskId} and review ${concept.reviewId}.`,
      evidenceRefs: this.uniqueEvidenceRefs([
        { kind: "task", id: concept.taskId },
        { kind: "review", id: concept.reviewId },
        ...concept.evidence,
      ]),
    };
  }

  private parseInput<TSchema extends z.ZodTypeAny>(
    code: string,
    message: string,
    schema: TSchema,
    value: unknown,
  ): z.infer<TSchema> {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new DomainError(code, message, { issues: result.error.issues });
    }

    return result.data;
  }

  private now(): string {
    return this.options.clock().toISOString();
  }
}

export type { CapabilityEvidence, ConceptRecord, EvidenceRef, KnowledgeCandidate };
