import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { resolveS3RemoteConfig } from "../../src/cloud/s3-config.js";
import { S3CloudRemote } from "../../src/cloud/s3-remote.js";
import type { CloudManifest } from "../../src/cloud/cloud-types.js";
import { DomainError } from "../../src/domain/errors.js";

class FakeS3Client {
  commands: Array<{ name: string; input: Record<string, unknown> }> = [];
  objects = new Map<string, Buffer>();

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    this.commands.push({ name: command.constructor.name, input: command.input });
    const key = `${command.input.Bucket as string}/${command.input.Key as string}`;
    if (command instanceof PutObjectCommand) {
      this.objects.set(key, Buffer.from(command.input.Body as Uint8Array));
      return { ETag: "\"etag-1\"", VersionId: "version-1" };
    }
    if (command instanceof GetObjectCommand) {
      const body = this.objects.get(key);
      if (!body) {
        throw new NoSuchKey({ $metadata: {}, message: "No such key" });
      }
      return {
        Body: {
          transformToByteArray: async () => body,
        },
        ETag: "\"etag-1\"",
        VersionId: "version-1",
      };
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }
}

function s3Manifest(): CloudManifest {
  return {
    schemaVersion: 1,
    createdAt: "2026-07-03T00:00:00.000Z",
    source: "personal-root",
    objects: [],
  };
}

describe("cloud/s3 config", () => {
  it("resolves S3-compatible config from environment variables", () => {
    expect(
      resolveS3RemoteConfig({
        bucket: "my-bucket",
        prefix: "growth-memory",
        env: {
          GMEM_S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
          GMEM_S3_REGION: "auto",
          GMEM_S3_ACCESS_KEY_ID: "access",
          GMEM_S3_SECRET_ACCESS_KEY: "secret",
          GMEM_S3_FORCE_PATH_STYLE: "true",
        },
      }),
    ).toEqual({
      bucket: "my-bucket",
      prefix: "growth-memory",
      endpoint: "https://example.r2.cloudflarestorage.com",
      region: "auto",
      accessKeyId: "access",
      secretAccessKey: "secret",
      forcePathStyle: true,
    });
  });

  it("fails when required S3 config is missing without leaking secrets", () => {
    try {
      resolveS3RemoteConfig({
        bucket: "my-bucket",
        prefix: "",
        env: {
          GMEM_S3_SECRET_ACCESS_KEY: "should-not-leak",
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: "CLOUD_S3_CONFIG_MISSING" });
      expect(JSON.stringify(error)).not.toContain("should-not-leak");
      return;
    }
    throw new Error("Expected missing S3 config to throw");
  });
});

describe("cloud/s3 remote adapter", () => {
  it.each([
    { name: "PreconditionFailed" },
    { name: "ConditionalRequestConflict" },
    { name: "ProviderSpecificConflict", $metadata: { httpStatusCode: 409 } },
    { name: "ProviderSpecificConflict", $metadata: { httpStatusCode: 412 } },
  ])("normalizes SDK and provider conflict shapes: %j", async (failure) => {
    const remote = new S3CloudRemote({
      bucket: "bucket", prefix: "",
      client: { send: async () => { throw failure; } },
    });
    await expect(remote.writeManifest(s3Manifest())).rejects.toMatchObject({
      code: "CLOUD_MANIFEST_REVISION_CONFLICT",
    });
  });

  it.each([
    { name: "NotImplemented" },
    { name: "ProviderUnsupported", $metadata: { httpStatusCode: 501 } },
  ])("normalizes unsupported conditional operation shapes: %j", async (failure) => {
    const remote = new S3CloudRemote({
      bucket: "bucket", prefix: "",
      client: { send: async () => { throw failure; } },
    });
    await expect(remote.writeManifest(s3Manifest())).rejects.toMatchObject({
      code: "CLOUD_MANIFEST_CONDITIONAL_WRITE_UNSUPPORTED",
    });
  });

  it("preserves the original transport error", async () => {
    const failure = new Error("test connection closed");
    const remote = new S3CloudRemote({
      bucket: "bucket", prefix: "",
      client: { send: async () => { throw failure; } },
    });
    await expect(remote.writeManifest(s3Manifest())).rejects.toBe(failure);
  });

  it("stores manifest and objects under the configured prefix", async () => {
    const client = new FakeS3Client();
    const remote = new S3CloudRemote({
      bucket: "bucket",
      prefix: "growth-memory/prod",
      client,
    });

    await remote.writeObject("abc.bin", Buffer.from("encrypted-object"));
    await remote.writeManifest(s3Manifest());

    expect(client.commands.map((command) => command.input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Bucket: "bucket",
          Key: "growth-memory/prod/objects/abc.bin",
        }),
        expect.objectContaining({
          Bucket: "bucket",
          Key: "growth-memory/prod/manifest.json",
        }),
      ]),
    );
    await expect(remote.readObject("abc.bin")).resolves.toEqual(
      Buffer.from("encrypted-object"),
    );
    await expect(remote.readManifest()).resolves.toMatchObject({
      manifest: s3Manifest(),
      revision: { etag: "\"etag-1\"", versionId: "version-1" },
    });
  });
});
