import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearHostedSession,
  hostedCloudDir,
  listHostedDevices,
  readHostedSession,
  revokeHostedDevice,
  saveHostedDevice,
  writeHostedSession,
} from "../../src/cloud/hosted-session.js";

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createPersonalRoot() {
  const root = await mkdtemp(join(tmpdir(), "growth-memory-hosted-session-"));
  createdPaths.push(root);
  return root;
}

describe("cloud/hosted-session", () => {
  it("stores hosted session under the personal cloud config directory", async () => {
    const personalRoot = await createPersonalRoot();

    await writeHostedSession(personalRoot, {
      accountId: "acct_123",
      createdAt: "2026-07-06T00:00:00.000Z",
      deviceId: "dev_abc",
      endpoint: "https://hosted.example.test",
      token: "token-secret",
    });

    await expect(readHostedSession(personalRoot)).resolves.toEqual({
      accountId: "acct_123",
      createdAt: "2026-07-06T00:00:00.000Z",
      deviceId: "dev_abc",
      endpoint: "https://hosted.example.test",
      token: "token-secret",
    });
    await expect(readFile(join(hostedCloudDir(personalRoot), "session.json"), "utf8")).resolves.toContain("acct_123");
  });

  it("clears hosted session without touching hosted devices", async () => {
    const personalRoot = await createPersonalRoot();
    await writeHostedSession(personalRoot, {
      accountId: "acct_123",
      createdAt: "2026-07-06T00:00:00.000Z",
      deviceId: "dev_abc",
      endpoint: "https://hosted.example.test",
      token: "token-secret",
    });
    await saveHostedDevice(personalRoot, {
      createdAt: "2026-07-06T00:00:00.000Z",
      deviceId: "dev_abc",
      label: "Work laptop",
      lastSeenAt: "2026-07-06T00:00:00.000Z",
      revoked: false,
    });

    await clearHostedSession(personalRoot);

    await expect(readHostedSession(personalRoot)).resolves.toBeNull();
    await expect(listHostedDevices(personalRoot)).resolves.toHaveLength(1);
  });

  it("stores hosted session tokens with owner-only permissions", async () => {
    const personalRoot = await createPersonalRoot();
    await writeHostedSession(personalRoot, {
      accountId: "acct_123",
      createdAt: "2026-07-06T00:00:00.000Z",
      deviceId: "dev_abc",
      endpoint: "https://hosted.example.test",
      token: "token-secret",
    });

    const details = await stat(join(hostedCloudDir(personalRoot), "session.json"));

    expect(details.mode & 0o777).toBe(0o600);
  });

  it("lists and revokes hosted devices without storing local paths", async () => {
    const personalRoot = await createPersonalRoot();
    await saveHostedDevice(personalRoot, {
      createdAt: "2026-07-06T00:00:00.000Z",
      deviceId: "dev_abc",
      label: "Work laptop",
      lastSeenAt: "2026-07-06T01:00:00.000Z",
      revoked: false,
    });

    await expect(
      revokeHostedDevice(personalRoot, "dev_abc", "2026-07-06T02:00:00.000Z"),
    ).resolves.toMatchObject({
      deviceId: "dev_abc",
      revoked: true,
      revokedAt: "2026-07-06T02:00:00.000Z",
    });
    const devices = await listHostedDevices(personalRoot);
    expect(JSON.stringify(devices)).not.toContain("/Users/");
    expect(devices).toEqual([
      {
        createdAt: "2026-07-06T00:00:00.000Z",
        deviceId: "dev_abc",
        label: "Work laptop",
        lastSeenAt: "2026-07-06T01:00:00.000Z",
        revoked: true,
        revokedAt: "2026-07-06T02:00:00.000Z",
      },
    ]);
  });
});
