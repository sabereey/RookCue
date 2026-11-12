import { DomainError } from "../domain/errors.js";
import type { CloudManifest } from "./cloud-types.js";
import type { CloudRemoteRevision } from "./cloud-remote.js";

export type HostedCloudQuota = {
  maxObjectBytes: number;
  maxObjects: number;
  maxTotalBytes: number;
};

type AccountState = {
  manifest: CloudManifest | null;
  manifestRevision: number;
  objects: Map<string, Buffer>;
};

export type HostedCloudBackendSnapshot = {
  accounts: Array<{
    accountId: string;
    manifestRevision: number;
    objectKeys: string[];
    totalBytes: number;
  }>;
};

export type HostedCloudBackend = LocalHostedCloudBackend;

export function assertOpaqueHostedObjectKey(objectKey: string): void {
  if (!objectKey) {
    throw new DomainError("CLOUD_HOSTED_OBJECT_KEY_INVALID", "Hosted cloud object key must be opaque", {
      objectKey,
      reason: "empty",
    });
  }
  if (objectKey.includes("/") || objectKey.includes("\\")) {
    throw new DomainError("CLOUD_HOSTED_OBJECT_KEY_INVALID", "Hosted cloud object key must be opaque", {
      objectKey,
      reason: "contains-path-separator",
    });
  }
  const segments = objectKey.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) {
    throw new DomainError("CLOUD_HOSTED_OBJECT_KEY_INVALID", "Hosted cloud object key must be opaque", {
      objectKey,
      reason: "contains-traversal-segment",
    });
  }
}

export class LocalHostedCloudBackend {
  private readonly accounts = new Map<string, AccountState>();
  private readonly quota: HostedCloudQuota;

  constructor(
    quota: HostedCloudQuota = {
      maxObjectBytes: 5 * 1024 * 1024,
      maxObjects: 10_000,
      maxTotalBytes: 1024 * 1024 * 1024,
    },
  ) {
    this.quota = quota;
  }

  async readManifest(
    accountId: string,
  ): Promise<{ manifest: CloudManifest; revision: CloudRemoteRevision } | null> {
    const account = this.account(accountId);
    if (!account.manifest) {
      return null;
    }

    return {
      manifest: this.cloneManifest(account.manifest),
      revision: this.revision(account.manifestRevision),
    };
  }

  async writeManifest(
    accountId: string,
    manifest: CloudManifest,
    options: { expectedRevision?: CloudRemoteRevision } = {},
  ): Promise<CloudRemoteRevision> {
    const account = this.account(accountId);
    if (
      options.expectedRevision &&
      options.expectedRevision.versionId !== String(account.manifestRevision)
    ) {
      throw new DomainError(
        "CLOUD_MANIFEST_REVISION_CONFLICT",
        "Hosted cloud manifest revision changed",
        { accountId },
      );
    }

    this.assertOpaqueManifestObjectKeys(manifest);
    account.manifest = this.cloneManifest(manifest);
    account.manifestRevision += 1;
    return this.revision(account.manifestRevision);
  }

  async readObject(accountId: string, objectKey: string): Promise<Buffer> {
    this.assertOpaqueObjectKey(objectKey);
    const object = this.account(accountId).objects.get(objectKey);
    if (!object) {
      throw new DomainError(
        "CLOUD_HOSTED_OBJECT_NOT_FOUND",
        "Hosted cloud object was not found",
        { objectKey },
      );
    }

    return Buffer.from(object);
  }

  async writeObject(accountId: string, objectKey: string, content: Buffer): Promise<void> {
    this.assertOpaqueObjectKey(objectKey);
    const account = this.account(accountId);
    if (content.byteLength > this.quota.maxObjectBytes) {
      throw new DomainError(
        "CLOUD_QUOTA_EXCEEDED",
        "Hosted cloud object exceeds max object size",
        {
          limit: this.quota.maxObjectBytes,
          objectKey,
        },
      );
    }

    const existingBytes = account.objects.get(objectKey)?.byteLength ?? 0;
    const nextTotal = this.totalBytes(account) - existingBytes + content.byteLength;
    if (account.objects.size >= this.quota.maxObjects && !account.objects.has(objectKey)) {
      throw new DomainError("CLOUD_QUOTA_EXCEEDED", "Hosted cloud object count quota exceeded", {
        limit: this.quota.maxObjects,
      });
    }
    if (nextTotal > this.quota.maxTotalBytes) {
      throw new DomainError("CLOUD_QUOTA_EXCEEDED", "Hosted cloud storage quota exceeded", {
        limit: this.quota.maxTotalBytes,
      });
    }

    account.objects.set(objectKey, Buffer.from(content));
  }

  async listObjects(accountId: string): Promise<string[]> {
    return Array.from(this.account(accountId).objects.keys()).sort();
  }

  async deleteObject(accountId: string, objectKey: string): Promise<void> {
    this.assertOpaqueObjectKey(objectKey);
    this.account(accountId).objects.delete(objectKey);
  }

  snapshot(): HostedCloudBackendSnapshot {
    return {
      accounts: Array.from(this.accounts.entries()).map(([accountId, account]) => ({
        accountId,
        manifestRevision: account.manifestRevision,
        objectKeys: Array.from(account.objects.keys()).sort(),
        totalBytes: this.totalBytes(account),
      })),
    };
  }

  private account(accountId: string): AccountState {
    const existing = this.accounts.get(accountId);
    if (existing) {
      return existing;
    }

    const created: AccountState = {
      manifest: null,
      manifestRevision: 0,
      objects: new Map(),
    };
    this.accounts.set(accountId, created);
    return created;
  }

  private totalBytes(account: AccountState): number {
    return Array.from(account.objects.values()).reduce(
      (total, object) => total + object.byteLength,
      0,
    );
  }

  private revision(value: number): CloudRemoteRevision {
    return { etag: `"${value}"`, versionId: String(value) };
  }

  private cloneManifest(manifest: CloudManifest): CloudManifest {
    return JSON.parse(JSON.stringify(manifest)) as CloudManifest;
  }

  private assertOpaqueObjectKey(objectKey: string): void {
    assertOpaqueHostedObjectKey(objectKey);
  }

  private assertOpaqueManifestObjectKeys(manifest: CloudManifest): void {
    for (const object of manifest.objects) {
      assertOpaqueHostedObjectKey(object.objectKey);
    }
  }
}
