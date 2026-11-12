export type CloudObjectManifest = {
  encryptedBytes: number;
  encryptedSha256: string;
  iv: string;
  objectId: string;
  objectKey: string;
  salt: string;
  tag: string;
  version: number;
};

export type CloudManifest = {
  schemaVersion: 1;
  createdAt: string;
  source: "personal-root";
  objects: CloudObjectManifest[];
  tombstones?: Array<{ objectId: string; deletedAt: string; version: number }>;
};

export type EncryptedPayload = {
  ciphertext: Buffer;
  iv: string;
  tag: string;
};

export type CloudBackupResult = {
  remote: string;
  dryRun: boolean;
  wouldUpload: string[];
  wouldSkip: string[];
  conflicts: string[];
  uploaded: string[];
  bytes: number;
};

export type CloudStatusResult = {
  remote: string;
  configured: boolean;
  objects: number;
  capabilities: {
    atomicManifestWrite: boolean;
    conditionalManifestWrite: boolean;
    objectDelete: boolean;
    objectListing: boolean;
    objectVersioning: boolean;
  };
  createdAt?: string;
};

export type CloudRemoteCheckResult = {
  remote: string;
  kind: "filesystem" | "s3";
  configured: boolean;
  safeExistingManifestWrite: boolean;
  capabilities: CloudStatusResult["capabilities"];
  warnings: string[];
};

export type CloudCleanupResult = {
  remote: string;
  dryRun: boolean;
  referencedObjects: string[];
  orphanObjects: string[];
  retainedConflictCopies: string[];
  tombstones: string[];
  wouldDeleteObjects: string[];
  deletedObjects: string[];
};

export type CloudRestoreDryRunResult = {
  remote: string;
  wouldAdd: string[];
  wouldSkip: string[];
  conflicts: string[];
};

export type CloudSyncDryRunResult = {
  remote: string;
  wouldUpload: string[];
  wouldDownload: string[];
  wouldSkip: string[];
  wouldDelete: string[];
  conflicts: string[];
};

export type CloudSyncApplyResult = CloudSyncDryRunResult & {
  applied: boolean;
  dryRun: boolean;
  deleted: string[];
  downloaded: string[];
  uploaded: string[];
};

export type CloudConflictStrategy = "local" | "remote" | "both" | "skip";

export type CloudConflictListResult = {
  remote: string;
  conflicts: string[];
};

export type CloudConflictPreview = {
  bytes: number;
  sha256: string;
  preview: string;
};

export type CloudConflictShowResult = {
  remote: string;
  path: string;
  local: CloudConflictPreview;
  remoteObject: CloudConflictPreview;
};

export type CloudConflictResolveResult = {
  remote: string;
  path: string;
  strategy: CloudConflictStrategy;
  resolved: boolean;
  writtenLocal: string[];
  uploaded: string[];
  skipped: string[];
};

export type CloudSyncStateObject = {
  objectId: string;
  path: string;
  remoteObjectKey: string;
  remoteVersion: number;
  sha256: string;
};

export type CloudSyncTombstone = {
  deletedAt: string;
  objectId: string;
  path: string;
  remoteObjectKey: string;
  remoteVersion: number;
  sha256: string;
};

export type CloudSyncState = {
  schemaVersion: 1;
  remote: string;
  syncedAt: string;
  objects: CloudSyncStateObject[];
  tombstones?: CloudSyncTombstone[];
};
