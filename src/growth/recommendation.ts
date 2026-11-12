import { contentEpoch, observationEligibility } from "./content-epoch.js";
import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import {
  growthRecommendationMetadataSchema, restrictedIdSchema, reviewSignalSchema, taskTypeSchema,
  type GrowthRecommendationMetadata, type ReviewRecommendation, type ReviewSignal,
  type ReviewTemplateId, type TaskType,
} from "../domain/schema.js";
import { recommendReview } from "../review/recommendation.js";
import { capturedReviewSchema, contentFingerprint, growthObservationSchema, type CapturedReview, type GrowthSnapshot } from "./schema.js";

export type GrowthRecommendationInput = { taskId?: string; type?: TaskType; conceptIds?: string[]; signals?: ReviewSignal[] };
export type GrowthRecommendation = ReviewRecommendation & GrowthRecommendationMetadata;
const inputSchema = z.object({
  taskId: restrictedIdSchema.optional(), type: taskTypeSchema.optional(),
  conceptIds: z.array(restrictedIdSchema).optional(), signals: z.array(reviewSignalSchema).optional(),
}).strict();
const DAY = 86_400_000;

/** Pure advice from explicitly supplied records; this does not select or run a method. */
export function recommendGrowth(snapshot: GrowthSnapshot, input: GrowthRecommendationInput, now: Date): GrowthRecommendation {
  const parsed = inputSchema.safeParse(input);
  const end = now.getTime();
  if (!parsed.success || !Number.isFinite(end)) {
    throw new DomainError("INVALID_GROWTH_RECOMMENDATION", "Advice requires valid explicit task metadata, signals and clock");
  }
  const current = parsed.data;
  const task = current.taskId === undefined ? undefined : snapshot.tasks.find((item) => item.id === current.taskId);
  if (current.taskId !== undefined && !task) throw new DomainError("TASK_NOT_FOUND", "Selected task is absent from the supplied snapshot", { taskId: current.taskId });
  const type = current.type ?? task?.type;
  const conceptIds = new Set(current.conceptIds ?? task?.conceptIds ?? []);
  const base = recommendReview(current.signals ?? []);
  const start = end - 30 * DAY;
  const inWindow = (value: string) => { const at = Date.parse(value); return at >= start && at <= end; };

  // Only explicit captures are portable history. Current project reviews are not implicitly captured.
  const groups = new Map<string, CapturedReview[]>();
  for (const candidate of snapshot.capturedReviews) {
    const result = capturedReviewSchema.safeParse(candidate);
    if (!result.success) continue;
    const item = result.data;
    if (item.completedAt === null || !inWindow(item.completedAt) || Date.parse(item.capturedAt) > end) continue;
    if (item.taskCompletedAt == null || !inWindow(item.taskCompletedAt)) continue;
    if (snapshot.sourceId === item.sourceId && current.taskId === item.taskId) continue;
    const related = conceptIds.size > 0 ? item.conceptIds.some((id) => conceptIds.has(id))
      : type !== undefined && type !== "general" && item.taskType === type && snapshot.sourceId === item.sourceId;
    if (!related) continue;
    const key = JSON.stringify([item.sourceId, item.taskId]);
    const entries = groups.get(key) ?? [];
    entries.push(item);
    groups.set(key, entries);
  }
  const samples = [...groups.values()].map((items) => ({
    sourceId: items[0]!.sourceId, taskId: items[0]!.taskId,
    reviewIds: [...new Set(items.map((item) => item.reviewId))].sort(compare),
    completedAt: new Date(Math.max(...items.map((item) => Date.parse(item.taskCompletedAt!)))).toISOString(),
  })).sort((a, b) => compare(a.sourceId, b.sourceId) || compare(a.taskId, b.taskId));
  const failureTaskCount = [...groups.values()].filter((items) => items.some((item) => item.signals.includes("failure-or-rework"))).length;
  const recall = relatedRecall(snapshot, conceptIds, inWindow, end);
  const unresolvedRecallCount = recall.reduce((sum, item) => sum + item.unresolvedCount, 0);
  const score = Math.max(base.score, failureTaskCount >= 2 ? 2 : unresolvedRecallCount >= 2 ? 1 : 0);
  const reasons = [...base.reasons];
  if (failureTaskCount >= 2) reasons.push("At least two distinct relevant prior tasks reported failure or rework; additional review attention is suggested.");
  else if (unresolvedRecallCount >= 2) reasons.push("At least two related current-content human recall operations remain unresolved; a quick review is suggested.");
  const methods = methodAdvice(type, base.signals, unresolvedRecallCount);
  const available = samples.length > 0 || recall.length > 0;
  const metadata = growthRecommendationMetadataSchema.parse({
    ruleVersion: "growth-v1", baseScore: base.score, historyAdjustment: score - base.score,
    history: {
      status: available ? "available" : "insufficient-history",
      window: { startInclusive: new Date(start).toISOString(), endInclusive: now.toISOString() },
      relevantTaskCount: samples.length, failureTaskCount, unresolvedRecallCount,
      sourceIds: [...new Set(samples.map((item) => item.sourceId))].sort(compare), samples, recall,
      reason: available ? "Only distinct relevant captured tasks and current-content human recall operations in this UTC window are used; these reports do not establish mastery or causality."
        : "Insufficient history: no usable relevant captured tasks or current-content human recall operations in this UTC window.",
    }, ...methods,
  });
  return { ...base, level: score === 0 ? "skip" : score === 1 ? "quick" : "deep", score, reasons, ...metadata };
}

function relatedRecall(snapshot: GrowthSnapshot, conceptIds: Set<string>, inWindow: (value: string) => boolean, nowMs: number): GrowthRecommendationMetadata["history"]["recall"] {
  const records: GrowthRecommendationMetadata["history"]["recall"] = [];
  // Identical copies count once; conflicting copies cannot establish a human operation.
  const operations = new Map<string, { record: string; conflicted: boolean }>();
  const valid = snapshot.observations.flatMap((item) => {
    const parsed = growthObservationSchema.safeParse(item);
    if (!parsed.success) return [];
    const record = JSON.stringify(parsed.data);
    const previous = operations.get(parsed.data.id);
    operations.set(parsed.data.id, { record, conflicted: (previous?.conflicted ?? false) || (previous !== undefined && previous.record !== record) });
    return [parsed.data];
  });
  const observations = valid.filter((item) => item.kind === "recall").filter((item) => !operations.get(item.id)!.conflicted && inWindow(item.recordedAt));
  for (const concept of snapshot.concepts) {
    if (concept.status !== "approved" || !conceptIds.has(concept.id)) continue;
    const fingerprint = contentFingerprint(concept);
    const epoch = contentEpoch(concept, nowMs, []);
    const seen = new Set<string>();
    const related = observations.filter((item) => item.conceptId === concept.id && observationEligibility(concept, item, fingerprint, epoch, nowMs) === undefined)
      // An explicit recalled at the same clock clears prior risk; IDs do not imply human ordering.
      .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt)
        || Number(a.result === "recalled") - Number(b.result === "recalled") || compare(a.id, b.id))
      .filter((item) => { if (seen.has(item.id)) return false; seen.add(item.id); return true; });
    const latest = related.at(-1);
    if (!latest) continue;
    const recalledAt = Math.max(-Infinity, ...related.filter((item) => item.result === "recalled").map((item) => Date.parse(item.recordedAt)));
    const unresolved = related.filter((item) => item.result !== "recalled" && Date.parse(item.recordedAt) > recalledAt);
    records.push({ conceptId: concept.id, contentFingerprint: fingerprint, latestOutcome: latest.result,
      latestObservedAt: new Date(latest.recordedAt).toISOString(), unresolvedCount: unresolved.length, observationIds: unresolved.map((item) => item.id).sort(compare) });
  }
  return records.sort((a, b) => compare(a.conceptId, b.conceptId));
}

function methodAdvice(type: TaskType | undefined, signals: ReviewSignal[], unresolved: number): Pick<GrowthRecommendationMetadata, "suggestedMethod" | "alternatives" | "methodReasons"> {
  const applicable: { id: ReviewTemplateId; reason: string }[] = [];
  if (signals.includes("failure-or-rework")) applicable.push({ id: "five-whys", reason: "The current task explicitly reports failure or rework; five-whys can structure investigation." });
  if (signals.includes("unfamiliar-technology") || unresolved > 0) applicable.push({ id: "feynman", reason: "Current unfamiliar technology or unresolved related human recall suggests an explanation check with feynman." });
  if (type === "architecture" || type === "implementation" || type === "research" || signals.includes("architecture-change")) applicable.push({ id: "aar", reason: "Explicit architecture, implementation or research work can use aar to compare intent and outcome." });
  if (type === "refactor") applicable.push({ id: "kpt", reason: "The explicit refactor task type can use kpt to identify what to keep, change and try." });
  return { suggestedMethod: applicable[0]?.id ?? null, alternatives: applicable.slice(1).map((item) => item.id),
    methodReasons: applicable.length > 0 ? applicable.map((item) => item.reason) : ["No method is suggested without an applicable explicit task type, current signal or unresolved related recall."] };
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
