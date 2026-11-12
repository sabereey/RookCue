import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { DomainError } from "../domain/errors.js";
import type {
  CloudManifestRead,
  CloudRemote,
  CloudRemoteCapabilities,
  CloudRemoteRevision,
} from "./cloud-remote.js";
import type { CloudManifest } from "./cloud-types.js";

type S3ClientLike = Pick<S3Client, "send">;

export class S3CloudRemote implements CloudRemote {
  readonly id = "s3";
  readonly displayRoot: string;
  readonly capabilities: CloudRemoteCapabilities = {
    atomicManifestWrite: false,
    conditionalManifestWrite: true,
    objectDelete: false,
    objectListing: false,
    objectVersioning: true,
  };

  constructor(
    private readonly input: {
      bucket: string;
      prefix: string;
      client: S3ClientLike;
    },
  ) {
    this.displayRoot = `s3://${input.bucket}${input.prefix ? `/${input.prefix}` : ""}`;
  }

  async readManifest(): Promise<CloudManifestRead | null> {
    try {
      const response = await this.input.client.send(
        new GetObjectCommand({
          Bucket: this.input.bucket,
          Key: this.key("manifest.json"),
        }),
      );
      const bytes = await response.Body?.transformToByteArray();
      if (!bytes) {
        throw new DomainError(
          "CLOUD_S3_OBJECT_NOT_FOUND",
          "S3 remote manifest body was empty",
          { remote: this.displayRoot },
        );
      }
      return {
        manifest: JSON.parse(Buffer.from(bytes).toString("utf8")) as CloudManifest,
        revision: {
          ...(response.ETag ? { etag: response.ETag } : {}),
          ...(response.VersionId ? { versionId: response.VersionId } : {}),
        },
      };
    } catch (error) {
      if (isS3NotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async writeManifest(
    manifest: CloudManifest,
    options: { expectedRevision?: CloudRemoteRevision } = {},
  ): Promise<CloudRemoteRevision> {
    const expectedEtag = options.expectedRevision?.etag;
    if (options.expectedRevision && !expectedEtag?.trim()) {
      throw new DomainError(
        "CLOUD_MANIFEST_REVISION_REQUIRED",
        "Updating an S3 manifest requires its observed ETag; reread the remote before retrying",
        { remote: this.displayRoot },
      );
    }
    try {
      const response = await this.input.client.send(
        new PutObjectCommand({
          Bucket: this.input.bucket,
          Key: this.key("manifest.json"),
          Body: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
          ContentType: "application/json; charset=utf-8",
          ...(options.expectedRevision
            ? { IfMatch: expectedEtag }
            : { IfNoneMatch: "*" }),
        }),
      );
      return {
        ...(response.ETag ? { etag: response.ETag } : {}),
        ...(response.VersionId ? { versionId: response.VersionId } : {}),
      };
    } catch (error) {
      if (typeof error === "object" && error !== null) {
        const { name, $metadata } = error as {
          name?: string;
          $metadata?: { httpStatusCode?: number };
        };
        if (name === "PreconditionFailed" || name === "ConditionalRequestConflict" ||
            $metadata?.httpStatusCode === 409 || $metadata?.httpStatusCode === 412) {
          throw new DomainError(
            "CLOUD_MANIFEST_REVISION_CONFLICT",
            "S3 cloud manifest changed; reread the remote and recompute the sync plan before retrying",
            { remote: this.displayRoot },
          );
        }
        if (name === "NotImplemented" || $metadata?.httpStatusCode === 501) {
          throw new DomainError(
            "CLOUD_MANIFEST_CONDITIONAL_WRITE_UNSUPPORTED",
            "This S3 provider does not support conditional manifest writes; use a provider that honors If-Match and If-None-Match",
            { remote: this.displayRoot },
          );
        }
      }
      throw error;
    }
  }

  async readObject(objectKey: string): Promise<Buffer> {
    try {
      const response = await this.input.client.send(
        new GetObjectCommand({
          Bucket: this.input.bucket,
          Key: this.key(`objects/${objectKey}`),
        }),
      );
      const bytes = await response.Body?.transformToByteArray();
      if (!bytes) {
        throw new DomainError(
          "CLOUD_S3_OBJECT_NOT_FOUND",
          "S3 remote object body was empty",
          { objectKey, remote: this.displayRoot },
        );
      }
      return Buffer.from(bytes);
    } catch (error) {
      if (isS3NotFound(error)) {
        throw new DomainError(
          "CLOUD_S3_OBJECT_NOT_FOUND",
          "S3 remote object was not found",
          { objectKey, remote: this.displayRoot },
        );
      }
      throw error;
    }
  }

  async writeObject(objectKey: string, content: Buffer): Promise<void> {
    await this.input.client.send(
      new PutObjectCommand({
        Bucket: this.input.bucket,
        Key: this.key(`objects/${objectKey}`),
        Body: content,
        ContentType: "application/octet-stream",
      }),
    );
  }

  private key(path: string): string {
    return [this.input.prefix, path].filter(Boolean).join("/");
  }
}

function isS3NotFound(error: unknown): boolean {
  return error instanceof NoSuchKey ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "NoSuchKey");
}
