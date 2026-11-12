import { readFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";

import { DomainError } from "../domain/errors.js";
import { safeChildPath } from "../storage/paths.js";

export type HostedCloudSession = {
  accountId: string;
  createdAt: string;
  deviceId: string;
  endpoint: string;
  token: string;
};

export type HostedCloudDevice = {
  createdAt: string;
  deviceId: string;
  label: string;
  lastSeenAt: string;
  revoked: boolean;
  revokedAt?: string;
};

export function hostedCloudDir(personalRoot: string): string {
  return safeChildPath(safeChildPath(personalRoot, ".cloud"), "hosted");
}

export async function readHostedSession(
  personalRoot: string,
): Promise<HostedCloudSession | null> {
  try {
    return JSON.parse(await readFile(sessionPath(personalRoot), "utf8")) as HostedCloudSession;
  } catch (error) {
    if (isFileNotFound(error)) {
      return null;
    }
    throw error;
  }
}

export function readHostedSessionSync(personalRoot: string): HostedCloudSession | null {
  try {
    return JSON.parse(readFileSync(sessionPath(personalRoot), "utf8")) as HostedCloudSession;
  } catch (error) {
    if (isFileNotFound(error)) {
      return null;
    }
    throw error;
  }
}

export async function writeHostedSession(
  personalRoot: string,
  session: HostedCloudSession,
): Promise<void> {
  await mkdir(hostedCloudDir(personalRoot), { recursive: true });
  const path = sessionPath(personalRoot);
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

export async function clearHostedSession(personalRoot: string): Promise<void> {
  await rm(sessionPath(personalRoot), { force: true });
}

export async function listHostedDevices(personalRoot: string): Promise<HostedCloudDevice[]> {
  try {
    const dir = devicesDir(personalRoot);
    const entries = await readdir(dir, { withFileTypes: true });
    const devices = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) =>
          JSON.parse(await readFile(safeChildPath(dir, entry.name), "utf8")) as HostedCloudDevice,
        ),
    );
    return devices.sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  } catch (error) {
    if (isFileNotFound(error)) {
      return [];
    }
    throw error;
  }
}

export async function saveHostedDevice(
  personalRoot: string,
  device: HostedCloudDevice,
): Promise<void> {
  await mkdir(devicesDir(personalRoot), { recursive: true });
  await writeFile(
    safeChildPath(devicesDir(personalRoot), `${device.deviceId}.json`),
    `${JSON.stringify(device, null, 2)}\n`,
    "utf8",
  );
}

export async function revokeHostedDevice(
  personalRoot: string,
  deviceId: string,
  revokedAt: string,
): Promise<HostedCloudDevice> {
  const device = (await listHostedDevices(personalRoot)).find(
    (candidate) => candidate.deviceId === deviceId,
  );
  if (!device) {
    throw new DomainError("CLOUD_DEVICE_NOT_FOUND", "Hosted cloud device was not found", {
      deviceId,
    });
  }
  const revoked = { ...device, revoked: true, revokedAt };
  await saveHostedDevice(personalRoot, revoked);
  return revoked;
}

function sessionPath(personalRoot: string): string {
  return safeChildPath(hostedCloudDir(personalRoot), "session.json");
}

function devicesDir(personalRoot: string): string {
  return safeChildPath(hostedCloudDir(personalRoot), "devices");
}

function isFileNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
