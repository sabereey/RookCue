import { z } from "zod";

export const restrictedIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "Identifiers may only contain letters, numbers, dot, underscore, and hyphen",
  );

export const reviewLevelSchema = z.enum(["skip", "quick", "deep"]);
export const reviewPhaseSchema = z.enum([
  "context",
  "reconstruct",
  "challenge",
  "correct",
  "transfer",
  "complete",
]);
export const actorSchema = z.enum(["human", "ai", "system"]);
export const capabilityLevelSchema = z.enum([
  "seen",
  "understood",
  "explainable",
  "independent",
]);

export const evidenceRefSchema = z.object({
  kind: z.enum(["task", "event", "checkpoint", "commit", "test", "review"]),
  id: restrictedIdSchema,
  path: z.string().min(1).optional(),
});

export const projectEventSchema = z.object({
  id: restrictedIdSchema,
  at: z.string().datetime(),
  type: z.string().min(1),
  taskId: restrictedIdSchema.optional(),
  summary: z.string().min(1),
  evidence: z.array(evidenceRefSchema).default([]),
});

export const taskTypeSchema = z.enum(["general", "implementation", "debugging", "architecture", "refactor", "research"]);
export const reviewTemplateIdSchema = z.enum(["five-whys", "aar", "kpt", "feynman"]);

export const taskRecordSchema = z.object({
  id: restrictedIdSchema,
  type: taskTypeSchema.optional(),
  conceptIds: z.array(restrictedIdSchema).optional(),
  title: z.string().min(1),
  goal: z.string().min(1),
  status: z.enum(["active", "completed", "abandoned"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

export const checkpointSchema = z.object({
  id: restrictedIdSchema,
  taskId: restrictedIdSchema,
  at: z.string().datetime(),
  reason: z.enum(["manual", "interval", "trigger", "interrupt", "review"]),
  phase: reviewPhaseSchema.optional(),
  snapshot: z.record(z.string(), z.unknown()),
});

export const reviewSignalSchema = z.enum([
  "architecture-change",
  "rule-change",
  "failure-or-rework",
  "unfamiliar-technology",
  "transferable-learning",
  "ai-heavy",
]);

// Optional on legacy recommendations; growth callers provide all metadata explicitly.
export const growthRecommendationMetadataSchema = z.object({
  ruleVersion: z.literal("growth-v1"),
  baseScore: z.number().int().min(0),
  historyAdjustment: z.number().int().min(0),
  history: z.object({
    status: z.enum(["available", "insufficient-history"]),
    window: z.object({ startInclusive: z.string().datetime(), endInclusive: z.string().datetime() }).strict(),
    relevantTaskCount: z.number().int().min(0),
    failureTaskCount: z.number().int().min(0),
    unresolvedRecallCount: z.number().int().min(0),
    sourceIds: z.array(restrictedIdSchema),
    samples: z.array(z.object({
      sourceId: restrictedIdSchema, taskId: restrictedIdSchema,
      reviewIds: z.array(restrictedIdSchema), completedAt: z.string().datetime(),
    }).strict()),
    recall: z.array(z.object({
      conceptId: restrictedIdSchema, contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      latestOutcome: z.enum(["recalled", "partial", "forgotten"]), latestObservedAt: z.string().datetime(),
      unresolvedCount: z.number().int().min(0), observationIds: z.array(restrictedIdSchema),
    }).strict()),
    reason: z.string().min(1),
  }).strict(),
  suggestedMethod: reviewTemplateIdSchema.nullable(),
  alternatives: z.array(reviewTemplateIdSchema),
  methodReasons: z.array(z.string().min(1)),
}).strict();

export const reviewRecommendationSchema = z.object({
  level: reviewLevelSchema,
  score: z.number().int().min(0),
  reasons: z.array(z.string().min(1)),
  signals: z.array(reviewSignalSchema),
  ...growthRecommendationMetadataSchema.partial().shape,
});

export const reviewEntrySchema = z.object({
  templateId: reviewTemplateIdSchema.optional(),
  id: restrictedIdSchema,
  actor: actorSchema,
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
  at: z.string().datetime(),
});

export const reviewSessionSchema = z.object({
  id: restrictedIdSchema,
  taskId: restrictedIdSchema,
  level: reviewLevelSchema,
  recommendation: reviewRecommendationSchema.optional(),
  selectedBy: z.literal("human"),
  phase: reviewPhaseSchema,
  status: z.enum(["active", "completed", "interrupted"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  entries: z.array(reviewEntrySchema),
});

export const knowledgeCandidateSchema = z.object({
  id: restrictedIdSchema,
  reviewId: restrictedIdSchema,
  ordinal: z.number().int().min(1).max(3),
  principle: z.string().min(1),
  boundary: z.string().min(1),
  evidence: z.array(evidenceRefSchema).min(1),
  status: z.enum(["candidate", "approved", "rejected"]),
});

export const knowledgeEntrySchema = knowledgeCandidateSchema.extend({
  status: z.enum(["approved", "obsolete"]),
  confidence: z.number().min(0).max(1),
  reviewedAt: z.string().datetime(),
});

export const knowledgeTimestampsSchema = z.object({
  candidateCreatedAt: z.string().datetime(),
  approvedAt: z.string().datetime(),
  promotedAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  supersededAt: z.string().datetime().optional(),
});

export const knowledgeProvenanceSchema = z.object({
  candidateId: restrictedIdSchema,
  reviewId: restrictedIdSchema,
  taskId: restrictedIdSchema,
  sourceProject: z.string().min(1).optional(),
  sourceSummary: z.string().min(1),
  evidenceRefs: z.array(evidenceRefSchema).default([]),
  decisionReceiptId: restrictedIdSchema.optional(),
});

export const capabilityEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("explanation"),
    reviewId: restrictedIdSchema,
    passed: z.boolean(),
  }),
  z.object({
    kind: z.literal("transfer"),
    reviewId: restrictedIdSchema,
    passed: z.boolean(),
  }),
  z.object({
    kind: z.literal("independent-task"),
    taskId: restrictedIdSchema,
    originatingTaskId: restrictedIdSchema,
  }),
]);

export const capabilityRecordSchema = z.object({
  conceptId: restrictedIdSchema,
  level: capabilityLevelSchema,
  evidence: z.array(capabilityEvidenceSchema).min(1),
  updatedAt: z.string().datetime(),
});

export const personalReviewStateSchema = z.object({
  version: z.literal(1),
  reviewId: restrictedIdSchema,
  taskId: restrictedIdSchema,
  proposedAt: z.string().datetime(),
  candidates: z.array(knowledgeCandidateSchema).max(3),
});

export const knowledgeHistoryEntrySchema = z.object({
  revisionId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  principle: z.string().min(1),
  boundary: z.string().min(1),
  status: z.enum(["approved", "obsolete"]),
  confidence: z.number().min(0).max(1),
  reviewedAt: z.string().datetime(),
  recordedAt: z.string().datetime(),
  summary: z.string().min(1),
  evidence: z.array(evidenceRefSchema).min(1),
});

export const conceptRecordSchema = knowledgeEntrySchema.extend({
  taskId: restrictedIdSchema,
  timestamps: knowledgeTimestampsSchema.optional(),
  provenance: knowledgeProvenanceSchema.optional(),
  history: z.array(knowledgeHistoryEntrySchema).default([]),
});

export const knowledgeDecisionReceiptSchema = z.object({
  id: restrictedIdSchema,
  candidateId: restrictedIdSchema,
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  actor: z.literal("human"),
  at: z.string().datetime(),
  decision: z.enum(["approve", "reject"]),
  source: z.string().trim().min(1),
});

const strictCapabilityEvidenceSchema = z.discriminatedUnion("kind", [
  capabilityEvidenceSchema.options[0].strict(),
  capabilityEvidenceSchema.options[1].strict(),
  capabilityEvidenceSchema.options[2].strict(),
]);
const strictCapabilityRecordSchema = capabilityRecordSchema.extend({
  evidence: z.array(strictCapabilityEvidenceSchema).min(1),
}).strict();

export const capabilityInputIdentitySchema = z.object({
  conceptId: restrictedIdSchema,
  level: capabilityLevelSchema,
  evidence: z.array(strictCapabilityEvidenceSchema).min(1),
  rationale: z.string().min(1).optional(),
}).strict();

const capabilityHistoryFields = {
  operationId: restrictedIdSchema,
  conceptId: restrictedIdSchema,
  previousLevel: capabilityLevelSchema.nullable(),
  newLevel: capabilityLevelSchema,
  evidence: z.array(strictCapabilityEvidenceSchema).min(1),
  at: z.string().datetime(),
  returnedRecord: strictCapabilityRecordSchema,
};
const assessmentHistoryFields = {
  ...capabilityHistoryFields,
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  input: capabilityInputIdentitySchema,
};
export const capabilityHistoryEntrySchema = z.discriminatedUnion("kind", [
  z.object({ ...capabilityHistoryFields, kind: z.literal("baseline"), previousLevel: z.null() }).strict(),
  z.object({ ...assessmentHistoryFields, kind: z.literal("transition") }).strict(),
  z.object({ ...assessmentHistoryFields, kind: z.literal("assessment") }).strict(),
  z.object({ ...assessmentHistoryFields, kind: z.literal("noop") }).strict(),
]);

export const capabilityStateSchema = z.discriminatedUnion("version", [
  z.object({ version: z.literal(1), records: z.array(capabilityRecordSchema).default([]) }),
  z.object({
    version: z.literal(2),
    records: z.array(strictCapabilityRecordSchema),
    history: z.array(capabilityHistoryEntrySchema),
  }).strict(),
]).superRefine((state, context) => {
  if (state.version !== 2) return;
  const operations = new Set<string>();
  const latest = new Map<string, z.infer<typeof strictCapabilityRecordSchema>>();
  const fingerprints = new Map<string, string>();
  for (const [index, entry] of state.history.entries()) {
    const issue = (message: string) => context.addIssue({ code: "custom", message, path: ["history", index] });
    if (operations.has(entry.operationId)) issue("Duplicate capability operation ID");
    operations.add(entry.operationId);
    if (entry.returnedRecord.conceptId !== entry.conceptId || entry.returnedRecord.level !== entry.newLevel) issue("Capability history record mismatch");
    if (entry.kind !== "baseline" && (entry.input.conceptId !== entry.conceptId || entry.input.level !== entry.newLevel || JSON.stringify(entry.input.evidence) !== JSON.stringify(entry.evidence))) issue("Capability operation input mismatch");
    const previous = latest.get(entry.conceptId);
    if (entry.previousLevel !== (previous?.level ?? null)) issue("Capability history chain mismatch");
    if (JSON.stringify(entry.evidence) !== JSON.stringify(entry.returnedRecord.evidence)) issue("Capability history evidence differs from returned record");
    if (entry.kind !== "noop" && Date.parse(entry.at) !== Date.parse(entry.returnedRecord.updatedAt)) issue("Capability history date differs from returned record");
    if (entry.kind === "transition" && (!previous || previous.level === entry.newLevel)) issue("Capability transition must change a known level");
    if (entry.kind === "assessment" && previous && previous.level !== entry.newLevel) issue("Capability level change must be a transition");
    if (entry.kind === "noop") {
      if (!previous || JSON.stringify(entry.returnedRecord) !== JSON.stringify(previous)) issue("Capability noop must preserve the complete prior record");
      if (fingerprints.get(entry.conceptId) !== entry.contentFingerprint) issue("Capability noop requires the prior known content identity");
    } else if (entry.kind !== "baseline") fingerprints.set(entry.conceptId, entry.contentFingerprint);
    latest.set(entry.conceptId, entry.returnedRecord);
  }
  if (new Set(state.records.map(record => record.conceptId)).size !== state.records.length || latest.size !== state.records.length || state.records.some(record => JSON.stringify(record) !== JSON.stringify(latest.get(record.conceptId)))) {
    context.addIssue({ code: "custom", message: "Capability current/history mismatch", path: ["records"] });
  }
});

export type ProjectEvent = z.infer<typeof projectEventSchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type ReviewSignal = z.infer<typeof reviewSignalSchema>;
export type ReviewLevel = z.infer<typeof reviewLevelSchema>;
export type ReviewPhase = z.infer<typeof reviewPhaseSchema>;
export type ReviewRecommendation = z.infer<typeof reviewRecommendationSchema>;
export type ReviewEntry = z.infer<typeof reviewEntrySchema>;
export type ReviewSession = z.infer<typeof reviewSessionSchema>;
export type KnowledgeCandidate = z.infer<typeof knowledgeCandidateSchema>;
export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;
export type KnowledgeTimestamps = z.infer<typeof knowledgeTimestampsSchema>;
export type KnowledgeProvenance = z.infer<typeof knowledgeProvenanceSchema>;
export type CapabilityEvidence = z.infer<typeof capabilityEvidenceSchema>;
export type CapabilityRecord = z.infer<typeof capabilityRecordSchema>;
export type PersonalReviewState = z.infer<typeof personalReviewStateSchema>;
export type KnowledgeHistoryEntry = z.infer<typeof knowledgeHistoryEntrySchema>;
export type ConceptRecord = z.infer<typeof conceptRecordSchema>;
export type CapabilityState = z.infer<typeof capabilityStateSchema>;
export type KnowledgeDecisionReceipt = z.infer<typeof knowledgeDecisionReceiptSchema>;

export type TaskType = z.infer<typeof taskTypeSchema>;
export type ReviewTemplateId = z.infer<typeof reviewTemplateIdSchema>;

export type CapabilityHistoryEntry = z.infer<typeof capabilityHistoryEntrySchema>;
export type CapabilityInputIdentity = z.infer<typeof capabilityInputIdentitySchema>;

export type GrowthRecommendationMetadata = z.infer<typeof growthRecommendationMetadataSchema>;
