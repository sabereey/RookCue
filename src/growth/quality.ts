import { DomainError } from "../domain/errors.js";
import { restrictedIdSchema, type ConceptRecord, type EvidenceRef, type KnowledgeCandidate } from "../domain/schema.js";
import { candidateDigest } from "../personal/candidate-identity.js";
import { contentFingerprint, type GrowthSnapshot } from "./schema.js";

export type QualityEvidenceStatus = "verified-local" | "declared-external" | "unavailable-source" | "missing";
export type QualityDimension = "structure" | "provenance" | "evidence" | "consistency";
export type QualityCheck = {
  id: string;
  dimension: QualityDimension;
  points: number;
  earned: number;
  unknown: number;
  status: "passed" | "missing" | "unknown" | "inconsistent" | QualityEvidenceStatus;
  message: string;
  correctiveAction: string;
  evidenceIds: string[];
};
export type QualityEvidence = EvidenceRef & {
  status: QualityEvidenceStatus;
  points: number;
  earned: number;
  unknown: number;
};
export type QualityFinding = {
  code: string;
  message: string;
  correctiveAction: string;
  evidenceIds: string[];
};
export type QualityAssessment = {
  conceptId: string;
  revision: string;
  ruleVersion: "growth-v1";
  measure: "documentation-and-evidence-quality";
  earned: number;
  unknown: number;
  range: { min: number; max: number };
  /** Fraction of the rubric that can be assessed, from zero to one. */
  coverage: number;
  score?: number;
  status: "assessed" | "insufficient-evidence";
  checks: QualityCheck[];
  findings: QualityFinding[];
  evidence: QualityEvidence[];
};

/** Assess supplied records only. This measures documentation/evidence, never mastery or truth. */
export function assessQuality(snapshot: GrowthSnapshot, conceptId?: string): QualityAssessment[] {
  if (conceptId !== undefined && !restrictedIdSchema.safeParse(conceptId).success) {
    throw new DomainError("INVALID_CONCEPT_ID", "Concept identifier must be path-safe", { conceptId });
  }
  const concepts = snapshot.concepts.filter((concept) => conceptId === undefined ? concept.status !== "obsolete" : concept.id === conceptId);
  if (conceptId !== undefined && concepts.length === 0) {
    throw new DomainError("CONCEPT_NOT_FOUND", `Concept ${conceptId} not found in the supplied snapshot`, { conceptId });
  }
  return [...concepts].sort((a, b) => a.id.localeCompare(b.id)).map((concept) => assessConcept(snapshot, concept));
}

function assessConcept(snapshot: GrowthSnapshot, concept: ConceptRecord): QualityAssessment {
  const checks: QualityCheck[] = [];
  const findings: QualityFinding[] = [];
  const add = (id: string, dimension: QualityDimension, points: number, status: QualityCheck["status"], message: string, correctiveAction: string, evidenceIds: string[] = []) => {
    checks.push({ id, dimension, points, status, message, correctiveAction, evidenceIds,
      earned: status === "passed" || status === "verified-local" ? points : 0,
      unknown: status === "unknown" || status === "declared-external" || status === "unavailable-source" ? points : 0 });
  };
  for (const field of ["principle", "boundary"] as const) {
    add(`structure.${field}`, "structure", 10, concept[field].trim() ? "passed" : "missing",
      `The ${field} ${concept[field].trim() ? "contains text" : "is blank"}.`, `Write a concrete ${field}.`);
  }
  const provenance = concept.provenance;
  for (const [field, expected] of [["candidateId", concept.id], ["reviewId", concept.reviewId], ["taskId", concept.taskId]] as const) {
    const actual = provenance?.[field];
    add(`provenance.${field}`, "provenance", 5, !actual ? "missing" : actual === expected ? "passed" : "inconsistent",
      !actual ? `The provenance ${field} is missing.` : actual === expected ? `The provenance ${field} matches the concept.` : `The provenance ${field} does not match the concept.`,
      `Restore the original matching ${field} provenance identifier.`, actual ? [actual] : []);
  }
  const receipt = snapshot.decisionReceipts.find((item) => item.id === provenance?.decisionReceiptId);
  const originalCandidates = originalIdentities(snapshot, concept);
  const receiptValid = receipt !== undefined && receipt.actor === "human" && receipt.decision === "approve"
    && receipt.candidateId === concept.id && provenance?.candidateId === concept.id
    && originalCandidates.some((candidate) => candidateDigest(candidate) === receipt.candidateDigest);
  add("provenance.receipt", "provenance", 5, receiptValid ? "passed" : receipt ? "inconsistent" : "missing",
    receiptValid ? "A human receipt matches the original candidate digest; it does not approve later wording." : receipt ? "The receipt does not approve a matching original candidate digest." : "The original personal approval receipt is missing.",
    "Restore the original human approval receipt and matching candidate history; use an explicit human review for revised wording.", provenance?.decisionReceiptId ? [provenance.decisionReceiptId] : []);

  const sourceAvailable = provenance?.sourceProject !== undefined &&
    (provenance.sourceProject === snapshot.projectRoot || (snapshot.sourceId !== undefined && provenance.sourceProject === snapshot.sourceId));
  const originals = snapshot.personalReviewStates.filter((state) => state.reviewId === concept.reviewId && state.taskId === concept.taskId)
    .flatMap((state) => state.candidates).filter((candidate) => candidate.id === concept.id);
  if (originals.length === 0) findings.push({ code: "original-candidate-unavailable", message: "The original personal candidate record is unavailable; receipt validation uses matching historical/current content when possible.", correctiveAction: "Restore the original personal review record if available.", evidenceIds: [concept.id, concept.reviewId] });
  if (!sourceAvailable) findings.push({ code: "unavailable-source", message: "The concept source is not the explicitly supplied project; project evidence cannot be verified here.", correctiveAction: "Supply the matching source project snapshot to verify local evidence.", evidenceIds: [concept.taskId, concept.reviewId] });
  else {
    for (const [kind, id, exists] of [["task", concept.taskId, snapshot.tasks.some((task) => task.id === concept.taskId)], ["review", concept.reviewId, snapshot.reviews.some((review) => review.id === concept.reviewId)]] as const) {
      if (!exists) findings.push({ code: `missing-local-${kind}`, message: `The provenance ${kind} ${id} is absent from the selected project snapshot.`, correctiveAction: `Restore the missing local ${kind} record or correct its provenance.`, evidenceIds: [id] });
    }
  }
  const uniqueRefs = [...new Map(concept.evidence.map((ref) => [JSON.stringify([ref.kind, ref.id, ref.path ?? ""]), ref])).values()];
  const evidence: QualityEvidence[] = uniqueRefs.map((reference) => {
    const status = evidenceStatus(snapshot, reference, sourceAvailable);
    const points = 40 / uniqueRefs.length;
    add(`evidence.${reference.kind}.${reference.id}.${checks.length}`, "evidence", points, status,
      `${reference.kind} ${reference.id}: ${status}.`,
      status === "verified-local" ? "Keep the referenced source record available." : status === "missing" ? "Restore or replace the dangling local evidence reference." : status === "declared-external" ? "Independently inspect the declared external evidence; this assessment does not execute tests or verify commits." : "Supply the matching source project snapshot to assess this evidence.", [reference.id]);
    return { ...reference, status, points, earned: status === "verified-local" ? points : 0, unknown: status === "declared-external" || status === "unavailable-source" ? points : 0 };
  });
  if (uniqueRefs.length === 0) add("evidence.none", "evidence", 40, "missing", "No evidence is referenced.", "Attach concrete evidence references.");
  add("consistency.status", "consistency", 10, concept.status === "approved" ? "passed" : "inconsistent",
    concept.status === "approved" ? "The concept is active and approved." : "The concept is obsolete.", "Review whether the concept should remain obsolete before reusing it.", [concept.id]);
  const coherence = metadataCoherence(concept, receipt?.at);
  add("consistency.metadata", "consistency", 10, coherence.status, coherence.message,
    "Restore coherent original timestamps and revision history; do not invent missing historical dates.", [concept.id]);
  if (originalCandidates.some((candidate) => candidateDigest(candidate) === receipt?.candidateDigest && (candidate.principle !== concept.principle || candidate.boundary !== concept.boundary))) {
    findings.push({ code: "revision-after-approval", message: "The current principle or boundary differs from the originally approved wording; the original receipt does not re-approve this revision.", correctiveAction: "Review the revised wording and its evidence explicitly with a human.", evidenceIds: [concept.id, ...(receipt ? [receipt.id] : [])] });
  }
  for (const check of checks) if (check.status !== "passed" && check.status !== "verified-local") {
    findings.push({ code: check.id, message: check.message, correctiveAction: check.correctiveAction, evidenceIds: check.evidenceIds });
  }
  const earned = round(checks.reduce((sum, check) => sum + check.earned, 0));
  const unknown = round(checks.reduce((sum, check) => sum + check.unknown, 0));
  return { conceptId: concept.id, revision: contentFingerprint(concept), ruleVersion: "growth-v1", measure: "documentation-and-evidence-quality", earned, unknown,
    range: { min: earned, max: round(earned + unknown) }, coverage: round((100 - unknown) / 100), ...(unknown === 0 ? { score: earned } : {}),
    status: unknown === 0 ? "assessed" : "insufficient-evidence", checks, findings, evidence };
}

function originalIdentities(snapshot: GrowthSnapshot, concept: ConceptRecord): KnowledgeCandidate[] {
  const saved = snapshot.personalReviewStates.filter((state) => state.reviewId === concept.reviewId && state.taskId === concept.taskId)
    .flatMap((state) => state.candidates).filter((candidate) => candidate.id === concept.id && candidate.reviewId === concept.reviewId && candidate.ordinal === concept.ordinal);
  // Revision entries preserve the previous wording; evidence remains the original candidate evidence.
  const original = concept.history[0] ?? concept;
  return [...saved, { id: concept.id, reviewId: concept.reviewId, ordinal: concept.ordinal,
    principle: original.principle, boundary: original.boundary, evidence: concept.evidence, status: "approved" }];
}
function evidenceStatus(snapshot: GrowthSnapshot, reference: EvidenceRef, sourceAvailable: boolean): QualityEvidenceStatus {
  if (reference.kind === "commit" || reference.kind === "test") return "declared-external";
  if (!sourceAvailable) return "unavailable-source";
  const records = reference.kind === "task" ? snapshot.tasks : reference.kind === "review" ? snapshot.reviews : reference.kind === "checkpoint" ? snapshot.checkpoints : snapshot.events;
  return records.some((record) => record.id === reference.id) ? "verified-local" : "missing";
}
function metadataCoherence(concept: ConceptRecord, receiptAt?: string): { status: "passed" | "unknown" | "inconsistent"; message: string } {
  const timestamps = concept.timestamps;
  if (!timestamps) return { status: "unknown", message: "Original timestamp metadata is unavailable for this legacy concept." };
  const dates = [timestamps.candidateCreatedAt, timestamps.approvedAt, timestamps.promotedAt, ...(timestamps.updatedAt ? [timestamps.updatedAt] : [])];
  const times = dates.map(Date.parse);
  const currentTime = Date.parse(concept.reviewedAt);
  const historyTimes = concept.history.map((entry) => Date.parse(entry.recordedAt));
  const inconsistent = times.some((time, index) => !Number.isFinite(time) || (index > 0 && time < times[index - 1]!))
    || !Number.isFinite(currentTime) || currentTime !== times[times.length - 1]
    || (receiptAt !== undefined && Date.parse(receiptAt) !== times[1])
    || (timestamps.updatedAt !== undefined && concept.history.length === 0)
    || historyTimes.some((time, index) => !Number.isFinite(time) || time < times[2]! || time > currentTime || (index > 0 && time < historyTimes[index - 1]!)
      || !Number.isFinite(Date.parse(concept.history[index]!.reviewedAt)) || Date.parse(concept.history[index]!.reviewedAt) > time
      || Date.parse(concept.history[index]!.reviewedAt) !== (index === 0 ? times[2] : historyTimes[index - 1]))
    || (concept.history.length > 0 && (timestamps.updatedAt === undefined || historyTimes[historyTimes.length - 1] !== currentTime))
    || (timestamps.supersededAt !== undefined && (!Number.isFinite(Date.parse(timestamps.supersededAt)) || Date.parse(timestamps.supersededAt) < times[2]! || Date.parse(timestamps.supersededAt) > currentTime));
  if (!inconsistent && concept.history.some((entry) => entry.revisionId === undefined)) return { status: "unknown", message: "Legacy history lacks revision identity metadata." };
  return inconsistent ? { status: "inconsistent", message: "Known timestamp/revision history metadata is inconsistent." } : { status: "passed", message: "Known timestamps and revision history are coherent; record age does not reduce quality." };
}
function round(value: number): number { return Math.round(value * 1e10) / 1e10; }
