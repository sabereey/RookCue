import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { S3Client } from "@aws-sdk/client-s3";

type StoredObject = { body: Buffer; etag: string };

export async function createS3Endpoint() {
  const objects = new Map<string, StoredObject>();
  const requests: Array<{
    method: string;
    path: string;
    ifMatch: string | undefined;
    ifNoneMatch: string | undefined;
  }> = [];
  const control: {
    beforeManifestPut?: () => void;
    failure?: { status: number; code: string };
    omitEtag?: boolean;
  } = {};
  function store(path: string, body: Buffer): StoredObject {
    const object = {
      body,
      etag: `"${createHash("sha256").update(body).digest("hex")}"`,
    };
    objects.set(path, object);
    return object;
  }

  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    requests.push({
      method: request.method!,
      path,
      ifMatch: request.headers["if-match"] as string | undefined,
      ifNoneMatch: request.headers["if-none-match"] as string | undefined,
    });
    const fail = (status: number, code: string) => {
      response.writeHead(status, { "Content-Type": "application/xml" });
      response.end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
    };
    try {
      if (request.method === "GET") {
        const object = objects.get(path);
        if (!object) return fail(404, "NoSuchKey");
        response.writeHead(200, control.omitEtag ? {} : { ETag: object.etag });
        response.end(object.body);
        return;
      }
      if (request.method !== "PUT") return fail(405, "MethodNotAllowed");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (path.endsWith("/manifest.json")) {
        const before = control.beforeManifestPut;
        delete control.beforeManifestPut;
        before?.();
        if (control.failure) return fail(control.failure.status, control.failure.code);
      }
      const current = objects.get(path);
      if (request.headers["if-none-match"] === "*" && current) {
        return fail(412, "PreconditionFailed");
      }
      if (request.headers["if-match"] && request.headers["if-match"] !== current?.etag) {
        return fail(412, "PreconditionFailed");
      }
      const object = store(path, Buffer.concat(chunks));
      response.writeHead(200, { ETag: object.etag });
      response.end();
    } catch {
      fail(500, "InternalError");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new S3Client({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "test-access", secretAccessKey: "test-secret" },
    forcePathStyle: true,
    maxAttempts: 1,
  });
  return {
    endpoint, client, objects, requests, control, store,
    async close() {
      client.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
