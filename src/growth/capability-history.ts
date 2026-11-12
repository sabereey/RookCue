import { createHash } from "node:crypto";
import type { CapabilityHistoryEntry, CapabilityRecord } from "../domain/schema.js";
import { contentFingerprint, type GrowthSnapshot } from "./schema.js";

/** Baselines retain known facts only; their prior trajectory and wording are unknown. */
export function legacyCapabilityBaselines(records: CapabilityRecord[]): Extract<CapabilityHistoryEntry, { kind: "baseline" }>[] {
  return records.map((record) => ({
    kind: "baseline", operationId: `baseline-${createHash("sha256").update(record.conceptId).digest("hex")}`,
    conceptId: record.conceptId, previousLevel: null, newLevel: record.level,
    evidence: record.evidence, at: record.updatedAt, returnedRecord: record,
  }));
}

export type CapabilityHistoryWarning = "history-gap" | "unknown-content" | "stale-content" | "missing-concept" | "obsolete-concept";
export type CapabilityHistoryView = Exclude<CapabilityHistoryEntry, { kind: "noop" }> & {
  contentFingerprint?: string;
  warnings: CapabilityHistoryWarning[];
};

/** Pure read projection; no-op operation receipts never become growth events. */
export function capabilityHistory(snapshot: GrowthSnapshot, conceptId?: string): CapabilityHistoryView[] {
  const state = snapshot.capabilities;
  const entries = state.version === 1 ? legacyCapabilityBaselines(state.records) : state.history;
  const known = entries.filter((entry): entry is Exclude<CapabilityHistoryEntry, { kind: "noop" }> => entry.kind !== "noop");
  const missing = state.records.filter((record) => !known.some((entry) => entry.conceptId === record.conceptId));
  return [...known, ...legacyCapabilityBaselines(missing)]
    .filter((entry) => conceptId === undefined || entry.conceptId === conceptId)
    .map((entry) => {
      const concept = snapshot.concepts.find((item) => item.id === entry.conceptId);
      const warnings: CapabilityHistoryWarning[] = [];
      if (entry.kind === "baseline") warnings.push("history-gap", "unknown-content");
      else {
        const index = known.indexOf(entry);
        const previous = known.slice(0, index).reverse().find((item) => item.conceptId === entry.conceptId);
        if (entry.previousLevel !== null && previous?.newLevel !== entry.previousLevel) warnings.push("history-gap");
        if (concept && entry.contentFingerprint !== contentFingerprint(concept)) warnings.push("stale-content");
      }
      const latest = [...known].reverse().find((item) => item.conceptId === entry.conceptId);
      const current = state.records.find((record) => record.conceptId === entry.conceptId);
      if (entry === latest && JSON.stringify(current) !== JSON.stringify(entry.returnedRecord) && !warnings.includes("history-gap")) warnings.push("history-gap");
      if (!concept) warnings.push("missing-concept");
      else if (concept.status === "obsolete") warnings.push("obsolete-concept");
      return { ...entry, warnings };
    });
}
