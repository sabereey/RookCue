import { contentEpoch, observationEligibility } from "./content-epoch.js";
import { join } from "node:path";
import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import { evidenceRefSchema, restrictedIdSchema, type ConceptRecord, type EvidenceRef } from "../domain/schema.js";
import { assertSafePath } from "../storage/snapshot-files.js";
import type { GrowthRepository } from "./repository.js";
import { contentFingerprint, growthObservationSchema, type GrowthObservation, type GrowthSnapshot } from "./schema.js";

export type DueItem = {
  conceptId: string;
  revision: string;
  /** Unknown baseline dates stay unknown; these rows sort first. */
  dueAt: string | null;
  isDue: boolean;
  reason: "needs-baseline" | "promotion" | "recalled" | "partial" | "forgotten" | "deferred";
  intervalDays: number;
  warnings: string[];
};
export type RecallInput = {
  kind: "recall" | "defer" | "resume";
  conceptId: string;
  revision: string;
  operationId: string;
  actor: "human";
  source: string;
  result?: "recalled" | "partial" | "forgotten";
  until?: string;
  evidence?: EvidenceRef[];
};
export type RecallRecordResult = { observation: GrowthObservation; reused: boolean; stale: boolean };

const DAY = 86_400_000;
const INTERVALS = [1, 3, 7, 14, 30] as const;
const inputFields = {
  conceptId: restrictedIdSchema, revision: z.string().regex(/^[a-f0-9]{64}$/), operationId: restrictedIdSchema,
  actor: z.literal("human"), source: z.string().trim().min(1), evidence: z.array(evidenceRefSchema.strict()).optional(),
};
const recallInputSchema = z.discriminatedUnion("kind", [
  z.object({ ...inputFields, kind: z.literal("recall"), result: z.enum(["recalled", "partial", "forgotten"]) }).strict(),
  z.object({ ...inputFields, kind: z.literal("defer"), until: z.string().datetime() }).strict(),
  z.object({ ...inputFields, kind: z.literal("resume") }).strict(),
]);
type ValidInput = z.infer<typeof recallInputSchema>;

/** Pure scheduling: inspecting a queue never records an assessment. */
export function deriveDueQueue(snapshot: GrowthSnapshot, now: Date): DueItem[] {
  const nowMs = validTime(now);
  return snapshot.concepts.filter((concept) => concept.status === "approved").map((concept): DueItem => {
    const revision = contentFingerprint(concept);
    const warnings: string[] = [];
    const epoch = contentEpoch(concept, nowMs, warnings);
    const promoted = concept.timestamps ? Date.parse(concept.timestamps.promotedAt) : NaN;
    if (promoted > nowMs) warnings.push("Promotion date is in the future; ignored for scheduling.");
    const olderContentObserved = snapshot.observations.some((event) => event.conceptId === concept.id
      && event.contentFingerprint !== revision && Date.parse(event.recordedAt) <= nowMs);
    let dueAt = !epoch.revised && !olderContentObserved && Number.isFinite(promoted) && promoted <= nowMs ? new Date(promoted + DAY).toISOString() : null;
    let reason: DueItem["reason"] = dueAt === null ? "needs-baseline" : "promotion";
    let step = 0;
    let deferred: string | undefined;
    const events = snapshot.observations.filter((event) => {
      if (event.conceptId !== concept.id) return false;
      const at = Date.parse(event.recordedAt);
      const eligibility = observationEligibility(concept, event, revision, epoch, nowMs);
      if (eligibility === "future") { warnings.push(`Future observation ${event.id} ignored for scheduling.`); return false; }
      if (eligibility === "earlier-content") {
        warnings.push(`Observation ${event.id} refers to earlier content; ignored for scheduling.`); return false;
      }
      if (at === epoch.changedAt) warnings.push(`Observation ${event.id} shares the content edit timestamp; accepted current fingerprint with limited ordering precision.`);
      if (eligibility === "predates-promotion") {
        warnings.push(`Observation ${event.id} predates promotion; ignored for scheduling.`); return false;
      }
      return true;
    }).sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || compare(a.id, b.id));

    // One timestamp is one assessment opportunity, even across device copies.
    // Conflicting outcomes use forgotten, then partial, then recalled; a recall
    // or resume at the same instant takes precedence over a deferral.
    for (let index = 0; index < events.length;) {
      const first = events[index]!;
      const batch: GrowthObservation[] = [];
      while (events[index] && Date.parse(events[index]!.recordedAt) === Date.parse(first.recordedAt)) batch.push(events[index++]!);
      const recalls = batch.filter((event) => event.kind === "recall");
      const defers = batch.filter((event) => event.kind === "defer");
      const resumes = batch.filter((event) => event.kind === "resume");
      const outcomes = new Set(recalls.map((event) => event.result));
      if (outcomes.size > 1 || (defers.length > 0 && (recalls.length > 0 || resumes.length > 0)) || new Set(defers.map((event) => Date.parse(event.until))).size > 1) {
        warnings.push(`Simultaneous contradictory observations (${batch.map((event) => event.id).join(", ")}); used conservative scheduling.`);
      }
      if (recalls.length > 0) {
        const outcome = outcomes.has("forgotten") ? "forgotten" : outcomes.has("partial") ? "partial" : "recalled";
        step = outcome === "forgotten" ? 0 : outcome === "recalled" ? Math.min(step + 1, INTERVALS.length - 1) : step;
        dueAt = new Date(Date.parse(first.recordedAt) + INTERVALS[step]! * DAY).toISOString();
        reason = outcome;
        deferred = undefined;
      } else if (resumes.length > 0) deferred = undefined;
      else if (defers.length > 0) {
        const valid = defers.filter((event) => Date.parse(event.until) > Date.parse(event.recordedAt));
        if (valid.length !== defers.length) warnings.push(`Invalid deferral at ${first.recordedAt} ignored.`);
        if (valid.length > 0) deferred = new Date(Math.min(...valid.map((event) => Date.parse(event.until)))).toISOString();
      }
    }
    // Deferral may postpone the underlying due date, never make it earlier.
    if (deferred && (dueAt === null || Date.parse(deferred) > Date.parse(dueAt))) {
      dueAt = deferred;
      reason = "deferred";
    }
    return { conceptId: concept.id, revision, dueAt, isDue: dueAt === null || Date.parse(dueAt) <= nowMs,
      reason, intervalDays: INTERVALS[step]!, warnings: warnings.sort(compare) };
  }).sort((a, b) => (a.dueAt === null ? b.dueAt === null ? 0 : -1 : b.dueAt === null ? 1 : compare(a.dueAt, b.dueAt)) || compare(a.conceptId, b.conceptId));
}

export class RecallService {
  constructor(private readonly repository: GrowthRepository, private readonly options: { clock: () => Date }) {}

  async record(input: RecallInput): Promise<RecallRecordResult> {
    const parsed = recallInputSchema.safeParse(input);
    if (!parsed.success) throw new DomainError("INVALID_GROWTH_OBSERVATION", "Feedback requires a safe operation ID, current revision and explicit human source", { issues: parsed.error.issues });
    const logical = parsed.data;
    const root = this.repository.paths.personal.base;
    // The root lock creates directories, so reject unsafe roots before taking it.
    await assertSafePath(root, "directory", root);
    await assertSafePath(join(root, ".mutation.lock"), "directory", root);
    return this.repository.personalRepository.withMutationLock(async () => {
      const snapshot = await this.repository.readSnapshot();
      const existing = snapshot.observations.find((event) => event.id === logical.operationId);
      const concept = snapshot.concepts.find((item) => item.id === logical.conceptId);
      if (existing) {
        if (JSON.stringify(observation(logical, existing.recordedAt)) !== JSON.stringify(normalizeObservation(existing))) {
          throw new DomainError("GROWTH_OPERATION_CONFLICT", "Operation ID already belongs to different logical feedback", { operationId: logical.operationId });
        }
        return { observation: existing, reused: true, stale: isStale(concept, existing) };
      }
      if (!concept || concept.status !== "approved" || contentFingerprint(concept) !== logical.revision) {
        throw new DomainError("GROWTH_STALE_CONTENT", "Concept is missing, obsolete or changed; inspect current content before recording feedback", { conceptId: logical.conceptId });
      }
      const now = this.options.clock();
      const nowMs = validTime(now);
      if (logical.kind === "defer" && Date.parse(logical.until) <= nowMs) {
        throw new DomainError("INVALID_GROWTH_OBSERVATION", "Deferral must end at a future ISO timestamp");
      }
      const saved = observation(logical, now.toISOString());
      await this.repository.saveObservation(saved);
      return { observation: saved, reused: false, stale: false };
    });
  }
}

function observation(input: ValidInput, recordedAt: string): GrowthObservation {
  const { operationId, revision, ...fields } = input;
  return normalizeObservation(growthObservationSchema.parse({ version: 1, id: operationId, contentFingerprint: revision, recordedAt, ...fields }));
}
function normalizeObservation(event: GrowthObservation): GrowthObservation {
  const normalized = growthObservationSchema.parse(event);
  if (normalized.kind === "defer") normalized.until = new Date(normalized.until).toISOString();
  if (normalized.evidence?.length === 0) delete normalized.evidence;
  return normalized;
}
function validTime(now: Date): number {
  const time = now.getTime();
  if (!Number.isFinite(time)) throw new DomainError("INVALID_GROWTH_OBSERVATION", "Clock must provide a valid date");
  return time;
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function isStale(concept: ConceptRecord | undefined, event: GrowthObservation): boolean {
  if (!concept || concept.status !== "approved" || contentFingerprint(concept) !== event.contentFingerprint) return true;
  return Date.parse(event.recordedAt) < contentEpoch(concept, Infinity, []).changedAt;
}
