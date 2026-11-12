import { createHash } from "node:crypto";
import { z } from "zod";
import {
  evidenceRefSchema, restrictedIdSchema, reviewLevelSchema, reviewSignalSchema,
  reviewTemplateIdSchema, taskTypeSchema,
  type CapabilityState, type Checkpoint, type ConceptRecord, type KnowledgeDecisionReceipt,
  type PersonalReviewState, type ProjectEvent, type ReviewSession, type TaskRecord,
} from "../domain/schema.js";

const observationFields = {
  version: z.literal(1),
  id: restrictedIdSchema,
  conceptId: restrictedIdSchema,
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  recordedAt: z.string().datetime(),
  actor: z.literal("human"),
  source: z.string().trim().min(1),
  evidence: z.array(evidenceRefSchema.strict()).optional(),
};
export const growthObservationSchema = z.discriminatedUnion("kind", [
  z.object({ ...observationFields, kind: z.literal("recall"), result: z.enum(["recalled", "partial", "forgotten"]) }).strict(),
  z.object({ ...observationFields, kind: z.literal("defer"), until: z.string().datetime() }).strict(),
  z.object({ ...observationFields, kind: z.literal("resume") }).strict(),
]);
export const capturedReviewSchema = z.object({
  version: z.literal(1), id: restrictedIdSchema, sourceId: restrictedIdSchema,
  taskId: restrictedIdSchema, reviewId: restrictedIdSchema,
  taskType: taskTypeSchema, conceptIds: z.array(restrictedIdSchema),
  signals: z.array(reviewSignalSchema), level: reviewLevelSchema,
  templateIds: z.array(reviewTemplateIdSchema), taskCompletedAt: z.string().datetime().nullable().optional(), completedAt: z.string().datetime().nullable(),
  capturedAt: z.string().datetime(),
}).strict();
export const projectIdentitySchema = z.object({ version: z.literal(1), sourceId: restrictedIdSchema }).strict();

export type GrowthObservation = z.infer<typeof growthObservationSchema>;
export type CapturedReview = z.infer<typeof capturedReviewSchema>;
export type ProjectIdentity = z.infer<typeof projectIdentitySchema>;
export type GrowthSnapshot = {
  concepts: ConceptRecord[];
  capabilities: CapabilityState;
  observations: GrowthObservation[];
  capturedReviews: CapturedReview[];
  decisionReceipts: KnowledgeDecisionReceipt[];
  personalReviewStates: PersonalReviewState[];
  tasks: TaskRecord[];
  reviews: ReviewSession[];
  checkpoints: Checkpoint[];
  events: ProjectEvent[];
  projectRoot: string;
  sourceId?: string;
};

export function contentFingerprint(concept: Pick<ConceptRecord, "id" | "principle" | "boundary">): string {
  return createHash("sha256").update(JSON.stringify({ id: concept.id, principle: concept.principle, boundary: concept.boundary })).digest("hex");
}
