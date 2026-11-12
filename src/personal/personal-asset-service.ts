import { assertSafePath } from "../storage/snapshot-files.js";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { DomainError } from "../domain/errors.js";
import { isPersonalKnowledgeAsset, validatePersonalAsset } from "./personal-asset-paths.js";
import type {
  ConceptRecord,
  EvidenceRef,
  KnowledgeProvenance,
} from "../domain/schema.js";
import { PersonalRepository } from "../storage/personal-repository.js";
import { safeChildPath, toLogicalPath } from "../storage/paths.js";

export type PersonalExportFile = {
  path: string;
  bytes: number;
  sha256: string;
};

export type PersonalExportManifest = {
  version: 1;
  schemaVersion: 1;
  exportedAt: string;
  personalRoot: string;
  fileCount: number;
  totalBytes: number;
  files: PersonalExportFile[];
};

export type PersonalExportResult = {
  exportRoot: string;
  manifestPath: string;
  files: number;
  bytes: number;
};

export type PersonalVerifyFileIssue = {
  path: string;
  expected?: string;
  actual?: string;
  reason: "missing" | "changed" | "extra";
};

export type PersonalVerifyResult = {
  bundle: string;
  manifestPath: string;
  valid: boolean;
  checkedFiles: number;
  missing: PersonalVerifyFileIssue[];
  changed: PersonalVerifyFileIssue[];
  extra: PersonalVerifyFileIssue[];
};

export type PersonalImportDryRunResult = {
  bundle: string;
  mode: "dry-run";
  wouldAdd: string[];
  wouldSkip: string[];
  unsupported: string[];
};

export type KnowledgeSearchResult = {
  id: string;
  principle: string;
  boundary: string;
  confidence: number;
  promotedAt: string;
  matchedFields: string[];
  score: number;
};

export type KnowledgeTimelineItem = {
  id: string;
  principle: string;
  confidence: number;
  promotedAt: string;
  status: ConceptRecord["status"];
};

export type KnowledgeDigestTheme = {
  count: number;
  label: string;
};

export type KnowledgeDigestItem = {
  id: string;
  principle: string;
  promotedAt: string;
};

export type KnowledgeDigest = {
  total: number;
  recent: KnowledgeDigestItem[];
  themes: KnowledgeDigestTheme[];
  stale: KnowledgeDigestItem[];
};

export type KnowledgeProvenanceView = {
  conceptId: string;
  provenance: KnowledgeProvenance;
  evidence: EvidenceRef[];
};

export class PersonalAssetService {
  constructor(
    private readonly repository: PersonalRepository,
    private readonly options: {
      clock: () => Date;
    },
  ) {}

  async exportPersonal(outDir: string): Promise<PersonalExportResult> {
    const resolvedOutDir = resolve(outDir);
    const personalRoot = resolve(this.repository.paths.personal.base);
    const outRelativeToPersonal = relative(personalRoot, resolvedOutDir);
    if (
      outRelativeToPersonal.length === 0 ||
      (!outRelativeToPersonal.startsWith(`..${sep}`) &&
        outRelativeToPersonal !== ".." &&
        !outRelativeToPersonal.startsWith(sep))
    ) {
      throw new DomainError(
        "EXPORT_INSIDE_PERSONAL_ROOT",
        "Personal export output must be outside the personal knowledge root",
        { outDir: resolvedOutDir, personalRoot },
      );
    }
    const exportRoot = safeChildPath(
      resolvedOutDir,
      `growth-memory-export-${this.timestampSlug()}`,
    );
    await mkdir(exportRoot, { recursive: true });

    const files = (await this.repository.listPersonalFiles()).filter(isPersonalKnowledgeAsset);
    const manifestFiles: PersonalExportFile[] = [];

    for (const relativePath of files) {
      const content = await this.repository.readPersonalFile(relativePath);
      const targetPath = safeChildPath(exportRoot, relativePath);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content);
      manifestFiles.push({
        path: relativePath,
        bytes: content.byteLength,
        sha256: sha256(content),
      });
    }

    const manifest: PersonalExportManifest = {
      version: 1,
      schemaVersion: 1,
      exportedAt: this.now(),
      personalRoot: this.repository.paths.personal.base,
      fileCount: manifestFiles.length,
      totalBytes: manifestFiles.reduce((sum, file) => sum + file.bytes, 0),
      files: manifestFiles,
    };
    const manifestPath = safeChildPath(exportRoot, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    return {
      exportRoot,
      manifestPath,
      files: manifest.fileCount,
      bytes: manifest.totalBytes,
    };
  }

  async verifyPersonalBundle(bundleDir: string): Promise<PersonalVerifyResult> {
    const bundle = resolve(bundleDir);
    const manifestPath = safeChildPath(bundle, "manifest.json");
    const manifest = parseManifest(await readFile(manifestPath, "utf8"));
    const manifestPaths = new Set(manifest.files.map((file) => file.path));
    const missing: PersonalVerifyFileIssue[] = [];
    const changed: PersonalVerifyFileIssue[] = [];

    for (const file of manifest.files) {
      if (!isPersonalKnowledgeAsset(file.path)) throw new DomainError("INVALID_EXPORT_MANIFEST", "Bundle contains a nonportable asset", { path: file.path });
      try {
        await assertSafePath(safeChildPath(bundle, file.path), "file", bundle);
        const content = await readFile(safeChildPath(bundle, file.path));
        validatePersonalAsset(file.path, content);
        const actual = sha256(content);
        if (actual !== file.sha256 || content.byteLength !== file.bytes) {
          changed.push({
            path: file.path,
            expected: file.sha256,
            actual,
            reason: "changed",
          });
        }
      } catch (error) {
        if (isFileNotFoundError(error)) {
          missing.push({
            path: file.path,
            expected: file.sha256,
            reason: "missing",
          });
          continue;
        }
        throw error;
      }
    }

    const bundleFiles = await listFilesRelative(bundle, "");
    const extra = bundleFiles
      .filter((path) => path !== "manifest.json" && !manifestPaths.has(path))
      .map((path) => ({
        path,
        reason: "extra" as const,
      }));

    return {
      bundle,
      manifestPath,
      valid: missing.length === 0 && changed.length === 0 && extra.length === 0,
      checkedFiles: manifest.files.length,
      missing,
      changed,
      extra,
    };
  }

  async importPersonalBundleDryRun(
    bundleDir: string,
  ): Promise<PersonalImportDryRunResult> {
    const bundle = resolve(bundleDir);
    const manifest = parseManifest(
      await readFile(safeChildPath(bundle, "manifest.json"), "utf8"),
    );
    const existing = new Set(await this.repository.listPersonalFiles());

    const wouldAdd: string[] = [];
    const wouldSkip: string[] = [];
    const unsupported: string[] = [];

    for (const file of manifest.files) {
      safeChildPath(bundle, file.path);
      const supported = isPersonalKnowledgeAsset(file.path);
      if (!supported) {
        unsupported.push(file.path);
        continue;
      }
      await assertSafePath(safeChildPath(bundle, file.path), "file", bundle);
      validatePersonalAsset(file.path, await readFile(safeChildPath(bundle, file.path)));
      if (existing.has(file.path)) {
        wouldSkip.push(file.path);
      } else {
        wouldAdd.push(file.path);
      }
    }

    return {
      bundle,
      mode: "dry-run",
      wouldAdd: wouldAdd.sort(),
      wouldSkip: wouldSkip.sort(),
      unsupported: unsupported.sort(),
    };
  }

  async searchKnowledge(
    query: string,
    limit: number,
  ): Promise<KnowledgeSearchResult[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return [];
    }

    const concepts = await this.repository.listConcepts();
    return concepts
      .map((concept) => this.scoreConcept(concept, normalizedQuery))
      .filter((result): result is KnowledgeSearchResult => result !== undefined)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.promotedAt.localeCompare(left.promotedAt);
      })
      .slice(0, limit);
  }

  async knowledgeTimeline(): Promise<KnowledgeTimelineItem[]> {
    const concepts = await this.repository.listConcepts();
    return concepts
      .map((concept) => ({
        id: concept.id,
        principle: concept.principle,
        confidence: concept.confidence,
        promotedAt: promotedAt(concept),
        status: concept.status,
      }))
      .sort((left, right) => right.promotedAt.localeCompare(left.promotedAt));
  }

  async knowledgeDigest(): Promise<KnowledgeDigest> {
    const concepts = await this.repository.listConcepts();
    const timeline = concepts
      .map((concept) => ({
        id: concept.id,
        principle: concept.principle,
        promotedAt: promotedAt(concept),
      }))
      .sort((left, right) => right.promotedAt.localeCompare(left.promotedAt));

    return {
      total: concepts.length,
      recent: timeline.slice(0, 5),
      themes: topThemes(concepts),
      stale: timeline.slice(-3).reverse(),
    };
  }

  async knowledgeProvenance(conceptId: string): Promise<KnowledgeProvenanceView> {
    const concept = await this.repository.readConcept(conceptId);
    return {
      conceptId,
      provenance: provenanceFor(concept),
      evidence: concept.evidence,
    };
  }

  private scoreConcept(
    concept: ConceptRecord,
    normalizedQuery: string,
  ): KnowledgeSearchResult | undefined {
    const fields = [
      { name: "principle", value: concept.principle, weight: 5 },
      { name: "boundary", value: concept.boundary, weight: 3 },
      {
        name: "provenance.sourceSummary",
        value: concept.provenance?.sourceSummary ?? "",
        weight: 2,
      },
      {
        name: "evidence",
        value: concept.evidence.map((item) => `${item.kind}:${item.id}`).join(" "),
        weight: 1,
      },
      {
        name: "provenance.evidenceRefs",
        value: provenanceFor(concept)
          .evidenceRefs.map((item) => `${item.kind}:${item.id}`)
          .join(" "),
        weight: 1,
      },
    ];
    const matches = fields.filter((field) =>
      field.value.toLowerCase().includes(normalizedQuery),
    );

    if (matches.length === 0) {
      return undefined;
    }

    return {
      id: concept.id,
      principle: concept.principle,
      boundary: concept.boundary,
      confidence: concept.confidence,
      promotedAt: promotedAt(concept),
      matchedFields: matches.map((field) => field.name),
      score: matches.reduce((sum, field) => sum + field.weight, 0),
    };
  }

  private timestampSlug(): string {
    return this.now().replace(/[:.]/g, "-");
  }

  private now(): string {
    return this.options.clock().toISOString();
  }
}

export function promotedAt(concept: ConceptRecord): string {
  return concept.timestamps?.promotedAt ?? concept.reviewedAt;
}

export function provenanceFor(concept: ConceptRecord): KnowledgeProvenance {
  return (
    concept.provenance ?? {
      candidateId: concept.id,
      reviewId: concept.reviewId,
      taskId: concept.taskId,
      sourceSummary: `Promoted from task ${concept.taskId} and review ${concept.reviewId}.`,
      evidenceRefs: uniqueEvidenceRefs([
        { kind: "task", id: concept.taskId },
        { kind: "review", id: concept.reviewId },
        ...concept.evidence,
      ]),
    }
  );
}

function uniqueEvidenceRefs(evidence: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.kind}:${item.id}:${item.path ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function parseManifest(content: string): PersonalExportManifest {
  const parsed = JSON.parse(content) as PersonalExportManifest;
  if (
    parsed.version !== 1 ||
    (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) ||
    !Array.isArray(parsed.files)
  ) {
    throw new DomainError("INVALID_EXPORT_MANIFEST", "Unsupported export manifest", {
      version: parsed.version,
      schemaVersion: parsed.schemaVersion,
    });
  }
  return {
    ...parsed,
    schemaVersion: parsed.schemaVersion ?? 1,
  };
}

async function listFilesRelative(root: string, prefix: string): Promise<string[]> {
  let entries: Dirent[];

  try {
    entries = await readdir(prefix ? safeChildPath(root, prefix) : root, {
      withFileTypes: true,
    });
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const files = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("._"))
      .map(async (entry) => {
        const relativePath = toLogicalPath(prefix ? join(prefix, entry.name) : entry.name);
        if (entry.isDirectory()) {
          return listFilesRelative(root, relativePath);
        }
        if (entry.isFile()) {
          return [relativePath];
        }
        return [];
      }),
  );

  return files.flat().sort();
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function topThemes(concepts: ConceptRecord[]): KnowledgeDigestTheme[] {
  const counts = new Map<string, number>();
  const minimumCount = concepts.length < 10 ? 3 : 2;
  for (const concept of concepts) {
    const text = `${concept.principle} ${concept.boundary}`;
    for (const token of themeTokens(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= minimumCount)
    .sort(([leftLabel, leftCount], [rightLabel, rightCount]) => {
      if (rightCount !== leftCount) {
        return rightCount - leftCount;
      }
      return leftLabel.localeCompare(rightLabel);
    })
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));
}

function themeTokens(text: string): string[] {
  const english = text
    .toLowerCase()
    .match(/[a-z][a-z-]{3,}/g) ?? [];
  const chinese = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const stopWords = new Set([
    "after",
    "also",
    "anything",
    "before",
    "being",
    "completed",
    "concept",
    "does",
    "from",
    "have",
    "human",
    "into",
    "only",
    "over",
    "promoted",
    "should",
    "than",
    "that",
    "their",
    "them",
    "then",
    "there",
    "this",
    "when",
    "where",
    "with",
    "without",
    "system",
    "systems",
    "knowledge",
    "personal",
    "只有",
    "应该",
    "适用于",
    "不适用于",
  ]);

  return [...new Set([...english, ...chinese])]
    .filter((token) => !stopWords.has(token))
    .slice(0, 20);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
