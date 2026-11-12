import {portableObservation,portableReview,portableCapabilities,portableConcept} from '../fixtures/growth-assets.js';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  CloudService,
  PersonalRepository,
  resolvePaths,
  type ConceptRecord,
} from "../../src/index.js";
import { resolveCloudRemote } from "../../src/cloud/cloud-remote.js";

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "growth-memory-cloud-"));
  createdPaths.push(root);
  const paths = resolvePaths(join(root, "project"), join(root, "personal"));
  const clock = () => new Date("2026-07-01T10:00:00.000Z");
  const repository = new PersonalRepository(paths, { clock });
  const service = new CloudService(repository, { clock });
  const concept: ConceptRecord = {
    id: "review-cloud-candidate-1",
    reviewId: "review-cloud",
    ordinal: 1,
    principle: "Back up promoted knowledge as encrypted objects.",
    boundary: "Use when validating cloud sync semantics without hosted storage.",
    evidence: [{ kind: "task", id: "task-cloud" }],
    status: "approved",
    confidence: 0.8,
    reviewedAt: "2026-07-01T09:00:00.000Z",
    taskId: "task-cloud",
    history: [],
  };
  await repository.saveConcept(concept);
  await repository.writeConceptMarkdown(concept.id, "# Cloud\n");

  return {
    concept,
    repository,
    root,
    remoteDir: join(root, "remote"),
    service,
  };
}

async function createDivergedConflict() {
  const fixture = await createFixture();
  await fixture.service.backup({
    dryRun: false,
    passphrase: "secret",
    remoteTarget: fixture.remoteDir,
  });

  const remoteRoot = await mkdtemp(join(tmpdir(), "growth-memory-conflict-other-"));
  createdPaths.push(remoteRoot);
  const otherPaths = resolvePaths(join(remoteRoot, "project"), join(remoteRoot, "personal"));
  const otherRepository = new PersonalRepository(otherPaths, {
    clock: () => new Date("2026-07-03T00:00:00.000Z"),
  });
  const otherService = new CloudService(otherRepository, {
    clock: () => new Date("2026-07-03T00:00:00.000Z"),
  });
  await mkdir(join(otherPaths.personal.base, ".cloud"), { recursive: true });
  await writeFile(
    join(otherPaths.personal.base, ".cloud", "state.json"),
    await readFile(join(pathsForRoot(fixture.root), ".cloud", "state.json"), "utf8"),
    "utf8",
  );
  await otherRepository.writePersonalFile(
    `concepts/${fixture.concept.id}.md`,
    Buffer.from("# Remote side change\n"),
  );
  await otherService.backup({
    dryRun: false,
    passphrase: "secret",
    remoteTarget: fixture.remoteDir,
  });
  await fixture.repository.writeConceptMarkdown(
    fixture.concept.id,
    "# Local side change\n",
  );

  return {
    ...fixture,
    conflictPath: `concepts/${fixture.concept.id}.md`,
  };
}

describe("cloud/cloud-service", () => {
  it("checks a filesystem remote without creating a manifest or objects", async () => {
    const { remoteDir, service } = await createFixture();
    const remote = resolveCloudRemote({ target: remoteDir });

    await expect(service.checkRemote(remote.displayRoot)).resolves.toEqual({
      remote: remoteDir,
      kind: "filesystem",
      configured: true,
      safeExistingManifestWrite: true,
      capabilities: {
        atomicManifestWrite: true,
        conditionalManifestWrite: true,
        objectDelete: true,
        objectListing: true,
        objectVersioning: false,
      },
      warnings: [],
    });
    await expect(readFile(join(remoteDir, "manifest.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports S3 connector support for conditional manifest updates", async () => {
    const { service } = await createFixture();
    const previous = process.env;
    process.env = {
      ...previous,
      GMEM_S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
      GMEM_S3_ACCESS_KEY_ID: "access",
      GMEM_S3_SECRET_ACCESS_KEY: "secret",
    };
    try {
      await expect(service.checkRemote("s3://bucket/growth-memory")).resolves.toMatchObject({
        kind: "s3",
        configured: true,
        safeExistingManifestWrite: true,
        capabilities: { conditionalManifestWrite: true },
        warnings: [],
      });
    } finally {
      process.env = previous;
    }
  });

  it("previews encrypted backup without writing remote files", async () => {
    const { concept, remoteDir, service } = await createFixture();

    const result = await service.backup({
      dryRun: true,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });

    expect(result).toMatchObject({
      dryRun: true,
      uploaded: [],
      wouldUpload: expect.arrayContaining([
        `concepts/${concept.id}.json`,
        `concepts/${concept.id}.md`,
      ]),
    });
    expect(result.wouldUpload.every((path) => !path.includes("\\"))).toBe(true);
    await expect(readFile(join(remoteDir, "manifest.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes encrypted objects and a manifest on backup", async () => {
    const { concept, remoteDir, root, service } = await createFixture();

    const result = await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });

    expect(result.uploaded).toEqual(
      expect.arrayContaining([
        `concepts/${concept.id}.json`,
        `concepts/${concept.id}.md`,
      ]),
    );
    const manifestRaw = await readFile(join(remoteDir, "manifest.json"), "utf8");
    expect(manifestRaw).not.toContain("concepts/");
    expect(manifestRaw).not.toContain("reviews/");
    expect(manifestRaw).not.toContain("practice/");
    const manifest = JSON.parse(manifestRaw) as {
      objects: Array<{ objectId: string; objectKey: string; sha256?: string; path?: string }>;
      schemaVersion: number;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.objects.every((object) => object.path === undefined)).toBe(true);
    expect(manifest.objects.every((object) => object.sha256 === undefined)).toBe(true);
    const syncStateBefore = JSON.parse(
      await readFile(join(pathsForRoot(root), ".cloud", "state.json"), "utf8"),
    ) as {
      objects: Array<{
        objectId: string;
        path: string;
        remoteObjectKey: string;
        remoteVersion: number;
        sha256: string;
      }>;
    };
    const markdownState = syncStateBefore.objects.find((object) =>
      object.path.endsWith(`${concept.id}.md`),
    );
    const markdown = manifest.objects.find((object) =>
      object.objectId === markdownState?.objectId,
    );
    expect(markdownState?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const encrypted = await readFile(join(remoteDir, "objects", markdown?.objectKey ?? ""));
    expect(encrypted.toString("utf8")).not.toContain("# Cloud");
    const syncState = JSON.parse(
      await readFile(join(pathsForRoot(root), ".cloud", "state.json"), "utf8"),
    ) as {
      objects: Array<{
        objectId: string;
        path: string;
        remoteObjectKey: string;
        remoteVersion: number;
        sha256: string;
      }>;
      remote: string;
      schemaVersion: number;
    };
    expect(syncState).toMatchObject({
      remote: remoteDir,
      schemaVersion: 1,
      objects: expect.arrayContaining([
        expect.objectContaining({
          objectId: markdown?.objectId,
          path: `concepts/${concept.id}.md`,
          remoteObjectKey: markdown?.objectKey,
          remoteVersion: 1,
          sha256: markdownState?.sha256,
        }),
      ]),
    });
  });

  it("reports cloud status for configured and empty remotes", async () => {
    const { remoteDir, service } = await createFixture();

    await expect(service.status(remoteDir)).resolves.toMatchObject({
      capabilities: {
        atomicManifestWrite: true,
        conditionalManifestWrite: true,
        objectDelete: true,
        objectListing: true,
        objectVersioning: false,
      },
      configured: false,
      objects: 0,
    });

    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });

    await expect(service.status(remoteDir)).resolves.toMatchObject({
      capabilities: {
        atomicManifestWrite: true,
        conditionalManifestWrite: true,
        objectDelete: true,
        objectListing: true,
        objectVersioning: false,
      },
      configured: true,
      createdAt: "2026-07-01T10:00:00.000Z",
      objects: expect.any(Number),
    });
  });

  it("accepts file URL remote targets through the shared remote resolver", async () => {
    const { concept, remoteDir, service } = await createFixture();
    const remoteTarget = new URL(`file://${remoteDir}`).toString();

    await expect(
      service.backup({
        dryRun: false,
        passphrase: "secret",
        remoteTarget,
      }),
    ).resolves.toMatchObject({
      uploaded: expect.arrayContaining([`concepts/${concept.id}.json`]),
    });

    await expect(service.status(remoteTarget)).resolves.toMatchObject({
      configured: true,
      objects: expect.any(Number),
    });
  });

  it("reports orphan encrypted objects during cleanup dry-run", async () => {
    const { remoteDir, service } = await createFixture();
    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });
    await writeFile(join(remoteDir, "objects", "orphan.bin"), "orphan");

    await expect(service.cleanupDryRun({ remoteTarget: remoteDir })).resolves.toMatchObject({
      deletedObjects: [],
      dryRun: true,
      orphanObjects: ["orphan.bin"],
      retainedConflictCopies: [],
      tombstones: [],
      wouldDeleteObjects: ["orphan.bin"],
    });
  });

  it("deletes filesystem orphan encrypted objects during cleanup apply", async () => {
    const { remoteDir, service } = await createFixture();
    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });
    await writeFile(join(remoteDir, "objects", "orphan.bin"), "orphan");

    await expect(service.cleanupApply({ remoteTarget: remoteDir })).resolves.toMatchObject({
      deletedObjects: ["orphan.bin"],
      dryRun: false,
      orphanObjects: ["orphan.bin"],
      wouldDeleteObjects: ["orphan.bin"],
    });
    await expect(readFile(join(remoteDir, "objects", "orphan.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("plans a cloud tombstone when local deleted and remote still matches base", async () => {
    const { concept, remoteDir, repository, service } = await createFixture();
    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });
    await rm(join(repository.paths.personal.concepts, `${concept.id}.md`));

    await expect(
      service.syncDryRun({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      conflicts: [],
      wouldDelete: [`concepts/${concept.id}.md`],
    });
  });

  it("reports a tombstone conflict when local deleted but remote changed", async () => {
    const { concept, remoteDir, repository, root, service } = await createFixture();
    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });
    const otherRoot = await mkdtemp(join(tmpdir(), "growth-memory-tombstone-other-"));
    createdPaths.push(otherRoot);
    const otherPaths = resolvePaths(join(otherRoot, "project"), join(otherRoot, "personal"));
    const otherRepository = new PersonalRepository(otherPaths);
    const otherService = new CloudService(otherRepository, {
      clock: () => new Date("2026-07-03T00:00:00.000Z"),
    });
    await mkdir(join(otherPaths.personal.base, ".cloud"), { recursive: true });
    await writeFile(
      join(otherPaths.personal.base, ".cloud", "state.json"),
      await readFile(join(pathsForRoot(root), ".cloud", "state.json"), "utf8"),
      "utf8",
    );
    await otherRepository.writePersonalFile(
      `concepts/${concept.id}.md`,
      Buffer.from("# Remote changed before delete\n"),
    );
    await otherService.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });
    await rm(join(repository.paths.personal.concepts, `${concept.id}.md`));

    await expect(
      service.syncDryRun({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      conflicts: [`concepts/${concept.id}.md`],
      wouldDelete: [],
    });
  });

  it("applies cloud tombstones by removing deleted paths from the remote manifest", async () => {
    const { concept, remoteDir, repository, service } = await createFixture();
    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });
    const deletedPath = `concepts/${concept.id}.md`;
    await rm(join(repository.paths.personal.concepts, `${concept.id}.md`));

    await expect(
      service.syncApply({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      applied: true,
      conflicts: [],
      deleted: [deletedPath],
      wouldDelete: [deletedPath],
    });
    await expect(
      service.syncDryRun({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      conflicts: [],
      wouldDelete: [],
      wouldDownload: [],
    });
    const cleanup = await service.cleanupDryRun({ remoteTarget: remoteDir });
    expect(cleanup.orphanObjects.length).toBeGreaterThan(0);
    expect(cleanup.tombstones).toContain(deletedPath);
  });

  it("does not resurrect a remote deletion from an unchanged second device", async () => {
    const { concept, remoteDir, root, repository, service } = await createFixture();
    await service.backup({ dryRun: false, passphrase: "secret", remoteTarget: remoteDir });
    const otherPaths = resolvePaths(join(root, "other-project"), join(root, "other-personal"));
    const otherRepository = new PersonalRepository(otherPaths);
    const otherService = new CloudService(otherRepository, { clock: () => new Date("2026-07-02T00:00:00.000Z") });
    await otherRepository.writePersonalFile(
      `concepts/${concept.id}.json`,
      await repository.readPersonalFile(`concepts/${concept.id}.json`),
    );
    await otherRepository.writePersonalFile(`concepts/${concept.id}.md`, Buffer.from("# Cloud\n"));
    await mkdir(join(otherPaths.personal.base, ".cloud"), { recursive: true });
    await writeFile(join(otherPaths.personal.base, ".cloud", "state.json"), await readFile(join(pathsForRoot(root), ".cloud", "state.json"), "utf8"));
    await repository.removePersonalFile(`concepts/${concept.id}.md`);
    await service.syncApply({ passphrase: "secret", remoteTarget: remoteDir });

    await expect(otherService.syncApply({ passphrase: "secret", remoteTarget: remoteDir })).resolves.toMatchObject({
      conflicts: [],
      deleted: expect.arrayContaining([`concepts/${concept.id}.md`]),
    });
    await expect(otherRepository.readPersonalFile(`concepts/${concept.id}.md`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("previews restore add and skip without writing local files", async () => {
    const { concept, remoteDir, root, service } = await createFixture();
    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });
    const emptyPaths = resolvePaths(join(root, "restore-project"), join(root, "restore-personal"));
    const emptyRepository = new PersonalRepository(emptyPaths);
    const emptyService = new CloudService(emptyRepository, {
      clock: () => new Date("2026-07-01T11:00:00.000Z"),
    });

    await expect(
      emptyService.restoreDryRun({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      wouldAdd: expect.arrayContaining([
        `concepts/${concept.id}.json`,
        `concepts/${concept.id}.md`,
      ]),
      wouldSkip: [],
      conflicts: [],
    });
    await expect(emptyRepository.listPersonalFiles()).resolves.toEqual([]);

    await expect(
      service.restoreDryRun({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      wouldAdd: [],
      wouldSkip: expect.arrayContaining([
        `concepts/${concept.id}.json`,
        `concepts/${concept.id}.md`,
      ]),
      conflicts: [],
    });
  });

  it("reports restore and sync conflicts without overwriting local files", async () => {
    const { concept, remoteDir, repository, service } = await createFixture();
    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });
    await repository.writeConceptMarkdown(concept.id, "# Local change\n");

    await expect(
      service.restoreDryRun({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      conflicts: [`concepts/${concept.id}.md`],
    });
    await expect(
      service.syncDryRun({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      conflicts: [],
      wouldSkip: expect.arrayContaining([`concepts/${concept.id}.json`]),
      wouldUpload: [`concepts/${concept.id}.md`],
    });
    await expect(
      readFile(join(remoteDir, "manifest.json"), "utf8"),
    ).resolves.not.toContain(`concepts/${concept.id}.md`);
  });

  it("reports local files that would upload during sync dry-run", async () => {
    const { concept, remoteDir, repository, service } = await createFixture();
    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });
    await repository.writePractice("review-extra", "# Extra practice\n");

    await expect(
      service.syncDryRun({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      wouldUpload: ["practice/review-extra.md"],
      wouldDownload: [],
      wouldSkip: expect.arrayContaining([
        `concepts/${concept.id}.json`,
        `concepts/${concept.id}.md`,
      ]),
      conflicts: [],
    });
  });

  it("applies sync downloads for remote-only personal knowledge files", async () => {
    const { concept, remoteDir, root, service } = await createFixture();
    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });

    const restorePaths = resolvePaths(join(root, "sync-project"), join(root, "sync-personal"));
    const restoreRepository = new PersonalRepository(restorePaths, {
      clock: () => new Date("2026-07-03T00:00:00.000Z"),
    });
    const restoreService = new CloudService(restoreRepository, {
      clock: () => new Date("2026-07-03T00:00:00.000Z"),
    });

    await expect(
      restoreService.syncApply({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      applied: true,
      conflicts: [],
      downloaded: expect.arrayContaining([
        `concepts/${concept.id}.json`,
        `concepts/${concept.id}.md`,
      ]),
      uploaded: [],
    });
    await expect(
      readFile(join(restorePaths.personal.concepts, `${concept.id}.md`), "utf8"),
    ).resolves.toBe("# Cloud\n");
  });

  it("applies sync uploads for local-only personal knowledge files", async () => {
    const { remoteDir, repository, service } = await createFixture();
    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });
    await repository.writePractice("review-local-only", "# Local only\n");

    await expect(
      service.syncApply({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      applied: true,
      conflicts: [],
      downloaded: [],
      uploaded: ["practice/review-local-only.md"],
    });
    await expect(
      service.syncDryRun({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      conflicts: [],
      wouldUpload: [],
      wouldDownload: [],
      wouldSkip: expect.arrayContaining(["practice/review-local-only.md"]),
    });
  });

  it("refuses sync apply when local and remote both diverged from base", async () => {
    const { concept, remoteDir, repository, root, service } = await createFixture();
    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });

    const remoteRoot = await mkdtemp(join(tmpdir(), "growth-memory-sync-conflict-"));
    createdPaths.push(remoteRoot);
    const otherPaths = resolvePaths(join(remoteRoot, "project"), join(remoteRoot, "personal"));
    const otherRepository = new PersonalRepository(otherPaths, {
      clock: () => new Date("2026-07-03T00:00:00.000Z"),
    });
    const otherService = new CloudService(otherRepository, {
      clock: () => new Date("2026-07-03T00:00:00.000Z"),
    });
    await mkdir(join(otherPaths.personal.base, ".cloud"), { recursive: true });
    await writeFile(
      join(otherPaths.personal.base, ".cloud", "state.json"),
      await readFile(join(pathsForRoot(root), ".cloud", "state.json"), "utf8"),
      "utf8",
    );
    await otherRepository.writePersonalFile(
      `concepts/${concept.id}.md`,
      Buffer.from("# Remote side change\n"),
    );
    await otherService.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });
    await repository.writeConceptMarkdown(concept.id, "# Local side change\n");

    await expect(
      service.syncApply({ passphrase: "secret", remoteTarget: remoteDir }),
    ).rejects.toMatchObject({
      code: "CLOUD_SYNC_CONFLICT",
      details: { conflicts: [`concepts/${concept.id}.md`] },
    });
    await expect(
      readFile(join(repository.paths.personal.concepts, `${concept.id}.md`), "utf8"),
    ).resolves.toBe("# Local side change\n");
  });

  it("lists cloud conflicts from the sync plan", async () => {
    const { conflictPath, remoteDir, service } = await createDivergedConflict();

    await expect(
      service.listConflicts({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      remote: remoteDir,
      conflicts: [conflictPath],
    });
  });

  it("shows cloud conflict metadata and previews", async () => {
    const { conflictPath, remoteDir, service } = await createDivergedConflict();

    await expect(
      service.showConflict({
        passphrase: "secret",
        remoteTarget: remoteDir,
        path: conflictPath,
      }),
    ).resolves.toMatchObject({
      remote: remoteDir,
      path: conflictPath,
      local: {
        bytes: "# Local side change\n".length,
        preview: "# Local side change",
      },
      remoteObject: {
        bytes: "# Remote side change\n".length,
        preview: "# Remote side change",
      },
    });
  });

  it("rejects show for a non-conflicted cloud path", async () => {
    const { concept, remoteDir, service } = await createFixture();
    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });

    await expect(
      service.showConflict({
        passphrase: "secret",
        remoteTarget: remoteDir,
        path: `concepts/${concept.id}.md`,
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_CONFLICT_NOT_FOUND",
    });
  });

  it("resolves a cloud conflict with the remote version", async () => {
    const { conflictPath, remoteDir, repository, service } = await createDivergedConflict();

    await expect(
      service.resolveConflict({
        passphrase: "secret",
        remoteTarget: remoteDir,
        path: conflictPath,
        strategy: "remote",
      }),
    ).resolves.toMatchObject({
      path: conflictPath,
      resolved: true,
      strategy: "remote",
      writtenLocal: [conflictPath],
      uploaded: [],
      skipped: [],
    });
    await expect(repository.readPersonalFile(conflictPath)).resolves.toEqual(
      Buffer.from("# Remote side change\n"),
    );
    await expect(
      service.syncDryRun({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({ conflicts: [] });
  });

  it("resolves a cloud conflict with the local version", async () => {
    const { conflictPath, remoteDir, service } = await createDivergedConflict();

    await expect(
      service.resolveConflict({
        passphrase: "secret",
        remoteTarget: remoteDir,
        path: conflictPath,
        strategy: "local",
      }),
    ).resolves.toMatchObject({
      path: conflictPath,
      resolved: true,
      strategy: "local",
      writtenLocal: [],
      uploaded: [conflictPath],
      skipped: [],
    });
    await expect(
      service.syncDryRun({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      conflicts: [],
      wouldSkip: expect.arrayContaining([conflictPath]),
    });
  });

  it("resolves a cloud conflict by preserving both versions", async () => {
    const { conflictPath, remoteDir, repository, service } = await createDivergedConflict();

    const result = await service.resolveConflict({
      passphrase: "secret",
      remoteTarget: remoteDir,
      path: conflictPath,
      strategy: "both",
    });

    expect(result).toMatchObject({
      path: conflictPath,
      resolved: true,
      strategy: "both",
      writtenLocal: expect.arrayContaining([conflictPath]),
      uploaded: expect.arrayContaining([
        expect.stringMatching(/^concepts\/.+\.conflict-20260701-100000-local\.md$/),
      ]),
      skipped: [],
    });
    const copyPath = result.uploaded[0];
    expect(copyPath).toBeDefined();
    await expect(repository.readPersonalFile(conflictPath)).resolves.toEqual(
      Buffer.from("# Remote side change\n"),
    );
    await expect(repository.readPersonalFile(copyPath as string)).resolves.toEqual(
      Buffer.from("# Local side change\n"),
    );
    await expect(
      service.syncDryRun({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({ conflicts: [] });
  });

  it("skips cloud conflict resolution without writing data", async () => {
    const { conflictPath, remoteDir, repository, service } = await createDivergedConflict();

    await expect(
      service.resolveConflict({
        passphrase: "secret",
        remoteTarget: remoteDir,
        path: conflictPath,
        strategy: "skip",
      }),
    ).resolves.toMatchObject({
      path: conflictPath,
      resolved: false,
      strategy: "skip",
      writtenLocal: [],
      uploaded: [],
      skipped: [conflictPath],
    });
    await expect(repository.readPersonalFile(conflictPath)).resolves.toEqual(
      Buffer.from("# Local side change\n"),
    );
    await expect(
      service.syncDryRun({ passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({ conflicts: [conflictPath] });
  });

  it("allows one-sided local backup changes when remote still matches sync state", async () => {
    const { concept, remoteDir, repository, service } = await createFixture();
    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });
    await repository.writeConceptMarkdown(concept.id, "# Local change\n");

    await expect(
      service.backup({ dryRun: true, passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      conflicts: [],
      wouldUpload: expect.arrayContaining([`concepts/${concept.id}.md`]),
    });
  });

  it("refuses to overwrite remote backup when local and remote both diverged from sync state", async () => {
    const { concept, remoteDir, repository, root, service } = await createFixture();
    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });

    const remoteRoot = await mkdtemp(join(tmpdir(), "growth-memory-cloud-other-"));
    createdPaths.push(remoteRoot);
    const otherPaths = resolvePaths(join(remoteRoot, "project"), join(remoteRoot, "personal"));
    const otherRepository = new PersonalRepository(otherPaths);
    const otherService = new CloudService(otherRepository, {
      clock: () => new Date("2026-07-01T12:00:00.000Z"),
    });
    await mkdir(join(otherPaths.personal.base, ".cloud"), { recursive: true });
    await writeFile(
      join(otherPaths.personal.base, ".cloud", "state.json"),
      await readFile(join(pathsForRoot(root), ".cloud", "state.json"), "utf8"),
      "utf8",
    );
    await otherRepository.saveConcept({
      ...concept,
      history: [],
    });
    await otherRepository.writeConceptMarkdown(concept.id, "# Remote change\n");
    await otherService.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });

    await repository.writeConceptMarkdown(concept.id, "# Local change\n");
    await repository.saveCapabilities({ records: [], version: 1 });
    const objectsBeforeConflict = await readdir(join(remoteDir, "objects"));

    await expect(
      service.backup({ dryRun: true, passphrase: "secret", remoteTarget: remoteDir }),
    ).resolves.toMatchObject({
      conflicts: [`concepts/${concept.id}.md`],
      uploaded: [],
      wouldUpload: ["capabilities.json"],
    });
    await expect(
      service.backup({ dryRun: false, passphrase: "secret", remoteTarget: remoteDir }),
    ).rejects.toMatchObject({
      code: "CLOUD_BACKUP_CONFLICT",
    });
    await expect(readdir(join(remoteDir, "objects"))).resolves.toEqual(
      objectsBeforeConflict,
    );
  });

  it("fails restore dry-run with the wrong passphrase", async () => {
    const { remoteDir, service } = await createFixture();
    await service.backup({
      dryRun: false,
      passphrase: "secret",
      remoteTarget: remoteDir,
    });

    await expect(
      service.restoreDryRun({ passphrase: "wrong", remoteTarget: remoteDir }),
    ).rejects.toThrow();
  });
});

function pathsForRoot(root: string): string {
  return join(root, "personal");
}

it('round-trips typed growth and v2 records through encrypted filesystem sync', async()=> {
 const a=await createFixture(), b=await createFixture();
 const assets = [['growth/observations/op.json',portableObservation],['growth/reviews/capture.json',portableReview],['capabilities.json',portableCapabilities],['concepts/c.json',portableConcept]] as const;
 for(const [p,v] of assets) await a.repository.writePersonalFile(p,Buffer.from(JSON.stringify(v)));
 await a.repository.writePersonalFile('growth/reports/private.json',Buffer.from('private'));
 await a.service.backup({remoteTarget:a.remoteDir,passphrase:'fixture',dryRun:false});
 await b.service.syncApply({remoteTarget:a.remoteDir,passphrase:'fixture'});
 for(const [p,v] of assets) expect(JSON.parse((await b.repository.readPersonalFile(p)).toString())).toEqual(v);
 await expect(b.repository.readPersonalFile('growth/reports/private.json')).rejects.toMatchObject({code:'ENOENT'});
 await a.repository.writePersonalFile('growth/observations/op.json',Buffer.from(JSON.stringify({...portableObservation,source:'remote human correction'})));
 await a.service.backup({remoteTarget:a.remoteDir,passphrase:'fixture',dryRun:false});
 await b.repository.writePersonalFile('growth/observations/op.json',Buffer.from(JSON.stringify({...portableObservation,source:'local human correction'})));
 expect((await b.service.syncDryRun({remoteTarget:a.remoteDir,passphrase:'fixture'})).conflicts).toContain('growth/observations/op.json');
 for(const [path,original] of assets) {
  const remoteValue=JSON.parse(JSON.stringify(original)),localValue=JSON.parse(JSON.stringify(original));
  if(path==='capabilities.json'){remoteValue.history[1].input.rationale='remote';localValue.history[1].input.rationale='local';}
  else if(path==='concepts/c.json'){remoteValue.boundary='remote boundary';localValue.boundary='local boundary';}
  else if(path.includes('observations')){remoteValue.source='remote';localValue.source='local';}
  else {remoteValue.templateIds=['aar'];localValue.templateIds=['kpt'];}
  const remoteBytes=Buffer.from(JSON.stringify(remoteValue)),localBytes=Buffer.from(JSON.stringify(localValue));
  await a.repository.writePersonalFile(path,remoteBytes);await a.service.backup({remoteTarget:a.remoteDir,passphrase:'fixture',dryRun:false});
  await b.repository.writePersonalFile(path,localBytes);
  const resolved=await b.service.resolveConflict({path,strategy:'both',remoteTarget:a.remoteDir,passphrase:'fixture'});
  expect(resolved.resolved).toBe(true);const copy=resolved.writtenLocal.find(p=>p!==path)!;
  expect(await b.repository.readPersonalFile(path)).toEqual(remoteBytes);expect(await b.repository.readPersonalFile(copy)).toEqual(localBytes);
  expect((await b.service.syncDryRun({remoteTarget:a.remoteDir,passphrase:'fixture'})).conflicts).not.toContain(path);
  await a.service.syncApply({remoteTarget:a.remoteDir,passphrase:'fixture'});expect(await a.repository.readPersonalFile(copy)).toEqual(localBytes);
 }
 const api=await import('../../src/index.js');
 const growth=new api.GrowthService(new api.ProjectRepository(b.repository.paths),b.repository,{clock:()=>new Date('2026-10-30T00:00:00Z'),id:()=> 'fixture'});
 const report=await growth.report();expect(report.coverage.counts.observations).toBe(1);expect(report.coverage.counts.capturedReviews).toBe(1);expect(await growth.history()).toHaveLength(2);
 expect((await b.repository.listConcepts()).filter(c=>c.id==='c')).toHaveLength(1);
 const assetService=new (await import('../../src/index.js')).PersonalAssetService(b.repository,{clock:()=>new Date('2026-10-30T00:00:00Z')});
 const exportBundle=await assetService.exportPersonal(join(b.root,'..','archive-export'));
 expect((await assetService.verifyPersonalBundle(exportBundle.exportRoot)).valid).toBe(true);


});
