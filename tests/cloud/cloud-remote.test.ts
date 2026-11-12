import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseCloudRemoteTarget,
  resolveCloudRemote,
} from "../../src/cloud/cloud-remote.js";
import { FilesystemCloudRemote } from "../../src/cloud/filesystem-remote.js";
import { S3CloudRemote } from "../../src/cloud/s3-remote.js";
import type { CloudManifest } from "../../src/cloud/cloud-types.js";
import { DomainError } from "../../src/domain/errors.js";

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createRemote() {
  const root = await mkdtemp(join(tmpdir(), "growth-memory-remote-interface-"));
  createdPaths.push(root);
  return { root, remote: new FilesystemCloudRemote(root) };
}

function manifest(): CloudManifest {
  return {
    schemaVersion: 1,
    createdAt: "2026-07-03T00:00:00.000Z",
    source: "personal-root",
    objects: [],
  };
}

describe("cloud/remote filesystem adapter", () => {
  it("implements the shared cloud remote interface", async () => {
    const { remote, root } = await createRemote();

    expect(remote.id).toBe("filesystem");
    expect(remote.displayRoot).toBe(root);
    expect(remote.capabilities).toEqual({
      atomicManifestWrite: true,
      conditionalManifestWrite: true,
      objectDelete: true,
      objectListing: true,
      objectVersioning: false,
    });

    await expect(remote.readManifest()).resolves.toBeNull();
    await expect(remote.writeManifest(manifest())).resolves.toMatchObject({ etag: expect.any(String) });
    await expect(remote.readManifest()).resolves.toMatchObject({
      manifest: manifest(),
      revision: { etag: expect.any(String) },
    });
  });

  it("rejects a filesystem manifest write made from a stale revision", async () => {
    const { remote } = await createRemote();
    await remote.writeManifest(manifest());
    const stale = await remote.readManifest();
    if (!stale) {
      throw new Error("Expected filesystem manifest");
    }

    await remote.writeManifest({ ...manifest(), createdAt: "2026-07-03T00:01:00.000Z" });

    await expect(
      remote.writeManifest(
        { ...manifest(), createdAt: "2026-07-03T00:02:00.000Z" },
        { expectedRevision: stale.revision },
      ),
    ).rejects.toMatchObject({ code: "CLOUD_MANIFEST_REVISION_CONFLICT" });
  });

  it("preserves the existing filesystem object layout", async () => {
    const { remote, root } = await createRemote();

    await remote.writeObject("abc.bin", Buffer.from("encrypted"));

    await expect(readFile(join(root, "objects", "abc.bin"), "utf8")).resolves.toBe(
      "encrypted",
    );
    await expect(remote.readObject("abc.bin")).resolves.toEqual(Buffer.from("encrypted"));
  });

  it("lists encrypted filesystem object payloads", async () => {
    const { remote, root } = await createRemote();
    await remote.writeObject("a.bin", Buffer.from("a"));
    await remote.writeObject("b.bin", Buffer.from("b"));

    await expect(remote.listObjects?.("objects")).resolves.toEqual(["a.bin", "b.bin"]);
    await expect(readdir(join(root, "objects"))).resolves.toEqual(["a.bin", "b.bin"]);
  });

  it("deletes encrypted filesystem object payloads", async () => {
    const { remote, root } = await createRemote();
    await remote.writeObject("stale.bin", Buffer.from("stale"));

    await remote.deleteObject?.("stale.bin");

    await expect(readFile(join(root, "objects", "stale.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports s3 cleanup capabilities for this wave", () => {
    const remote = new S3CloudRemote({
      bucket: "bucket",
      prefix: "growth-memory",
      client: { send: async () => ({}) },
    });

    expect(remote.capabilities).toEqual({
      atomicManifestWrite: false,
      conditionalManifestWrite: true,
      objectDelete: false,
      objectListing: false,
      objectVersioning: true,
    });
  });

  it("fails closed when an S3 manifest update has no observed ETag", async () => {
    const remote = new S3CloudRemote({
      bucket: "bucket",
      prefix: "growth-memory",
      client: { send: async () => ({}) },
    });

    await expect(
      remote.writeManifest(manifest(), { expectedRevision: { versionId: "version-only" } }),
    ).rejects.toMatchObject({ code: "CLOUD_MANIFEST_REVISION_REQUIRED" });
  });
});

describe("cloud remote target parsing", () => {
  it("parses native filesystem targets without a scheme", () => {
    const remoteRoot = join(tmpdir(), "gmem-remote");

    expect(parseCloudRemoteTarget(remoteRoot)).toEqual({
      kind: "filesystem",
      path: remoteRoot,
    });
  });

  it("parses native file URL targets as filesystem targets", () => {
    const remoteRoot = join(tmpdir(), "gmem-remote");

    expect(parseCloudRemoteTarget(pathToFileURL(remoteRoot).href)).toEqual({
      kind: "filesystem",
      path: remoteRoot,
    });
  });

  it("keeps native filesystem targets and their file URLs equivalent", () => {
    const remoteRoot = join(tmpdir(), "growth-memory-native-remote");

    expect(parseCloudRemoteTarget(remoteRoot)).toEqual(
      parseCloudRemoteTarget(pathToFileURL(remoteRoot).href),
    );
  });

  it("parses S3-compatible targets", () => {
    expect(parseCloudRemoteTarget("s3://my-bucket/growth-memory/prod")).toEqual({
      kind: "s3",
      bucket: "my-bucket",
      prefix: "growth-memory/prod",
    });
  });

  it("rejects the retired hosted target", () => {
    expect(() => parseCloudRemoteTarget("hosted")).toThrow(DomainError);
    try {
      parseCloudRemoteTarget("hosted");
    } catch (error) {
      expect(error).toMatchObject({ code: "CLOUD_REMOTE_SCHEME_UNSUPPORTED" });
    }
  });

  it("normalizes S3 targets without a prefix", () => {
    expect(parseCloudRemoteTarget("s3://my-bucket")).toEqual({
      kind: "s3",
      bucket: "my-bucket",
      prefix: "",
    });
  });

  it("rejects unsupported remote schemes", () => {
    expect(() => parseCloudRemoteTarget("webdav://example.com/gmem")).toThrow(
      DomainError,
    );
    try {
      parseCloudRemoteTarget("webdav://example.com/gmem");
    } catch (error) {
      expect(error).toMatchObject({
        code: "CLOUD_REMOTE_SCHEME_UNSUPPORTED",
      });
    }
  });

  it("resolves filesystem remotes", () => {
    const remoteRoot = join(tmpdir(), "gmem-remote");
    const remote = resolveCloudRemote({ target: remoteRoot });

    expect(remote.id).toBe("filesystem");
    expect(remote.displayRoot).toBe(remoteRoot);
  });

  it("resolves S3-compatible remotes from env config", () => {
    const remote = resolveCloudRemote({
      target: "s3://my-bucket/growth-memory",
      env: {
        GMEM_S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
        GMEM_S3_REGION: "auto",
        GMEM_S3_ACCESS_KEY_ID: "access",
        GMEM_S3_SECRET_ACCESS_KEY: "secret",
      },
    });

    expect(remote.id).toBe("s3");
    expect(remote.displayRoot).toBe("s3://my-bucket/growth-memory");
  });
});
