import { randomBytes, createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, posix } from "node:path";

import { DomainError } from "../domain/errors.js";
import { isPersonalKnowledgeAsset, validatePersonalAsset } from "../personal/personal-asset-paths.js";
import { PersonalRepository } from "../storage/personal-repository.js";
import { writeJsonAtomic } from "../storage/files.js";
import { safeChildPath } from "../storage/paths.js";
import { decryptPayload, deriveCloudKey, encryptPayload } from "./cloud-crypto.js";
import type { CloudRemote, CloudRemoteRevision } from "./cloud-remote.js";
import { resolveCloudRemote } from "./cloud-remote.js";
import type {
  CloudBackupResult,
  CloudCleanupResult,
  CloudConflictResolveResult,
  CloudConflictStrategy,
  CloudManifest,
  CloudObjectManifest,
  CloudRestoreDryRunResult,
  CloudSyncApplyResult,
  CloudConflictListResult,
  CloudConflictShowResult,
  CloudRemoteCheckResult,
  CloudStatusResult,
  CloudSyncState,
  CloudSyncDryRunResult,
} from "./cloud-types.js";

type RemoteObjectView = {
  bytes: number;
  content: Buffer;
  manifest: CloudObjectManifest;
  path: string;
  sha256: string;
};

type LocalObjectView = {
  content: Buffer;
  path: string;
  sha256: string;
};

type CloudSyncPlan = {
  baseByPath: Map<string, CloudSyncState["objects"][number]>;
  localByPath: Map<string, LocalObjectView>;
  remote: CloudRemote;
  manifestRevision: CloudRemoteRevision;
  manifestTombstones: NonNullable<CloudManifest["tombstones"]>;
  remoteByPath: Map<string, RemoteObjectView>;
  remoteObjects: RemoteObjectView[];
  syncState: CloudSyncState | null;
  wouldUpload: string[];
  wouldDownload: string[];
  wouldSkip: string[];
  wouldDelete: string[];
  wouldRemoveLocal: string[];
  conflicts: string[];
};

export class CloudService {
  constructor(
    private readonly repository: PersonalRepository,
    private readonly options: {
      clock: () => Date;
    },
  ) {}

  async backup(input: {
    dryRun: boolean;
    passphrase: string;
    remoteTarget: string;
  }): Promise<CloudBackupResult> {
    const remote = resolveCloudRemote({ target: input.remoteTarget });
    const existingRead = await remote.readManifest();
    const existing = existingRead?.manifest ?? null;
    const existingObjects = await this.readRemoteObjects(
      remote,
      existing,
      input.passphrase,
    );
    const existingByPath = new Map(
      existingObjects.map((object) => [object.path, object]),
    );
    const syncState = await this.readSyncState(remote.displayRoot);
    const baseByPath = new Map(
      (syncState?.objects ?? []).map((object) => [object.path, object]),
    );
    const remoteTombstoneIds = new Set((existing?.tombstones ?? []).map((tombstone) => tombstone.objectId));
    const files = (await this.repository.listPersonalFiles()).filter(isSupportedSyncFile);
    const objects: CloudObjectManifest[] = [];
    const stateObjects: CloudSyncState["objects"] = [];
    const wouldUpload: string[] = [];
    const wouldSkip: string[] = [];
    const conflicts: string[] = [];
    const pendingUploads: Array<{ ciphertext: Buffer; object: CloudObjectManifest }> = [];
    const seen = new Set<string>();
    let bytes = 0;

    for (const path of files) {
      seen.add(path);
      const content = await this.repository.readPersonalFile(path);
      const sourceSha256 = sha256(content);
      const previous = existingByPath.get(path);
      const base = baseByPath.get(path);
      if (!previous && base && remoteTombstoneIds.has(base.objectId)) {
        conflicts.push(path);
        continue;
      }
      if (previous?.sha256 === sourceSha256) {
        wouldSkip.push(path);
        objects.push(previous.manifest);
        stateObjects.push(toSyncStateObject(previous));
        continue;
      }

      if (
        previous &&
        !canUploadFromLocal({
          baseSha256: base?.sha256,
          localSha256: sourceSha256,
          remoteSha256: previous.sha256,
        })
      ) {
        conflicts.push(path);
        objects.push(previous.manifest);
        stateObjects.push(toSyncStateObject(previous));
        continue;
      }

      wouldUpload.push(path);
      bytes += content.byteLength;
      const encryptedObject = await this.encryptObject(
        path,
        content,
        input.passphrase,
        previous?.manifest,
      );
      const object = encryptedObject.object;
      objects.push(object);
      pendingUploads.push(encryptedObject);
      stateObjects.push({
        objectId: object.objectId,
        path,
        remoteObjectKey: object.objectKey,
        remoteVersion: object.version,
        sha256: sourceSha256,
      });
    }

    for (const object of existingObjects) {
      if (!seen.has(object.path)) {
        objects.push(object.manifest);
        stateObjects.push(toSyncStateObject(object));
      }
    }

    if (!input.dryRun && conflicts.length > 0) {
      throw new DomainError(
        "CLOUD_BACKUP_CONFLICT",
        "Cloud backup found divergent remote objects and will not overwrite them",
        { conflicts: conflicts.sort(), remote: remote.displayRoot },
      );
    }

    if (!input.dryRun) {
      for (const upload of pendingUploads) {
        await remote.writeObject(upload.object.objectKey, upload.ciphertext);
      }
      const manifest: CloudManifest = {
        schemaVersion: 1,
        createdAt: this.options.clock().toISOString(),
        source: "personal-root",
        objects: objects.sort((left, right) =>
          left.objectId.localeCompare(right.objectId) ||
          left.objectKey.localeCompare(right.objectKey),
        ),
        ...(existing?.tombstones?.length ? { tombstones: existing.tombstones } : {}),
      };
      await this.writeManifest(remote, manifest, existingRead?.revision);
      await this.writeSyncState(remote.displayRoot, stateObjects);
    }

    return {
      remote: remote.displayRoot,
      dryRun: input.dryRun,
      wouldUpload: wouldUpload.sort(),
      wouldSkip: wouldSkip.sort(),
      conflicts: conflicts.sort(),
      uploaded: input.dryRun ? [] : wouldUpload.sort(),
      bytes,
    };
  }

  async status(remoteTarget: string): Promise<CloudStatusResult> {
    const remote = resolveCloudRemote({ target: remoteTarget });
    const manifestRead = await remote.readManifest();
    const manifest = manifestRead?.manifest ?? null;
    return {
      remote: remote.displayRoot,
      configured: manifest !== null,
      objects: manifest?.objects.length ?? 0,
      capabilities: remote.capabilities,
      ...(manifest ? { createdAt: manifest.createdAt } : {}),
    };
  }

  async checkRemote(remoteTarget: string): Promise<CloudRemoteCheckResult> {
    const remote = resolveCloudRemote({ target: remoteTarget });
    const kind = remote.id === "filesystem" ? "filesystem" : "s3";
    const safeExistingManifestWrite = remote.capabilities.conditionalManifestWrite;
    return {
      remote: remote.displayRoot,
      kind,
      configured: true,
      safeExistingManifestWrite,
      capabilities: remote.capabilities,
      warnings: safeExistingManifestWrite
        ? []
        : ["Existing manifests cannot be updated safely until this S3 connector supports conditional writes."],
    };
  }

  async cleanupDryRun(input: { remoteTarget: string }): Promise<CloudCleanupResult> {
    const remote = resolveCloudRemote({ target: input.remoteTarget });
    if (!remote.listObjects || !remote.capabilities.objectListing) {
      throw new DomainError(
        "CLOUD_REMOTE_LIST_UNSUPPORTED",
        "Cloud remote does not support object listing",
        { remote: remote.displayRoot },
      );
    }
    const manifestRead = await remote.readManifest();
    const referencedObjects = (manifestRead?.manifest.objects ?? [])
      .map((object) => object.objectKey)
      .sort();
    const referenced = new Set(referencedObjects);
    const remoteObjects = await remote.listObjects("objects");
    const orphanObjects = remoteObjects
      .filter((objectKey) => !referenced.has(objectKey))
      .sort();
    const syncState = await this.readSyncState(remote.displayRoot);

    return {
      remote: remote.displayRoot,
      dryRun: true,
      referencedObjects,
      orphanObjects,
      retainedConflictCopies: [],
      tombstones: (syncState?.tombstones ?? [])
        .map((tombstone) => tombstone.path)
        .sort(),
      wouldDeleteObjects: orphanObjects,
      deletedObjects: [],
    };
  }

  async cleanupApply(input: { remoteTarget: string }): Promise<CloudCleanupResult> {
    const plan = await this.cleanupDryRun(input);
    const remote = resolveCloudRemote({ target: input.remoteTarget });
    if (!remote.deleteObject || !remote.capabilities.objectDelete) {
      throw new DomainError(
        "CLOUD_REMOTE_DELETE_UNSUPPORTED",
        "Cloud remote does not support object deletion",
        { remote: remote.displayRoot },
      );
    }
    const deletedObjects: string[] = [];
    for (const objectKey of plan.wouldDeleteObjects) {
      await remote.deleteObject(objectKey);
      deletedObjects.push(objectKey);
    }
    return {
      ...plan,
      dryRun: false,
      deletedObjects: deletedObjects.sort(),
    };
  }

  async restoreDryRun(input: {
    passphrase: string;
    remoteTarget: string;
  }): Promise<CloudRestoreDryRunResult> {
    const remote = resolveCloudRemote({ target: input.remoteTarget });
    const manifest = (await readRequiredManifest(remote)).manifest;
    const remoteObjects = await this.readRemoteObjects(
      remote,
      manifest,
      input.passphrase,
    );
    const existing = new Set(await this.repository.listPersonalFiles());
    const wouldAdd: string[] = [];
    const wouldSkip: string[] = [];
    const conflicts: string[] = [];

    for (const object of remoteObjects) {
      if (!existing.has(object.path)) {
        wouldAdd.push(object.path);
        continue;
      }

      const local = await this.repository.readPersonalFile(object.path);
      if (sha256(local) === object.sha256) {
        wouldSkip.push(object.path);
      } else {
        conflicts.push(object.path);
      }
    }

    return {
      remote: remote.displayRoot,
      wouldAdd: wouldAdd.sort(),
      wouldSkip: wouldSkip.sort(),
      conflicts: conflicts.sort(),
    };
  }

  async syncDryRun(input: {
    passphrase: string;
    remoteTarget: string;
  }): Promise<CloudSyncDryRunResult> {
    const plan = await this.planSync(input);
    return {
      remote: plan.remote.displayRoot,
      wouldUpload: plan.wouldUpload,
      wouldDownload: plan.wouldDownload,
      wouldSkip: plan.wouldSkip,
      wouldDelete: [...plan.wouldDelete, ...plan.wouldRemoveLocal].sort(),
      conflicts: plan.conflicts,
    };
  }

  async syncApply(input: {
    passphrase: string;
    remoteTarget: string;
  }): Promise<CloudSyncApplyResult> {
    const plan = await this.planSync(input);
    if (plan.conflicts.length > 0) {
      throw new DomainError(
        "CLOUD_SYNC_CONFLICT",
        "Cloud sync found divergent local and remote objects and will not overwrite them",
        { conflicts: plan.conflicts, remote: plan.remote.displayRoot },
      );
    }

    const nextObjectsByPath = new Map<string, CloudObjectManifest>();
    const nextStateByPath = new Map<string, CloudSyncState["objects"][number]>();
    const uploaded: string[] = [];
    const downloaded: string[] = [];
    const deleted: string[] = [];
    const tombstones = [...(plan.syncState?.tombstones ?? [])];
    const remoteTombstones = new Map(
      plan.manifestTombstones.map((tombstone) =>
        [tombstone.objectId, tombstone] as const,
      ),
    );

    for (const object of plan.remoteObjects) {
      nextObjectsByPath.set(object.path, object.manifest);
      nextStateByPath.set(object.path, toSyncStateObject(object));
    }

    for (const path of plan.wouldDownload) {
      const remoteObject = plan.remoteByPath.get(path);
      if (!remoteObject) {
        throw new DomainError("CLOUD_SYNC_PLAN_INVALID", "Remote download target disappeared", {
          path,
          remote: plan.remote.displayRoot,
        });
      }
      await this.repository.writePersonalFile(path, remoteObject.content);
      nextObjectsByPath.set(path, remoteObject.manifest);
      nextStateByPath.set(path, toSyncStateObject(remoteObject));
      downloaded.push(path);
    }

    for (const path of plan.wouldUpload) {
      const local = plan.localByPath.get(path);
      if (!local) {
        throw new DomainError("CLOUD_SYNC_PLAN_INVALID", "Local upload target disappeared", {
          path,
          remote: plan.remote.displayRoot,
        });
      }
      const previous = plan.remoteByPath.get(path)?.manifest;
      const encryptedObject = await this.encryptObject(
        path,
        local.content,
        input.passphrase,
        previous,
      );
      await plan.remote.writeObject(encryptedObject.object.objectKey, encryptedObject.ciphertext);
      nextObjectsByPath.set(path, encryptedObject.object);
      nextStateByPath.set(path, {
        objectId: encryptedObject.object.objectId,
        path,
        remoteObjectKey: encryptedObject.object.objectKey,
        remoteVersion: encryptedObject.object.version,
        sha256: local.sha256,
      });
      uploaded.push(path);
    }

    for (const path of plan.wouldDelete) {
      const base = plan.baseByPath.get(path);
      const remoteObject = plan.remoteByPath.get(path);
      if (!base || !remoteObject) {
        throw new DomainError("CLOUD_SYNC_PLAN_INVALID", "Tombstone target disappeared", {
          path,
          remote: plan.remote.displayRoot,
        });
      }
      nextObjectsByPath.delete(path);
      nextStateByPath.delete(path);
      tombstones.push({
        deletedAt: this.options.clock().toISOString(),
        objectId: base.objectId,
        path,
        remoteObjectKey: base.remoteObjectKey,
        remoteVersion: base.remoteVersion,
        sha256: base.sha256,
      });
      remoteTombstones.set(base.objectId, {
        objectId: base.objectId,
        deletedAt: this.options.clock().toISOString(),
        version: base.remoteVersion + 1,
      });
      deleted.push(path);
    }

    const manifest: CloudManifest = {
      schemaVersion: 1,
      createdAt: this.options.clock().toISOString(),
      source: "personal-root",
      objects: Array.from(nextObjectsByPath.values()).sort((left, right) =>
        left.objectId.localeCompare(right.objectId) ||
        left.objectKey.localeCompare(right.objectKey),
      ),
      ...(remoteTombstones.size > 0
        ? { tombstones: Array.from(remoteTombstones.values()) }
        : {}),
    };
    await this.writeManifest(plan.remote, manifest, plan.manifestRevision);
    await this.repository.withMutationLock(async () => {
      for (const path of plan.wouldRemoveLocal) {
        await this.repository.removePersonalFile(path);
        deleted.push(path);
      }
    });
    await this.writeSyncState(
      plan.remote.displayRoot,
      Array.from(nextStateByPath.values()),
      tombstones,
    );

    return {
      remote: plan.remote.displayRoot,
      dryRun: false,
      applied: true,
      wouldUpload: plan.wouldUpload,
      wouldDownload: plan.wouldDownload,
      wouldSkip: plan.wouldSkip,
      wouldDelete: [...plan.wouldDelete, ...plan.wouldRemoveLocal].sort(),
      conflicts: [],
      deleted: deleted.sort(),
      uploaded: uploaded.sort(),
      downloaded: downloaded.sort(),
    };
  }

  async listConflicts(input: {
    passphrase: string;
    remoteTarget: string;
  }): Promise<CloudConflictListResult> {
    const plan = await this.planSync(input);
    return {
      remote: plan.remote.displayRoot,
      conflicts: plan.conflicts,
    };
  }

  async showConflict(input: {
    passphrase: string;
    remoteTarget: string;
    path: string;
  }): Promise<CloudConflictShowResult> {
    const plan = await this.planSync(input);
    this.assertConflictPath(plan, input.path);
    const local = plan.localByPath.get(input.path);
    const remoteObject = plan.remoteByPath.get(input.path);
    if (!local || !remoteObject) {
      throw new DomainError("CLOUD_SYNC_PLAN_INVALID", "Conflict target disappeared", {
        path: input.path,
        remote: plan.remote.displayRoot,
      });
    }

    return {
      remote: plan.remote.displayRoot,
      path: input.path,
      local: {
        bytes: local.content.byteLength,
        sha256: local.sha256,
        preview: previewContent(local.content),
      },
      remoteObject: {
        bytes: remoteObject.content.byteLength,
        sha256: remoteObject.sha256,
        preview: previewContent(remoteObject.content),
      },
    };
  }

  async resolveConflict(input: {
    passphrase: string;
    remoteTarget: string;
    path: string;
    strategy: CloudConflictStrategy;
  }): Promise<CloudConflictResolveResult> {
    const plan = await this.planSync(input);
    this.assertConflictPath(plan, input.path);
    if (!["local", "remote", "both", "skip"].includes(input.strategy)) {
      throw new DomainError(
        "CLOUD_CONFLICT_STRATEGY_INVALID",
        "Unsupported cloud conflict strategy",
        { strategy: input.strategy },
      );
    }
    if (input.strategy === "skip") {
      return {
        remote: plan.remote.displayRoot,
        path: input.path,
        strategy: input.strategy,
        resolved: false,
        writtenLocal: [],
        uploaded: [],
        skipped: [input.path],
      };
    }

    const local = plan.localByPath.get(input.path);
    const remoteObject = plan.remoteByPath.get(input.path);
    if (!local || !remoteObject) {
      throw new DomainError("CLOUD_SYNC_PLAN_INVALID", "Conflict target disappeared", {
        path: input.path,
        remote: plan.remote.displayRoot,
      });
    }

    if (input.strategy === "remote") {
      await this.repository.writePersonalFile(input.path, remoteObject.content);
      await this.writeSyncState(plan.remote.displayRoot, this.stateWith(plan, [
        toSyncStateObject(remoteObject),
      ]), plan.syncState?.tombstones ?? []);
      return {
        remote: plan.remote.displayRoot,
        path: input.path,
        strategy: input.strategy,
        resolved: true,
        writtenLocal: [input.path],
        uploaded: [],
        skipped: [],
      };
    }

    if (input.strategy === "local") {
      const encrypted = await this.encryptObject(
        input.path,
        local.content,
        input.passphrase,
        remoteObject.manifest,
      );
      await plan.remote.writeObject(encrypted.object.objectKey, encrypted.ciphertext);
      await this.writeManifestWith(plan, [
        { manifest: encrypted.object, path: input.path },
      ]);
      await this.writeSyncState(plan.remote.displayRoot, this.stateWith(plan, [{
        objectId: encrypted.object.objectId,
        path: input.path,
        remoteObjectKey: encrypted.object.objectKey,
        remoteVersion: encrypted.object.version,
        sha256: local.sha256,
      }]), plan.syncState?.tombstones ?? []);
      return {
        remote: plan.remote.displayRoot,
        path: input.path,
        strategy: input.strategy,
        resolved: true,
        writtenLocal: [],
        uploaded: [input.path],
        skipped: [],
      };
    }

    const copyPath = this.conflictCopyPath(input.path);
    if (plan.localByPath.has(copyPath) || plan.remoteByPath.has(copyPath)) {
      throw new DomainError(
        "CLOUD_CONFLICT_COPY_EXISTS",
        "Cloud conflict copy path already exists",
        { path: copyPath },
      );
    }
    await this.repository.writePersonalFile(copyPath, local.content);
    await this.repository.writePersonalFile(input.path, remoteObject.content);
    const copyEncrypted = await this.encryptObject(copyPath, local.content, input.passphrase);
    await plan.remote.writeObject(copyEncrypted.object.objectKey, copyEncrypted.ciphertext);
    await this.writeManifestWith(plan, [
      { manifest: copyEncrypted.object, path: copyPath },
    ]);
    await this.writeSyncState(plan.remote.displayRoot, this.stateWith(plan, [
      toSyncStateObject(remoteObject),
      {
        objectId: copyEncrypted.object.objectId,
        path: copyPath,
        remoteObjectKey: copyEncrypted.object.objectKey,
        remoteVersion: copyEncrypted.object.version,
        sha256: local.sha256,
      },
    ]), plan.syncState?.tombstones ?? []);
    return {
      remote: plan.remote.displayRoot,
      path: input.path,
      strategy: input.strategy,
      resolved: true,
      writtenLocal: [copyPath, input.path].sort(),
      uploaded: [copyPath],
      skipped: [],
    };
  }

  private async planSync(input: {
    passphrase: string;
    remoteTarget: string;
  }): Promise<CloudSyncPlan> {
    const remote = resolveCloudRemote({ target: input.remoteTarget });
    const manifestRead = await readRequiredManifest(remote);
    const manifest = manifestRead.manifest;
    const remoteObjects = await this.readRemoteObjects(
      remote,
      manifest,
      input.passphrase,
    );
    const remoteByPath = new Map(remoteObjects.map((object) => [object.path, object]));
    const remoteTombstoneIds = new Set((manifest.tombstones ?? []).map((tombstone) => tombstone.objectId));
    const syncState = await this.readSyncState(remote.displayRoot);
    const baseByPath = new Map(
      (syncState?.objects ?? []).map((object) => [object.path, object]),
    );
    const localFiles = (await this.repository.listPersonalFiles()).filter(isSupportedSyncFile);
    const localByPath = new Map<string, LocalObjectView>();
    const localSet = new Set(localFiles);
    const wouldUpload: string[] = [];
    const wouldDownload: string[] = [];
    const wouldSkip: string[] = [];
    const wouldDelete: string[] = [];
    const wouldRemoveLocal: string[] = [];
    const conflicts: string[] = [];

    for (const path of localFiles) {
      const content = await this.repository.readPersonalFile(path);
      localByPath.set(path, { content, path, sha256: sha256(content) });
    }

    const localDeletedBasePaths = new Set(
      Array.from(baseByPath.keys()).filter((path) => !localSet.has(path)),
    );

    for (const object of remoteObjects) {
      if (!localSet.has(object.path) && !localDeletedBasePaths.has(object.path)) {
        wouldDownload.push(object.path);
      }
    }

    for (const [path, local] of localByPath) {
      const remoteObject = remoteByPath.get(path);
      if (!remoteObject) {
        const base = baseByPath.get(path);
        if (base && remoteTombstoneIds.has(base.objectId)) {
          if (base.sha256 === local.sha256) {
            wouldRemoveLocal.push(path);
          } else {
            conflicts.push(path);
          }
        } else if (base) {
          conflicts.push(path);
        } else {
          wouldUpload.push(path);
        }
      } else if (remoteObject.sha256 === local.sha256) {
        wouldSkip.push(path);
      } else if (
        canUploadFromLocal({
          baseSha256: baseByPath.get(path)?.sha256,
          localSha256: local.sha256,
          remoteSha256: remoteObject.sha256,
        })
      ) {
        wouldUpload.push(path);
      } else if (baseByPath.get(path)?.sha256 === local.sha256) {
        wouldDownload.push(path);
      } else {
        conflicts.push(path);
      }
    }

    for (const path of localDeletedBasePaths) {
      const base = baseByPath.get(path);
      const remoteObject = remoteByPath.get(path);
      if (!base || !remoteObject) {
        continue;
      }
      if (remoteObject.sha256 === base.sha256) {
        wouldDelete.push(path);
      } else {
        conflicts.push(path);
      }
    }

    return {
      baseByPath,
      localByPath,
      remote,
      manifestRevision: manifestRead.revision,
      manifestTombstones: manifest.tombstones ?? [],
      remoteByPath,
      remoteObjects,
      syncState,
      wouldUpload: wouldUpload.sort(),
      wouldDownload: wouldDownload.sort(),
      wouldSkip: wouldSkip.sort(),
      wouldDelete: wouldDelete.sort(),
      wouldRemoveLocal: wouldRemoveLocal.sort(),
      conflicts: conflicts.sort(),
    };
  }

  private assertConflictPath(plan: CloudSyncPlan, path: string): void {
    if (!plan.conflicts.includes(path)) {
      throw new DomainError(
        "CLOUD_CONFLICT_NOT_FOUND",
        "Requested cloud path is not currently conflicted",
        { path, conflicts: plan.conflicts, remote: plan.remote.displayRoot },
      );
    }
  }

  private conflictCopyPath(path: string): string {
    const extension = extname(path);
    const baseName = basename(path, extension);
    const dir = dirname(path);
    const timestamp = formatConflictTimestamp(this.options.clock());
    const fileName = `${baseName}.conflict-${timestamp}-local${extension}`;
    return dir === "." ? fileName : posix.join(dir, fileName);
  }

  private stateWith(
    plan: CloudSyncPlan,
    replacements: CloudSyncState["objects"],
  ): CloudSyncState["objects"] {
    const byPath = new Map<string, CloudSyncState["objects"][number]>();
    for (const object of plan.syncState?.objects ?? []) {
      byPath.set(object.path, object);
    }
    for (const replacement of replacements) {
      byPath.set(replacement.path, replacement);
    }
    return Array.from(byPath.values());
  }

  private async writeManifestWith(
    plan: CloudSyncPlan,
    replacements: Array<{ manifest: CloudObjectManifest; path: string }>,
  ): Promise<void> {
    const nextByPath = new Map<string, CloudObjectManifest>();
    for (const object of plan.remoteObjects) {
      nextByPath.set(object.path, object.manifest);
    }
    for (const replacement of replacements) {
      nextByPath.set(replacement.path, replacement.manifest);
    }
    const manifest: CloudManifest = {
      schemaVersion: 1,
      createdAt: this.options.clock().toISOString(),
      source: "personal-root",
      objects: Array.from(nextByPath.values()).sort((left, right) =>
        left.objectId.localeCompare(right.objectId) ||
        left.objectKey.localeCompare(right.objectKey),
      ),
      ...(plan.manifestTombstones.length > 0
        ? { tombstones: plan.manifestTombstones }
        : {}),
    };
    await this.writeManifest(plan.remote, manifest, plan.manifestRevision);
  }

  private async writeManifest(
    remote: CloudRemote,
    manifest: CloudManifest,
    expectedRevision?: CloudRemoteRevision,
  ): Promise<void> {
    if (expectedRevision && !remote.capabilities.conditionalManifestWrite) {
      throw new DomainError(
        "CLOUD_MANIFEST_CONDITIONAL_WRITE_UNSUPPORTED",
        "Cloud remote cannot safely update an existing manifest",
        { remote: remote.displayRoot },
      );
    }
    await remote.writeManifest(
      manifest,
      expectedRevision ? { expectedRevision } : {},
    );
  }

  private async verifyRemoteObject(
    remote: CloudRemote,
    object: CloudObjectManifest,
    passphrase: string,
  ): Promise<RemoteObjectView> {
    const ciphertext = await remote.readObject(object.objectKey);
    const actualEncryptedHash = sha256(ciphertext);
    if (actualEncryptedHash !== object.encryptedSha256) {
      throw new DomainError(
        "CLOUD_OBJECT_DIGEST_MISMATCH",
        "Encrypted cloud object digest does not match manifest",
        { objectId: object.objectId },
      );
    }

    const key = await deriveCloudKey(passphrase, Buffer.from(object.salt, "base64"));
    const plaintext = decryptPayload(
      {
        ciphertext,
        iv: object.iv,
        tag: object.tag,
      },
      key,
    );
    const envelope = parseObjectEnvelope(plaintext);
    const content = Buffer.from(envelope.contentBase64, "base64");
    if (sha256(content) !== envelope.sha256 || content.byteLength !== envelope.bytes) {
      throw new DomainError(
        "CLOUD_OBJECT_SOURCE_MISMATCH",
        "Decrypted cloud object does not match source digest",
        { objectId: object.objectId },
      );
    }
    validatePersonalAsset(envelope.path, content);
    return {
      bytes: envelope.bytes,
      content,
      manifest: object,
      path: envelope.path,
      sha256: envelope.sha256,
    };
  }

  private async encryptObject(
    path: string,
    content: Buffer,
    passphrase: string,
    previous?: CloudObjectManifest,
  ): Promise<{ ciphertext: Buffer; object: CloudObjectManifest }> {
    const sourceSha256 = sha256(content);
    const objectId = previous?.objectId ?? objectIdForPath(path, passphrase);
    const version = (previous?.version ?? 0) + 1;
    const envelope = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        bytes: content.byteLength,
        contentBase64: content.toString("base64"),
        path,
        sha256: sourceSha256,
      }),
      "utf8",
    );
    const salt = randomBytes(16);
    const key = await deriveCloudKey(passphrase, salt);
    const encrypted = encryptPayload(envelope, key);
    const encryptedSha256 = sha256(encrypted.ciphertext);
    return {
      ciphertext: encrypted.ciphertext,
      object: {
        encryptedBytes: encrypted.ciphertext.byteLength,
        encryptedSha256,
        iv: encrypted.iv,
        objectId,
        objectKey: `${encryptedSha256}.bin`,
        salt: salt.toString("base64"),
        tag: encrypted.tag,
        version,
      },
    };
  }

  private async readRemoteObjects(
    remote: CloudRemote,
    manifest: CloudManifest | null,
    passphrase: string,
  ): Promise<RemoteObjectView[]> {
    return Promise.all(
      (manifest?.objects ?? []).map((object) =>
        this.verifyRemoteObject(remote, object, passphrase),
      ),
    );
  }

  private async readSyncState(remoteRoot: string): Promise<CloudSyncState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.syncStatePath(), "utf8")) as CloudSyncState;
      if (parsed.remote !== remoteRoot) {
        return null;
      }
      return parsed;
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  private async writeSyncState(
    remoteRoot: string,
    objects: CloudSyncState["objects"],
    tombstones: CloudSyncState["tombstones"] = [],
  ): Promise<void> {
    const state: CloudSyncState = {
      schemaVersion: 1,
      remote: remoteRoot,
      syncedAt: this.options.clock().toISOString(),
      objects: objects.sort((left, right) => left.path.localeCompare(right.path)),
      ...(tombstones.length > 0
        ? { tombstones: tombstones.sort((left, right) => left.path.localeCompare(right.path)) }
        : {}),
    };
    await writeJsonAtomic(this.syncStatePath(), state);
  }

  private syncStatePath(): string {
    return safeChildPath(
      safeChildPath(this.repository.paths.personal.base, ".cloud"),
      "state.json",
    );
  }
}

export const isSupportedSyncFile = isPersonalKnowledgeAsset;

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function objectIdForPath(path: string, passphrase: string): string {
  const key = createHash("sha256")
    .update(`growth-memory-cloud-object-id:${passphrase}`)
    .digest();
  return createHmac("sha256", key).update(path).digest("hex");
}

function toSyncStateObject(object: RemoteObjectView): CloudSyncState["objects"][number] {
  return {
    objectId: object.manifest.objectId,
    path: object.path,
    remoteObjectKey: object.manifest.objectKey,
    remoteVersion: object.manifest.version,
    sha256: object.sha256,
  };
}

function previewContent(content: Buffer): string {
  const text = content.toString("utf8");
  if (text.includes("\uFFFD")) {
    return "[binary or non-text content]";
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, 20);
  const preview = lines.join("\n");
  return preview.length > 2000 ? preview.slice(0, 2000) : preview;
}

function formatConflictTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

function parseObjectEnvelope(content: Buffer): {
  bytes: number;
  contentBase64: string;
  path: string;
  sha256: string;
} {
  const parsed = JSON.parse(content.toString("utf8")) as {
    bytes?: unknown;
    contentBase64?: unknown;
    path?: unknown;
    schemaVersion?: unknown;
    sha256?: unknown;
  };
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.bytes !== "number" ||
    typeof parsed.contentBase64 !== "string" ||
    typeof parsed.path !== "string" ||
    typeof parsed.sha256 !== "string"
  ) {
    throw new DomainError(
      "CLOUD_OBJECT_ENVELOPE_INVALID",
      "Decrypted cloud object envelope is invalid",
      {},
    );
  }
  return {
    bytes: parsed.bytes,
    contentBase64: parsed.contentBase64,
    path: parsed.path,
    sha256: parsed.sha256,
  };
}

function canUploadFromLocal(input: {
  baseSha256: string | undefined;
  localSha256: string;
  remoteSha256: string;
}): boolean {
  if (input.localSha256 === input.remoteSha256) {
    return false;
  }
  return input.baseSha256 === input.remoteSha256;
}

function isFileNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function readRequiredManifest(
  remote: CloudRemote,
): Promise<{ manifest: CloudManifest; revision: CloudRemoteRevision }> {
  const manifest = await remote.readManifest();
  if (!manifest) {
    throw new DomainError(
      "CLOUD_MANIFEST_NOT_FOUND",
      "Cloud remote manifest was not found",
      { remote: remote.displayRoot },
    );
  }
  return manifest;
}
