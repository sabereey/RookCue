import { z } from "zod";

import { DomainError } from "../domain/errors.js";
import { EvidenceResolver } from "../domain/evidence-resolver.js";
import {
  evidenceRefSchema,
  reviewRecommendationSchema,
  reviewEntrySchema,
  reviewTemplateIdSchema,
  reviewSessionSchema,
  type ReviewEntry,
  type ReviewPhase,
  type ReviewSession,
} from "../domain/schema.js";
import { ProjectService } from "../project/project-service.js";
import { ProjectRepository } from "../storage/project-repository.js";

const addEntryInputSchema = z.object({
  templateId: reviewTemplateIdSchema.optional(),
  actor: z.enum(["human", "ai"]),
  kind: z.enum([
    "scope",
    "response",
    "question",
    "correction",
    "transfer-answer",
    "decision",
  ]),
  content: z.string().min(1),
  evidence: z.array(evidenceRefSchema).default([]),
});

const startReviewInputSchema = z.object({
  taskId: z.string().min(1),
  level: z.enum(["skip", "quick", "deep"]),
  recommendation: reviewRecommendationSchema.optional(),
  selectedBy: z.enum(["human", "ai"]),
});

type AddEntryInput = z.infer<typeof addEntryInputSchema>;

export type StartReviewInput = z.infer<typeof startReviewInputSchema>;

type MutableReview = ReviewSession & { entries: ReviewEntry[] };

const phaseMarkerPrefix = "__phase__:";

export class ReviewService {
  private readonly evidenceResolver: EvidenceResolver;

  constructor(
    private readonly repository: ProjectRepository,
    private readonly projectService: ProjectService,
    private readonly options: {
      clock: () => Date;
      id: () => string;
    },
  ) {
    this.evidenceResolver = new EvidenceResolver(repository);
  }

  start(input: StartReviewInput): Promise<ReviewSession> {
    return this.repository.withMutationLock(() => this.startUnlocked(input));
  }

  private async startUnlocked(input: StartReviewInput): Promise<ReviewSession> {
    const parsedInput = this.parseInput(
      "INVALID_REVIEW",
      "Review input is invalid",
      startReviewInputSchema,
      input,
    );

    if (parsedInput.level === "skip") {
      throw new DomainError(
        "SKIP_REVIEW_NOT_ALLOWED",
        "Skip reviews do not create review sessions",
      );
    }

    if (parsedInput.selectedBy !== "human") {
      throw new DomainError(
        "HUMAN_SELECTION_REQUIRED",
        "Only a human may select the review level",
      );
    }

    if (parsedInput.level === "deep" && !parsedInput.recommendation) {
      throw new DomainError(
        "RECOMMENDATION_REQUIRED",
        "Deep reviews require an AI recommendation",
      );
    }

    await this.requireTask(parsedInput.taskId);

    const review = reviewSessionSchema.parse({
      id: this.options.id(),
      taskId: parsedInput.taskId,
      level: parsedInput.level,
      recommendation: parsedInput.recommendation,
      selectedBy: "human",
      phase: "context",
      status: "active",
      startedAt: this.now(),
      entries: [this.createPhaseMarker("context")],
    });

    await this.repository.saveReview(review);
    return review;
  }

  addEntry(reviewId: string, input: AddEntryInput): Promise<ReviewEntry> {
    return this.repository.withMutationLock(() => this.addEntryUnlocked(reviewId, input));
  }

  private async addEntryUnlocked(reviewId: string, input: AddEntryInput): Promise<ReviewEntry> {
    const parsedInput = this.parseInput(
      "INVALID_REVIEW_ENTRY",
      "Review entry input is invalid",
      addEntryInputSchema,
      input,
    );
    const review = await this.requireEditableReview(reviewId);

    if (
      review.level === "deep" &&
      (review.phase === "context" || review.phase === "reconstruct") &&
      parsedInput.actor !== "human" &&
      parsedInput.kind === "response" &&
      !this.hasHumanResponse(review.entries)
    ) {
      throw new DomainError(
        "HUMAN_RECONSTRUCTION_REQUIRED",
        "A human must provide the initial reconstruction response",
      );
    }

    this.assertEntryAllowed(review, parsedInput);
    await this.evidenceResolver.resolveAll(parsedInput.evidence);

    const entry = reviewEntrySchema.parse({
      ...parsedInput,
      id: this.options.id(),
      at: this.now(),
    });
    const nextReview = reviewSessionSchema.parse({
      ...review,
      entries: [...review.entries, entry],
    });

    await this.repository.saveReview(nextReview);
    return entry;
  }

  advance(reviewId: string): Promise<ReviewSession> {
    return this.repository.withMutationLock(() => this.advanceUnlocked(reviewId));
  }

  private async advanceUnlocked(reviewId: string): Promise<ReviewSession> {
    const review = await this.requireEditableReview(reviewId);
    const nextPhase = this.nextPhase(review);
    const nextStatus = nextPhase === "complete" ? "completed" : "active";
    const nextEntries =
      nextPhase === "complete"
        ? review.entries
        : [...review.entries, this.createPhaseMarker(nextPhase)];
    const nextReview = reviewSessionSchema.parse({
      ...review,
      phase: nextPhase,
      status: nextStatus,
      ...(nextStatus === "completed" ? { completedAt: this.now() } : {}),
      entries: nextEntries,
    });

    await this.repository.saveReview(nextReview);
    return nextReview;
  }

  interrupt(reviewId: string): Promise<ReviewSession> {
    return this.repository.withMutationLock(() => this.interruptUnlocked(reviewId));
  }

  private async interruptUnlocked(reviewId: string): Promise<ReviewSession> {
    const review = await this.requireEditableReview(reviewId);
    const interrupted = reviewSessionSchema.parse({
      ...review,
      status: "interrupted",
    });

    await this.repository.saveReview(interrupted);

    try {
      await this.projectService.checkpoint(
        review.taskId,
        "review",
        {
          reviewId: review.id,
          phase: review.phase,
          entryIds: review.entries.map((entry) => entry.id),
        },
        review.phase,
      );
      return interrupted;
    } catch (error) {
      const rollbackErrors = await this.restoreOriginalReview(review);

      if (rollbackErrors.length > 0) {
        throw new DomainError(
          "INTERRUPT_ROLLBACK_FAILED",
          "Interrupt checkpoint failed and review rollback also failed",
          {
            reviewId: review.id,
            primaryError: this.describeError(error),
            ...(error instanceof DomainError ? { primaryCode: error.code } : {}),
            rollbackErrors,
          },
        );
      }

      throw new DomainError(
        "INTERRUPT_CHECKPOINT_FAILED",
        "Interrupt checkpoint failed; original review restored",
        {
          reviewId: review.id,
          primaryError: this.describeError(error),
          ...(error instanceof DomainError ? { primaryCode: error.code } : {}),
        },
      );
    }
  }

  resume(reviewId: string): Promise<ReviewSession> {
    return this.repository.withMutationLock(() => this.resumeUnlocked(reviewId));
  }

  private async resumeUnlocked(reviewId: string): Promise<ReviewSession> {
    const review = await this.requireReview(reviewId);

    if (review.status !== "interrupted") {
      throw new DomainError(
        "REVIEW_NOT_INTERRUPTED",
        `Review ${reviewId} is not interrupted`,
        { reviewId, status: review.status },
      );
    }

    const resumed = reviewSessionSchema.parse({
      ...review,
      status: "active",
    });

    await this.repository.saveReview(resumed);
    return resumed;
  }

  private nextPhase(review: MutableReview): ReviewPhase {
    const phaseEntries = this.phaseEntries(review);

    switch (review.phase) {
      case "context":
        if (!this.hasHumanDecision(phaseEntries)) {
          throw new DomainError(
            "REVIEW_LEVEL_DECISION_REQUIRED",
            "Reviews require an explicit human decision before leaving context",
          );
        }
        return review.level === "quick" ? "correct" : "reconstruct";
      case "reconstruct":
        if (!this.hasHumanResponse(phaseEntries)) {
          throw new DomainError(
            "RECONSTRUCTION_REQUIRED",
            "Deep reviews require a human reconstruction response before advancing",
          );
        }
        return "challenge";
      case "challenge":
        if (!this.hasOrderedChallenge(phaseEntries)) {
          throw new DomainError(
            "CHALLENGE_ANSWER_REQUIRED",
            "Challenge questions require a human answer before advancing",
          );
        }
        return "correct";
      case "correct":
        if (review.level === "quick") {
          if (!this.hasHumanResponse(phaseEntries)) {
            throw new DomainError(
              "QUICK_REVIEW_CONFIRMATION_REQUIRED",
              "Quick reviews require a human confirmation before completion",
            );
          }
          return "complete";
        }

        if (!this.hasEvidenceBackedCorrection(phaseEntries)) {
          throw new DomainError(
            "CORRECTION_REQUIRED",
            "Deep reviews require an evidence-backed correction before advancing",
          );
        }
        return "transfer";
      case "transfer":
        if (!this.hasHumanTransferAnswer(phaseEntries)) {
          throw new DomainError(
            "TRANSFER_ANSWER_REQUIRED",
            "Deep reviews require a human transfer answer before completion",
          );
        }
        return "complete";
      case "complete":
        throw new DomainError("REVIEW_COMPLETE", `Review ${review.id} is already complete`, {
          reviewId: review.id,
        });
    }
  }

  private phaseEntries(review: MutableReview): ReviewEntry[] {
    const marker = this.phaseMarker(review.phase);
    const lastMarkerIndex = [...review.entries]
      .map((entry, index) => ({ entry, index }))
      .reverse()
      .find(
        ({ entry }) =>
          entry.actor === "system" &&
          entry.kind === "decision" &&
          entry.content === marker,
      )
      ?.index;

    if (lastMarkerIndex === undefined) {
      return review.entries;
    }

    return review.entries.slice(lastMarkerIndex + 1);
  }

  private hasHumanResponse(entries: ReviewEntry[]): boolean {
    return entries.some((entry) => entry.actor === "human" && entry.kind === "response");
  }

  private hasHumanDecision(entries: ReviewEntry[]): boolean {
    return entries.some((entry) => entry.actor === "human" && entry.kind === "decision");
  }

  private hasEvidenceBackedCorrection(entries: ReviewEntry[]): boolean {
    return entries.some(
      (entry) =>
        entry.actor === "ai" &&
        entry.kind === "correction" &&
        entry.evidence.length > 0,
    );
  }

  private hasOrderedChallenge(entries: ReviewEntry[]): boolean {
    return (
      entries.length === 2 &&
      entries[0]?.actor === "ai" &&
      entries[0].kind === "question" &&
      entries[1]?.actor === "human" &&
      entries[1].kind === "response"
    );
  }

  private assertEntryAllowed(review: MutableReview, input: AddEntryInput): void {
    const phaseEntries = this.phaseEntries(review);
    const allowed = (() => {
      switch (review.phase) {
        case "context":
          return input.actor === "human" && input.kind === "decision";
        case "reconstruct":
          return input.actor === "human" && input.kind === "response";
        case "challenge":
          if (phaseEntries.length === 0) {
            return input.actor === "ai" && input.kind === "question";
          }
          if (
            phaseEntries.length === 1 &&
            phaseEntries[0]?.actor === "ai" &&
            phaseEntries[0].kind === "question"
          ) {
            return input.actor === "human" && input.kind === "response";
          }
          return false;
        case "correct":
          return review.level === "quick"
            ? input.actor === "human" && input.kind === "response"
            : input.actor === "ai" && input.kind === "correction";
        case "transfer":
          return input.actor === "human" && input.kind === "transfer-answer";
        case "complete":
          return false;
      }
    })();

    if (
      review.phase === "challenge" &&
      input.actor === "human" &&
      input.kind === "response" &&
      !phaseEntries.some((entry) => entry.actor === "ai" && entry.kind === "question")
    ) {
      throw new DomainError(
        "CHALLENGE_QUESTION_REQUIRED",
        "A human challenge answer must follow an AI question",
        { reviewId: review.id },
      );
    }

    if (!allowed) {
      throw new DomainError(
        "REVIEW_ENTRY_NOT_ALLOWED",
        `Entry ${input.actor}/${input.kind} is not allowed in ${review.phase}`,
        {
          reviewId: review.id,
          level: review.level,
          phase: review.phase,
          actor: input.actor,
          kind: input.kind,
        },
      );
    }

    if (
      review.level === "deep" &&
      review.phase === "correct" &&
      input.evidence.length === 0
    ) {
      throw new DomainError(
        "CORRECTION_EVIDENCE_REQUIRED",
        "Deep review corrections require evidence",
        { reviewId: review.id },
      );
    }
  }

  private hasHumanTransferAnswer(entries: ReviewEntry[]): boolean {
    return entries.some(
      (entry) => entry.actor === "human" && entry.kind === "transfer-answer",
    );
  }

  private async restoreOriginalReview(review: MutableReview): Promise<string[]> {
    const rollbackErrors: string[] = [];

    try {
      await this.repository.saveReview(review);
    } catch (error) {
      rollbackErrors.push(`review rollback failed: ${this.describeError(error)}`);
    }

    return rollbackErrors;
  }

  private createPhaseMarker(phase: ReviewPhase): ReviewEntry {
    return reviewEntrySchema.parse({
      id: this.options.id(),
      actor: "system",
      kind: "decision",
      content: this.phaseMarker(phase),
      evidence: [],
      at: this.now(),
    });
  }

  private phaseMarker(phase: ReviewPhase): string {
    return `${phaseMarkerPrefix}${phase}`;
  }

  private async requireEditableReview(reviewId: string): Promise<MutableReview> {
    const review = await this.requireReview(reviewId);

    if (review.status === "interrupted") {
      throw new DomainError("REVIEW_INTERRUPTED", `Review ${reviewId} is interrupted`, {
        reviewId,
      });
    }

    if (review.status === "completed") {
      throw new DomainError("REVIEW_COMPLETE", `Review ${reviewId} is already complete`, {
        reviewId,
      });
    }

    return review;
  }

  private async requireReview(reviewId: string): Promise<MutableReview> {
    try {
      return await this.repository.readReview(reviewId);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        throw new DomainError("REVIEW_NOT_FOUND", `Review ${reviewId} does not exist`, {
          reviewId,
        });
      }

      throw error;
    }
  }

  private async requireTask(taskId: string): Promise<void> {
    try {
      await this.repository.readTask(taskId);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        throw new DomainError("TASK_NOT_FOUND", `Task ${taskId} does not exist`, {
          taskId,
        });
      }

      throw error;
    }
  }

  private now(): string {
    return this.options.clock().toISOString();
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private parseInput<T>(
    code: string,
    message: string,
    schema: z.ZodType<T>,
    value: unknown,
  ): T {
    const result = schema.safeParse(value);

    if (!result.success) {
      throw new DomainError(code, message, {
        issues: result.error.issues,
      });
    }

    return result.data;
  }
}
