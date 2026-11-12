import { createHash } from "node:crypto";

import type { EvidenceRef, KnowledgeCandidate } from "../domain/schema.js";

export function candidateDigest(candidate: KnowledgeCandidate): string {
  const identity = {
    id: candidate.id,
    reviewId: candidate.reviewId,
    ordinal: candidate.ordinal,
    principle: candidate.principle,
    boundary: candidate.boundary,
    evidence: candidate.evidence.map((item) => ({
      kind: item.kind,
      id: item.id,
      ...(item.path ? { path: item.path } : {}),
    })),
  };

  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function revisionDigest(
  conceptId: string,
  input: {
    principle?: string | undefined;
    boundary?: string | undefined;
    confidence?: number | undefined;
    status?: "approved" | "obsolete" | undefined;
    summary: string;
    evidence: EvidenceRef[];
  },
): string {
  const identity = {
    conceptId,
    ...(input.principle === undefined ? {} : { principle: input.principle }),
    ...(input.boundary === undefined ? {} : { boundary: input.boundary }),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.status === undefined ? {} : { status: input.status }),
    summary: input.summary,
    evidence: input.evidence.map((item) => ({
      kind: item.kind,
      id: item.id,
      ...(item.path ? { path: item.path } : {}),
    })),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
