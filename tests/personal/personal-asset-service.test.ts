import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:path", async (importOriginal) => {
  const path = await importOriginal<typeof import("node:path")>();

  return {
    ...path,
    join: (...paths: string[]) =>
      paths.every((pathSegment) => !isAbsolute(pathSegment))
        ? win32.join(...paths)
        : path.join(...paths),
  };
});

import {
  PersonalAssetService,
  PersonalRepository,
  resolvePaths,
  type ConceptRecord,
} from "../../src/index.js";
import { saveHostedDevice, writeHostedSession } from "../../src/cloud/hosted-session.js";

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "growth-memory-assets-"));
  createdPaths.push(root);
  const paths = resolvePaths(join(root, "project"), join(root, "personal"));
  const clock = () => new Date("2026-07-01T09:00:00.000Z");
  const repository = new PersonalRepository(paths, { clock });
  const service = new PersonalAssetService(repository, { clock });

  const modernConcept: ConceptRecord = {
    id: "review-modern-candidate-1",
    reviewId: "review-modern",
    ordinal: 1,
    principle: "Store provenance but show it lazily.",
    boundary: "Use when knowledge cards need trust without audit noise.",
    evidence: [{ kind: "task", id: "task-modern" }],
    status: "approved",
    confidence: 0.9,
    reviewedAt: "2026-07-01T08:00:00.000Z",
    taskId: "task-modern",
    timestamps: {
      candidateCreatedAt: "2026-07-01T07:50:00.000Z",
      approvedAt: "2026-07-01T07:55:00.000Z",
      promotedAt: "2026-07-01T08:00:00.000Z",
    },
    provenance: {
      candidateId: "review-modern-candidate-1",
      reviewId: "review-modern",
      taskId: "task-modern",
      sourceProject: "/work/personal-growth",
      sourceSummary: "Promoted from a provenance design review.",
      evidenceRefs: [
        { kind: "task", id: "task-modern" },
        { kind: "review", id: "review-modern" },
      ],
      decisionReceiptId: "receipt-modern",
    },
    history: [],
  };
  const legacyConcept: ConceptRecord = {
    id: "review-legacy-candidate-1",
    reviewId: "review-legacy",
    ordinal: 1,
    principle: "Classify project failures before fixing them.",
    boundary: "Use when a moved repository behaves incorrectly.",
    evidence: [{ kind: "commit", id: "commit-legacy" }],
    status: "approved",
    confidence: 0.8,
    reviewedAt: "2026-06-29T08:00:00.000Z",
    taskId: "task-legacy",
    history: [],
  };

  await repository.saveConcept(modernConcept);
  await repository.writeConceptMarkdown(modernConcept.id, "# Modern\n");
  await repository.appendDecisionReceipt({
    id: "receipt-modern",
    candidateId: modernConcept.id,
    candidateDigest: "a".repeat(64),
    actor: "human",
    at: "2026-07-01T07:55:00.000Z",
    decision: "approve",
    source: "unit-test",
  });
  await repository.saveConcept(legacyConcept);
  await repository.writeConceptMarkdown(legacyConcept.id, "# Legacy\n");

  return {
    legacyConcept,
    modernConcept,
    paths,
    repository,
    service,
  };
}

describe("personal/personal-asset-service", () => {
  it("keeps recursive repository and bundle walker paths logical after Windows joins", async () => {
    const { paths, repository, service } = await createFixture();
    const bundle = await mkdtemp(join(tmpdir(), "growth-memory-bundle-"));
    createdPaths.push(bundle);

    await repository.writePersonalFile("practice/nested/check-in.md", Buffer.from("# Check-in\n"));
    await mkdir(join(bundle, "unexpected", "nested"), { recursive: true });
    await writeFile(join(bundle, "manifest.json"), '{"version":1,"files":[]}\n', "utf8");
    await writeFile(join(bundle, "unexpected", "nested", "note.md"), "extra\n", "utf8");

    await expect(repository.listPersonalFiles()).resolves.toContain(
      "practice/nested/check-in.md",
    );
    await expect(service.verifyPersonalBundle(bundle)).resolves.toMatchObject({
      extra: [{ path: "unexpected/nested/note.md", reason: "extra" }],
    });
    expect(paths.personal.base).not.toContain("\\");
  });

  it("exports personal files with a manifest and SHA-256 digests", async () => {
    const { modernConcept, paths, service } = await createFixture();
    const outRoot = await mkdtemp(join(tmpdir(), "growth-memory-export-out-"));
    createdPaths.push(outRoot);

    const result = await service.exportPersonal(outRoot);

    expect(result.exportRoot).toContain("growth-memory-export-2026-07-01T09-00-00-000Z");
    expect(result.files).toBeGreaterThanOrEqual(5);
    expect(result.bytes).toBeGreaterThan(0);

    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
      fileCount: number;
      files: Array<{ bytes: number; path: string; sha256: string }>;
      personalRoot: string;
      schemaVersion: number;
      totalBytes: number;
      version: number;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.personalRoot).toBe(paths.personal.base);
    expect(manifest.fileCount).toBe(result.files);
    expect(manifest.totalBytes).toBe(result.bytes);
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: `concepts/${modernConcept.id}.json`,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          path: `concepts/${modernConcept.id}.md`,
          sha256: sha256("# Modern\n"),
        }),
        expect.objectContaining({
          path: `reviews/${modernConcept.reviewId}.decisions.jsonl`,
        }),
      ]),
    );
    expect(manifest.files.every((file) => !file.path.includes("\\"))).toBe(true);
    await expect(
      readFile(join(result.exportRoot, "concepts", `${modernConcept.id}.md`), "utf8"),
    ).resolves.toBe("# Modern\n");
  });

  it("rejects export output inside the personal knowledge root", async () => {
    const { paths, service } = await createFixture();

    await expect(
      service.exportPersonal(join(paths.personal.base, "exports")),
    ).rejects.toMatchObject({
      code: "EXPORT_INSIDE_PERSONAL_ROOT",
    });
  });

  it("excludes hosted credentials and devices from personal exports", async () => {
    const { paths, service } = await createFixture();
    const outRoot = await mkdtemp(join(tmpdir(), "growth-memory-export-out-"));
    createdPaths.push(outRoot);
    await writeHostedSession(paths.personal.base, {
      accountId: "acct_123",
      createdAt: "2026-07-10T00:00:00.000Z",
      deviceId: "device_123",
      endpoint: "local",
      token: "secret-token",
    });
    await saveHostedDevice(paths.personal.base, {
      createdAt: "2026-07-10T00:00:00.000Z",
      deviceId: "device_123",
      label: "Laptop",
      lastSeenAt: "2026-07-10T00:00:00.000Z",
      revoked: false,
    });

    const exported = await service.exportPersonal(outRoot);
    const manifest = JSON.parse(await readFile(exported.manifestPath, "utf8")) as {
      files: Array<{ path: string }>;
    };
    const exportedPaths = manifest.files.map((file) => file.path);

    expect(exportedPaths).not.toContain(".cloud/hosted/session.json");
    expect(exportedPaths).not.toContain(".cloud/hosted/devices/device_123.json");
    await expect(
      readFile(join(exported.exportRoot, ".cloud", "hosted", "session.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("verifies a clean personal export bundle", async () => {
    const { service } = await createFixture();
    const outRoot = await mkdtemp(join(tmpdir(), "growth-memory-export-out-"));
    createdPaths.push(outRoot);
    const exported = await service.exportPersonal(outRoot);

    await expect(service.verifyPersonalBundle(exported.exportRoot)).resolves.toMatchObject({
      valid: true,
      missing: [],
      changed: [],
      extra: [],
    });
  });

  it("reports changed, missing, and extra export bundle files", async () => {
    const { legacyConcept, modernConcept, service } = await createFixture();
    const outRoot = await mkdtemp(join(tmpdir(), "growth-memory-export-out-"));
    createdPaths.push(outRoot);
    const exported = await service.exportPersonal(outRoot);

    await writeFile(
      join(exported.exportRoot, "concepts", `${modernConcept.id}.md`),
      "# Changed\n",
      "utf8",
    );
    await rm(join(exported.exportRoot, "concepts", `${legacyConcept.id}.json`));
    await writeFile(join(exported.exportRoot, "extra.txt"), "extra\n", "utf8");

    await expect(service.verifyPersonalBundle(exported.exportRoot)).resolves.toMatchObject({
      valid: false,
      changed: [
        {
          path: `concepts/${modernConcept.id}.md`,
          reason: "changed",
        },
      ],
      missing: [
        {
          path: `concepts/${legacyConcept.id}.json`,
          reason: "missing",
        },
      ],
      extra: [
        {
          path: "extra.txt",
          reason: "extra",
        },
      ],
    });
  });

  it("previews personal import without writing data", async () => {
    const { modernConcept, service } = await createFixture();
    const outRoot = await mkdtemp(join(tmpdir(), "growth-memory-export-out-"));
    createdPaths.push(outRoot);
    const exported = await service.exportPersonal(outRoot);
    const destinationRoot = await mkdtemp(join(tmpdir(), "growth-memory-import-dest-"));
    createdPaths.push(destinationRoot);
    const destinationPaths = resolvePaths(
      join(destinationRoot, "project"),
      join(destinationRoot, "personal"),
    );
    const destinationRepository = new PersonalRepository(destinationPaths);
    const destinationService = new PersonalAssetService(destinationRepository, {
      clock: () => new Date("2026-07-01T10:00:00.000Z"),
    });

    await expect(
      destinationService.importPersonalBundleDryRun(exported.exportRoot),
    ).resolves.toMatchObject({
      mode: "dry-run",
      wouldAdd: expect.arrayContaining([
        `concepts/${modernConcept.id}.json`,
        `concepts/${modernConcept.id}.md`,
      ]),
      wouldSkip: [],
      unsupported: [],
    });
    await expect(destinationRepository.listPersonalFiles()).resolves.toEqual([]);
  });

  it("searches concepts across principle, boundary, provenance, and evidence ids", async () => {
    const { service } = await createFixture();

    await expect(service.searchKnowledge("audit noise", 10)).resolves.toMatchObject([
      {
        id: "review-modern-candidate-1",
        matchedFields: ["boundary"],
      },
    ]);
    await expect(service.searchKnowledge("provenance design", 10)).resolves.toMatchObject([
      {
        id: "review-modern-candidate-1",
        matchedFields: ["provenance.sourceSummary"],
      },
    ]);
    await expect(service.searchKnowledge("commit-legacy", 10)).resolves.toMatchObject([
      {
        id: "review-legacy-candidate-1",
        matchedFields: ["evidence", "provenance.evidenceRefs"],
      },
    ]);
  });

  it("builds a newest-first knowledge timeline with reviewedAt fallback", async () => {
    const { service } = await createFixture();

    await expect(service.knowledgeTimeline()).resolves.toMatchObject([
      {
        id: "review-modern-candidate-1",
        promotedAt: "2026-07-01T08:00:00.000Z",
      },
      {
        id: "review-legacy-candidate-1",
        promotedAt: "2026-06-29T08:00:00.000Z",
      },
    ]);
  });

  it("returns stored provenance and fallback provenance for older concepts", async () => {
    const { service } = await createFixture();

    await expect(
      service.knowledgeProvenance("review-modern-candidate-1"),
    ).resolves.toMatchObject({
      conceptId: "review-modern-candidate-1",
      provenance: {
        candidateId: "review-modern-candidate-1",
        reviewId: "review-modern",
        decisionReceiptId: "receipt-modern",
      },
    });
    await expect(
      service.knowledgeProvenance("review-legacy-candidate-1"),
    ).resolves.toMatchObject({
      conceptId: "review-legacy-candidate-1",
      provenance: {
        candidateId: "review-legacy-candidate-1",
        reviewId: "review-legacy",
        taskId: "task-legacy",
        evidenceRefs: [
          { kind: "task", id: "task-legacy" },
          { kind: "review", id: "review-legacy" },
          { kind: "commit", id: "commit-legacy" },
        ],
      },
    });
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
