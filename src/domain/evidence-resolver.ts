import { DomainError } from "./errors.js";
import type {
  CapabilityEvidence,
  ConceptRecord,
  EvidenceRef,
  ReviewSession,
} from "./schema.js";
import { ProjectRepository } from "../storage/project-repository.js";

export class EvidenceResolver {
  constructor(private readonly repository: ProjectRepository) {}

  async resolveAll(evidence: EvidenceRef[]): Promise<void> {
    for (const reference of evidence) {
      await this.resolve(reference);
    }
  }

  async resolveCapability(
    concept: ConceptRecord,
    evidence: CapabilityEvidence[],
  ): Promise<void> {
    for (const item of evidence) {
      if (item.kind === "independent-task") {
        const task = await this.require(
          "task",
          item.taskId,
          () => this.repository.readTask(item.taskId),
        );
        if (
          task.status !== "completed" ||
          item.taskId === concept.taskId ||
          item.originatingTaskId !== concept.taskId
        ) {
          throw new DomainError(
            "INDEPENDENT_TASK_REQUIRED",
            "Independent capability requires a completed distinct task tied to the concept origin",
            {
              conceptId: concept.id,
              taskId: item.taskId,
              taskStatus: task.status,
              originatingTaskId: item.originatingTaskId,
            },
          );
        }
        continue;
      }

      const review = await this.require(
        "review",
        item.reviewId,
        () => this.repository.readReview(item.reviewId),
      );
      this.assertCompletedReview(review, concept.taskId);
      const hasRelevantHumanEntry = review.entries.some((entry) =>
        item.kind === "transfer"
          ? entry.actor === "human" && entry.kind === "transfer-answer"
          : entry.actor === "human" && entry.kind === "response",
      );
      if (!hasRelevantHumanEntry) {
        throw new DomainError(
          "REVIEW_EVIDENCE_NOT_RELEVANT",
          `Review ${review.id} lacks the required human ${item.kind} evidence`,
          { reviewId: review.id, kind: item.kind },
        );
      }
    }
  }

  async resolveCompletedReview(reviewId: string, taskId: string): Promise<ReviewSession> {
    const review = await this.require(
      "review",
      reviewId,
      () => this.repository.readReview(reviewId),
    );
    this.assertCompletedReview(review, taskId);
    return review;
  }

  private async resolve(reference: EvidenceRef): Promise<void> {
    switch (reference.kind) {
      case "task":
        await this.require("task", reference.id, () => this.repository.readTask(reference.id));
        return;
      case "event": {
        const event = await this.repository.readEvent(reference.id);
        if (!event) {
          throw this.notFound("event", reference.id);
        }
        return;
      }
      case "checkpoint":
        await this.require(
          "checkpoint",
          reference.id,
          () => this.repository.readCheckpoint(reference.id),
        );
        return;
      case "review":
        await this.require(
          "review",
          reference.id,
          () => this.repository.readReview(reference.id),
        );
        return;
      case "commit":
      case "test":
        return;
    }
  }

  private assertCompletedReview(review: ReviewSession, taskId: string): void {
    if (
      review.status !== "completed" ||
      review.phase !== "complete" ||
      review.taskId !== taskId
    ) {
      throw new DomainError(
        "REVIEW_EVIDENCE_NOT_COMPLETE",
        "Capability review evidence must be complete and belong to the concept task",
        {
          reviewId: review.id,
          reviewTaskId: review.taskId,
          conceptTaskId: taskId,
          status: review.status,
          phase: review.phase,
        },
      );
    }
  }

  private async require<T>(kind: string, id: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (this.isNotFound(error)) {
        throw this.notFound(kind, id);
      }
      throw error;
    }
  }

  private notFound(kind: string, id: string): DomainError {
    return new DomainError("EVIDENCE_NOT_FOUND", `${kind} evidence ${id} does not exist`, {
      kind,
      id,
    });
  }

  private isNotFound(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    );
  }
}
