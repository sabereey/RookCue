import type { ConceptRecord } from "../domain/schema.js";
import type { GrowthObservation } from "./schema.js";

/** History entries contain BEFORE wording and the time of the subsequent edit. */
export function contentEpoch(concept: ConceptRecord, nowMs: number, warnings: string[]): { revised: boolean; changedAt: number } {
  const history = [...concept.history].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  let changedAt = -Infinity;
  let revised = false;
  for (let index = 0; index < history.length; index++) {
    const before = history[index]!;
    const after = history[index + 1] ?? concept;
    if (before.principle === after.principle && before.boundary === after.boundary) continue;
    const time = Date.parse(before.recordedAt);
    if (time > nowMs) { warnings.push(`Future content edit at ${before.recordedAt} ignored for scheduling.`); continue; }
    revised = true;
    changedAt = Math.max(changedAt, time);
  }
  return { revised, changedAt };
}

/** Shared current-view eligibility; a future promotion cannot suppress current feedback. */
export function observationEligibility(
  concept: ConceptRecord, event: GrowthObservation, revision: string,
  epoch: { changedAt: number }, nowMs: number,
): "future" | "earlier-content" | "predates-promotion" | undefined {
  const at = Date.parse(event.recordedAt);
  if (at > nowMs) return "future";
  if (event.contentFingerprint !== revision || at < epoch.changedAt) return "earlier-content";
  const promoted = concept.timestamps ? Date.parse(concept.timestamps.promotedAt) : NaN;
  if (Number.isFinite(promoted) && promoted <= nowMs && at < promoted) return "predates-promotion";
  return undefined;
}
