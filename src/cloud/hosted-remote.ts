import type {
  CloudManifestRead,
  CloudRemote,
  CloudRemoteCapabilities,
  CloudRemoteRevision,
} from "./cloud-remote.js";
import type { CloudManifest } from "./cloud-types.js";
import type { HostedCloudBackend } from "./hosted-local-backend.js";

export class HostedCloudRemote implements CloudRemote {
  readonly id = "hosted";
  readonly displayRoot: string;
  readonly capabilities: CloudRemoteCapabilities = {
    atomicManifestWrite: true,
    conditionalManifestWrite: true,
    objectDelete: true,
    objectListing: true,
    objectVersioning: true,
  };

  constructor(
    private readonly input: {
      accountId: string;
      backend: HostedCloudBackend;
      deviceId: string;
    },
  ) {
    this.displayRoot = `hosted://${input.accountId}`;
  }

  async readManifest(): Promise<CloudManifestRead | null> {
    return this.input.backend.readManifest(this.input.accountId);
  }

  async writeManifest(
    manifest: CloudManifest,
    options: { expectedRevision?: CloudRemoteRevision } = {},
  ): Promise<CloudRemoteRevision> {
    return this.input.backend.writeManifest(this.input.accountId, manifest, options);
  }

  async readObject(objectKey: string): Promise<Buffer> {
    return this.input.backend.readObject(this.input.accountId, objectKey);
  }

  async writeObject(objectKey: string, content: Buffer): Promise<void> {
    await this.input.backend.writeObject(this.input.accountId, objectKey, content);
  }

  async listObjects(prefix: "objects"): Promise<string[]> {
    void prefix;
    return this.input.backend.listObjects(this.input.accountId);
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.input.backend.deleteObject(this.input.accountId, objectKey);
  }
}
