import { describe, expect, it } from "vitest";

import { HostedCloudRemote } from "../../src/cloud/hosted-remote.js";
import { LocalHostedCloudBackend } from "../../src/cloud/hosted-local-backend.js";
import { DomainError } from "../../src/domain/errors.js";
import type { CloudManifest } from "../../src/cloud/cloud-types.js";

function manifest(objectKey = "object-a.bin"): CloudManifest {
  return {
    schemaVersion: 1,
    createdAt: "2026-07-06T00:00:00.000Z",
    source: "personal-root",
    objects: [
      {
        encryptedBytes: 3,
        encryptedSha256: "abc",
        iv: "iv",
        objectId: "object-a",
        objectKey,
        salt: "salt",
        tag: "tag",
        version: 1,
      },
    ],
  };
}

describe("cloud/hosted-remote", () => {
  it("implements CloudRemote with hosted safety capabilities", async () => {
    const backend = new LocalHostedCloudBackend();
    const remote = new HostedCloudRemote({
      accountId: "acct_123",
      backend,
      deviceId: "dev_abc",
    });

    expect(remote.id).toBe("hosted");
    expect(remote.displayRoot).toBe("hosted://acct_123");
    expect(remote.capabilities).toEqual({
      atomicManifestWrite: true,
      conditionalManifestWrite: true,
      objectDelete: true,
      objectListing: true,
      objectVersioning: true,
    });
    await expect(remote.readManifest()).resolves.toBeNull();
  });

  it("isolates manifest state across writes and reads", async () => {
    const backend = new LocalHostedCloudBackend();
    const remote = new HostedCloudRemote({ accountId: "acct_123", backend, deviceId: "dev_abc" });
    const input = manifest();
    const inputObject = input.objects[0];
    if (!inputObject) {
      throw new Error("expected input manifest object to be present");
    }

    await remote.writeManifest(input);
    inputObject.objectKey = "mutated-after-write.bin";

    const firstRead = await remote.readManifest();
    if (!firstRead) {
      throw new Error("expected manifest to be present");
    }
    const firstObject = firstRead.manifest.objects[0];
    if (!firstObject) {
      throw new Error("expected manifest object to be present");
    }
    expect(firstObject.objectKey).toBe("object-a.bin");

    firstObject.objectKey = "mutated-after-read.bin";
    const secondRead = await remote.readManifest();
    if (!secondRead) {
      throw new Error("expected manifest to be present on reread");
    }
    const secondObject = secondRead.manifest.objects[0];
    if (!secondObject) {
      throw new Error("expected manifest object to be present on reread");
    }
    expect(secondObject.objectKey).toBe("object-a.bin");
    expect(backend.snapshot().accounts[0]?.manifestRevision).toBe(1);
  });

  it("rejects non-opaque object keys", async () => {
    const backend = new LocalHostedCloudBackend();
    const remote = new HostedCloudRemote({ accountId: "acct_123", backend, deviceId: "dev_abc" });
    const invalidManifest = manifest("concepts/foo.md");
    const rejectedWrite = remote.writeManifest(invalidManifest);

    await expect(rejectedWrite).rejects.toBeInstanceOf(DomainError);
    await expect(rejectedWrite).rejects.toMatchObject({
      code: "CLOUD_HOSTED_OBJECT_KEY_INVALID",
    });
    await expect(remote.writeObject("concepts/foo.md", Buffer.from("encrypted"))).rejects.toMatchObject(
      { code: "CLOUD_HOSTED_OBJECT_KEY_INVALID" },
    );
    expect(backend.snapshot().accounts[0]?.objectKeys ?? []).toEqual([]);
    expect(backend.snapshot().accounts[0]?.manifestRevision ?? 0).toBe(0);
    expect(JSON.stringify(backend.snapshot())).not.toContain("concepts/foo.md");
    expect(await remote.readManifest()).toBeNull();
  });

  it("enforces optimistic manifest concurrency", async () => {
    const backend = new LocalHostedCloudBackend();
    const first = new HostedCloudRemote({ accountId: "acct_123", backend, deviceId: "dev_1" });
    const second = new HostedCloudRemote({ accountId: "acct_123", backend, deviceId: "dev_2" });

    const revision = await first.writeManifest(manifest("first.bin"));
    const read = await second.readManifest();
    expect(read).not.toBeNull();
    expect(read?.revision).toEqual(revision);
    await expect(
      first.writeManifest(manifest("updated.bin"), { expectedRevision: revision }),
    ).resolves.toMatchObject({ versionId: "2" });
    await expect(
      second.writeManifest(manifest("stale.bin"), { expectedRevision: read!.revision }),
    ).rejects.toMatchObject({
      code: "CLOUD_MANIFEST_REVISION_CONFLICT",
    });
  });

  it("lists and deletes hosted object payloads", async () => {
    const backend = new LocalHostedCloudBackend();
    const remote = new HostedCloudRemote({ accountId: "acct_123", backend, deviceId: "dev_abc" });
    await remote.writeObject("b.bin", Buffer.from("b"));
    await remote.writeObject("a.bin", Buffer.from("a"));

    await expect(remote.listObjects?.("objects")).resolves.toEqual(["a.bin", "b.bin"]);
    await remote.deleteObject?.("a.bin");
    await expect(remote.listObjects?.("objects")).resolves.toEqual(["b.bin"]);
  });

  it("rejects uploads that exceed hosted quota", async () => {
    const backend = new LocalHostedCloudBackend({
      maxObjectBytes: 2,
      maxObjects: 10,
      maxTotalBytes: 10,
    });
    const remote = new HostedCloudRemote({ accountId: "acct_123", backend, deviceId: "dev_abc" });

    await expect(remote.writeObject("too-large.bin", Buffer.from("abc"))).rejects.toMatchObject({
      code: "CLOUD_QUOTA_EXCEEDED",
    });
  });

  it("rejects uploads that exceed the hosted object count quota", async () => {
    const backend = new LocalHostedCloudBackend({
      maxObjectBytes: 10,
      maxObjects: 1,
      maxTotalBytes: 10,
    });
    const remote = new HostedCloudRemote({ accountId: "acct_123", backend, deviceId: "dev_abc" });

    await remote.writeObject("a.bin", Buffer.from("a"));
    await expect(remote.writeObject("b.bin", Buffer.from("b"))).rejects.toMatchObject({
      code: "CLOUD_QUOTA_EXCEEDED",
    });
  });

  it("rejects uploads that exceed the hosted total bytes quota", async () => {
    const backend = new LocalHostedCloudBackend({
      maxObjectBytes: 10,
      maxObjects: 10,
      maxTotalBytes: 3,
    });
    const remote = new HostedCloudRemote({ accountId: "acct_123", backend, deviceId: "dev_abc" });

    await remote.writeObject("a.bin", Buffer.from("ab"));
    await expect(remote.writeObject("b.bin", Buffer.from("cd"))).rejects.toMatchObject({
      code: "CLOUD_QUOTA_EXCEEDED",
    });
  });
});
