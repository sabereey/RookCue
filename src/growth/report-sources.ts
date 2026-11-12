import { capabilityLevelSchema, type CapabilityRecord, type ReviewTemplateId } from "../domain/schema.js";
import { capabilityHistory } from "./capability-history.js";
import type { GrowthSnapshot } from "./schema.js";

export type GrowthReportEvent = {
  kind: "concept-promoted" | "concept-revised" | "review-completed" | "method-used" | "recall" | "defer" | "resume" | "capability-baseline" | "capability-transition" | "capability-assessment";
  at: string;
  source: { kind: "concept" | "captured-review" | "observation" | "capability-operation" | "capability-record"; id: string; historyIndex?: number; revisionId?: string };
  conceptId?: string;
  sourceId?: string;
  taskId?: string;
  reviewId?: string;
  templateId?: ReviewTemplateId;
  result?: "recalled" | "partial" | "forgotten";
  until?: string;
  contentFingerprint?: string;
  previousLevel?: CapabilityRecord["level"] | null;
  newLevel?: CapabilityRecord["level"];
  direction?: "rise" | "downgrade" | "initial" | "unchanged";
  warnings?: string[];
};
export type GrowthReportGap = { code: string; recordIds: string[]; message: string };
export type GrowthReportCoverage = ReturnType<typeof collectReportSources>["coverage"];

/** References existing stored records only; no source paths are resolved or followed. */
export function collectReportSources(snapshot: GrowthSnapshot, from: string, to: string, now: Date) {
  const events: GrowthReportEvent[] = [];
  const gaps: GrowthReportGap[] = [];
  const gap = (code: string, recordIds: string[], message: string) => gaps.push({ code, recordIds: sorted(recordIds), message });
  const start = Date.parse(from);
  const end = Date.parse(to);
  const add = (event: GrowthReportEvent) => {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) { gap("unknown-event-time", [event.source.id], "An event has no usable timestamp and is excluded from period totals."); return; }
    if (at > now.getTime()) gap("future-event", [event.source.id], "A future-dated event is excluded from observed period totals.");
    if (at >= start && at < end) events.push({ ...event, at: new Date(at).toISOString() });
  };
  for (const concept of snapshot.concepts) {
    if (concept.timestamps) add({ kind: "concept-promoted", at: concept.timestamps.promotedAt, source: { kind: "concept", id: concept.id }, conceptId: concept.id });
    else gap("unknown-promotion-time", [concept.id], "Legacy promotion time is unknown; reviewedAt is not substituted.");
    concept.history.forEach((entry, historyIndex) => {
      add({ kind: "concept-revised", at: entry.recordedAt, source: { kind: "concept", id: concept.id, historyIndex, ...(entry.revisionId ? { revisionId: entry.revisionId } : {}) }, conceptId: concept.id });
      if (!entry.revisionId) gap("unknown-revision-identity", [concept.id], "A legacy revision is dated but lacks a stored revision identity; its concept and history index identify the source.");
    });
    const origin = concept.provenance?.sourceProject;
    if (!origin || (origin !== snapshot.projectRoot && origin !== snapshot.sourceId)) gap("unavailable-concept-source", [concept.id], "The original project is unavailable in this selected snapshot; provenance paths are not followed.");
  }
  for (const review of snapshot.capturedReviews) {
    if (review.taskCompletedAt == null) gap("unknown-task-completion", [review.id], "The linked task completion time is unknown; review/capture dates are not task closure evidence and cannot establish a completed-task history sample.");
    if (review.completedAt === null) gap("unknown-review-completion", [review.id], "Legacy review completion time is unknown; capture/start times are not completion events.");
    if (Date.parse(review.capturedAt) > now.getTime()) { gap("future-capture", [review.id], "The capture timestamp is after generation time; this record is excluded from observed events."); continue; }
    if (review.completedAt === null) continue;
    const fields = { at: review.completedAt, source: { kind: "captured-review" as const, id: review.id }, sourceId: review.sourceId, taskId: review.taskId, reviewId: review.reviewId };
    add({ kind: "review-completed", ...fields });
    for (const templateId of sorted(review.templateIds)) add({ kind: "method-used", ...fields, templateId });
  }
  for (const review of snapshot.reviews) {
    if (review.status !== "completed") continue;
    if (!review.completedAt) gap("unknown-selected-review-completion", [review.id], "A legacy selected-project review has unknown completion time; its start time is not a completion event.");
    if (!snapshot.sourceId || !snapshot.capturedReviews.some((item) => item.sourceId === snapshot.sourceId && item.reviewId === review.id && Date.parse(item.capturedAt) <= now.getTime())) {
      gap("uncaptured-selected-review", [review.id], "A completed selected-project review has not been captured; read commands never capture it implicitly.");
    }
  }
  for (const observation of snapshot.observations) {
    add({ kind: observation.kind, at: observation.recordedAt, source: { kind: "observation", id: observation.id }, conceptId: observation.conceptId,
      contentFingerprint: observation.contentFingerprint,
      ...(observation.kind === "recall" ? { result: observation.result } : observation.kind === "defer" ? { until: observation.until } : {}) });
  }
  for (const entry of capabilityHistory(snapshot)) {
    const storedOperation = snapshot.capabilities.version === 2 && snapshot.capabilities.history.some((item) => item.operationId === entry.operationId);
    const source = { kind: storedOperation ? "capability-operation" as const : "capability-record" as const, id: storedOperation ? entry.operationId : entry.conceptId };
    const levels = capabilityLevelSchema.options;
    const direction = entry.previousLevel === null ? "initial" : levels.indexOf(entry.newLevel) > levels.indexOf(entry.previousLevel) ? "rise" : levels.indexOf(entry.newLevel) < levels.indexOf(entry.previousLevel) ? "downgrade" : "unchanged";
    add({ kind: `capability-${entry.kind}`, at: entry.at, source, conceptId: entry.conceptId, previousLevel: entry.previousLevel, newLevel: entry.newLevel, direction, warnings: entry.warnings,
      ...(entry.contentFingerprint ? { contentFingerprint: entry.contentFingerprint } : {}) });
    if (entry.warnings.includes("history-gap")) gap("capability-history-gap", [source.id], "Previous capability history is incomplete; a baseline is not an improvement.");
    const otherWarnings = entry.warnings.filter((warning) => warning !== "history-gap");
    if (otherWarnings.length > 0) gap("capability-evidence-limitations", [source.id], `Capability history warnings: ${otherWarnings.join(", ")}.`);
  }
  const records = {
    concepts: sorted(snapshot.concepts.map((item) => item.id)), capturedReviews: sorted(snapshot.capturedReviews.map((item) => item.id)),
    observations: sorted(snapshot.observations.map((item) => item.id)), capabilityRecords: sorted(snapshot.capabilities.records.map((item) => item.conceptId)),
    capabilityOperations: snapshot.capabilities.version === 2 ? sorted(snapshot.capabilities.history.map((item) => item.operationId)) : [],
    selectedTasks: sorted(snapshot.tasks.map((item) => item.id)), selectedReviews: sorted(snapshot.reviews.map((item) => item.id)),
    decisionReceipts: sorted(snapshot.decisionReceipts.map((item) => item.id)), personalReviews: sorted(snapshot.personalReviewStates.map((item) => item.reviewId)),
    selectedCheckpoints: sorted(snapshot.checkpoints.map((item) => item.id)), selectedEvents: sorted(snapshot.events.map((item) => item.id)),
  };
  if (Object.values(records).every((ids) => ids.length === 0)) gap("no-source-data", [], "No growth source records are available; zero observed events does not establish improvement or mastery.");
  return { events: events.sort((a, b) => compare(a.at, b.at) || compare(a.kind, b.kind) || compare(JSON.stringify(a), JSON.stringify(b))), coverage: {
    scope: "Selected personal records and the explicitly selected project only; other projects are not scanned.",
    selectedProjectSourceId: snapshot.sourceId ?? null,
    sourceIds: sorted([...snapshot.capturedReviews.map((item) => item.sourceId), ...(snapshot.sourceId ? [snapshot.sourceId] : [])]),
    records, counts: Object.fromEntries(Object.entries(records).map(([key, ids]) => [key, ids.length])) as Record<keyof typeof records, number>,
    gaps: gaps.sort((a, b) => compare(a.code, b.code) || compare(JSON.stringify(a.recordIds), JSON.stringify(b.recordIds)) || compare(a.message, b.message)),
  } };
}

function sorted<T extends string>(values: T[]): T[] { return [...new Set(values)].sort(compare); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
