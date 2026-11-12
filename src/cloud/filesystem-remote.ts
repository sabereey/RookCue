import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";

import { DomainError } from "../domain/errors.js";
import { writeTextAtomic } from "../storage/files.js";
import type { CloudManifest } from "./cloud-types.js";
import type {
  CloudManifestRead,
  CloudRemote,
  CloudRemoteCapabilities,
  CloudRemoteRevision,
} from "./cloud-remote.js";
import { safeChildPath } from "../storage/paths.js";
import { withRootLock } from "../storage/root-lock.js";

export class FilesystemCloudRemote implements CloudRemote {
  readonly id = "filesystem";
  readonly displayRoot: string;
  readonly capabilities: CloudRemoteCapabilities = {
    atomicManifestWrite: true,
    conditionalManifestWrite: true,
    objectDelete: true,
    objectListing: true,
    objectVersioning: false,
  };

  constructor(public readonly root: string) {
    this.displayRoot = root;
  }

  async readManifest(): Promise<CloudManifestRead | null> {
    try {
      const content = await readFile(this.manifestPath());
      return {
        manifest: JSON.parse(content.toString("utf8")) as CloudManifest,
        revision: { etag: digest(content) },
      };
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async writeManifest(
    manifest: CloudManifest,
    options: { expectedRevision?: CloudRemoteRevision } = {},
  ): Promise<CloudRemoteRevision> {
    return withRootLock(this.root, async () => {
      const current = await this.readManifest();
      const expectedEtag = options.expectedRevision?.etag;
      if (expectedEtag && current?.revision.etag !== expectedEtag) {
        throw new DomainError(
          "CLOUD_MANIFEST_REVISION_CONFLICT",
          "Filesystem cloud manifest revision changed",
          { remote: this.displayRoot },
        );
      }

      const content = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeTextAtomic(this.manifestPath(), content);
      return { etag: digest(Buffer.from(content, "utf8")) };
    });
  }

  async readObject(objectKey: string): Promise<Buffer> {
    return readFile(this.objectPath(objectKey));
  }

  async writeObject(objectKey: string, content: Buffer): Promise<void> {
    await mkdir(safeChildPath(this.root, "objects"), { recursive: true });
    await writeFile(this.objectPath(objectKey), content);
  }

  async listObjects(prefix: "objects"): Promise<string[]> {
    try {
      const entries = await readdir(safeChildPath(this.root, prefix), {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isFile() && !entry.name.startsWith("._"))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (isFileNotFound(error)) {
        return [];
      }
      throw error;
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    await rm(this.objectPath(objectKey), { force: true });
  }

  private manifestPath(): string {
    return safeChildPath(this.root, "manifest.json");
  }

  private objectPath(objectKey: string): string {
    return safeChildPath(safeChildPath(this.root, "objects"), objectKey);
  }
}

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isFileNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
