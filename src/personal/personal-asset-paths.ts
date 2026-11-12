import { conflictOriginalPath, conflictBasePath, bindsPersonalRecord } from "./conflict-archives.js";
import { restrictedIdSchema, capabilityStateSchema, conceptRecordSchema, personalReviewStateSchema } from "../domain/schema.js";
import { growthObservationSchema, capturedReviewSchema } from "../growth/schema.js";
import { invalidStoredData } from "../storage/snapshot-files.js";
const PERSONAL_KNOWLEDGE_PREFIXES = ["concepts/", "reviews/", "practice/"];
const PERSONAL_KNOWLEDGE_FILES = new Set(["capabilities.json", "index.md"]);

export function isPersonalKnowledgeAsset(path: string): boolean {
  return growthAssetKind(path) !== undefined || PERSONAL_KNOWLEDGE_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    PERSONAL_KNOWLEDGE_FILES.has(path) || PERSONAL_KNOWLEDGE_FILES.has(conflictBasePath(path));
}

/** New durable families are exact typed records, never a generic growth prefix. */
export function growthAssetKind(path: string): 'observations' | 'reviews' | undefined {
  const match = /^growth\/(observations|reviews)\/([^/]+)\.json$/.exec(path);
  if (!match) return undefined;
  const original = conflictOriginalPath(path);
  const originalId = conflictBasePath(path).split('/').at(-1)?.slice(0,-5);
  return restrictedIdSchema.safeParse(match[2]).success || (originalId !== undefined && restrictedIdSchema.safeParse(originalId).success) ? match[1] as 'observations' | 'reviews' : undefined;
}

export function validatePersonalAsset(path: string, content: Buffer): void {
  const kind = growthAssetKind(path);
const original = conflictOriginalPath(path);
  const capability = conflictBasePath(path) === 'capabilities.json';
  const legacyConcept = /^concepts\/[^/]+\.json$/.test(path) && original !== undefined;
  const legacyReview = /^reviews\/[^/]+\.json$/.test(path) && original !== undefined;
  if (!kind && !capability && !legacyConcept && !legacyReview) return;
  try {
    const value: unknown = JSON.parse(content.toString('utf8'));
    if (kind) {
      const record = (kind === 'observations' ? growthObservationSchema : capturedReviewSchema).parse(value);
      if (!bindsPersonalRecord(path, record.id)) throw new Error('Record ID differs from filename');
    } else if (legacyConcept || legacyReview) {
      const record = legacyConcept ? conceptRecordSchema.parse(value) : personalReviewStateSchema.parse(value);
      const id = 'id' in record ? record.id : record.reviewId;
      if (!bindsPersonalRecord(path, id)) throw new Error('Record ID differs from filename');
    } else {
      capabilityStateSchema.parse(value);
    }
  } catch (cause) { throw invalidStoredData(path, cause); }
}
