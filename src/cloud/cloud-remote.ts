import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { S3Client } from "@aws-sdk/client-s3";

import { DomainError } from "../domain/errors.js";
import type { CloudManifest } from "./cloud-types.js";
import { FilesystemCloudRemote } from "./filesystem-remote.js";
import { resolveS3RemoteConfig } from "./s3-config.js";
import { S3CloudRemote } from "./s3-remote.js";

export type CloudRemoteRevision = {
  etag?: string;
  versionId?: string;
};

export type CloudManifestRead = {
  manifest: CloudManifest;
  revision: CloudRemoteRevision;
};

export type CloudRemoteCapabilities = {
  atomicManifestWrite: boolean;
  conditionalManifestWrite: boolean;
  objectDelete: boolean;
  objectListing: boolean;
  objectVersioning: boolean;
};

export interface CloudRemote {
  readonly id: string;
  readonly displayRoot: string;
  readonly capabilities: CloudRemoteCapabilities;
  readManifest(): Promise<CloudManifestRead | null>;
  writeManifest(
    manifest: CloudManifest,
    options?: { expectedRevision?: CloudRemoteRevision },
  ): Promise<CloudRemoteRevision>;
  readObject(objectKey: string): Promise<Buffer>;
  writeObject(objectKey: string, content: Buffer): Promise<void>;
  listObjects?(prefix: "objects"): Promise<string[]>;
  deleteObject?(objectKey: string): Promise<void>;
}

export type CloudRemoteTarget =
  | { kind: "filesystem"; path: string }
  | { kind: "s3"; bucket: string; prefix: string };

export function parseCloudRemoteTarget(target: string): CloudRemoteTarget {
  if (target === "hosted") {
    throw new DomainError(
      "CLOUD_REMOTE_SCHEME_UNSUPPORTED",
      "The hosted remote is not available; configure a user-owned filesystem or S3 remote",
      { remote: target },
    );
  }
  if (!target.includes("://")) {
    return { kind: "filesystem", path: resolve(target) };
  }

  const url = new URL(target);
  if (url.protocol === "file:") {
    return { kind: "filesystem", path: fileURLToPath(url) };
  }
  if (url.protocol === "s3:") {
    if (!url.hostname) {
      throw new DomainError("CLOUD_S3_CONFIG_MISSING", "S3 remote bucket is required", {
        remote: target,
      });
    }
    return {
      kind: "s3",
      bucket: url.hostname,
      prefix: normalizeS3Prefix(url.pathname),
    };
  }

  throw new DomainError(
    "CLOUD_REMOTE_SCHEME_UNSUPPORTED",
    `Unsupported cloud remote scheme: ${url.protocol.replace(":", "")}`,
    { remote: target },
  );
}

export function resolveCloudRemote(input: {
  target: string;
  env?: NodeJS.ProcessEnv;
}): CloudRemote {
  const parsed = parseCloudRemoteTarget(input.target);
  if (parsed.kind === "filesystem") {
    return new FilesystemCloudRemote(parsed.path);
  }
  const config = resolveS3RemoteConfig({
    bucket: parsed.bucket,
    prefix: parsed.prefix,
    ...(input.env ? { env: input.env } : {}),
  });
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  });
  return new S3CloudRemote({
    bucket: config.bucket,
    prefix: config.prefix,
    client,
  });
}

function normalizeS3Prefix(pathname: string): string {
  return pathname.replace(/^\/+/, "").replace(/\/+$/, "");
}
