import {portableObservation,portableReview,portableCapabilities,portableConcept} from '../fixtures/growth-assets.js';
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudService, PersonalRepository, resolvePaths } from "../../src/index.js";
import { S3CloudRemote } from "../../src/cloud/s3-remote.js";
import { createS3Endpoint } from "../fixtures/s3-endpoint.js";

const manifestPath = "/bucket/growth-memory/manifest.json";
const remoteTarget = "s3://bucket/growth-memory";
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const endpoint = await createS3Endpoint();
  cleanup.push(() => endpoint.close());
  const remote = new S3CloudRemote({ bucket: "bucket", prefix: "growth-memory", client: endpoint.client });
  return { ...endpoint, remote };
}

function manifest(createdAt = "2026-10-27T00:00:00.000Z") {
  return { schemaVersion: 1 as const, createdAt, source: "personal-root" as const, objects: [] };
}

async function device() {
  const root = await mkdtemp(join(tmpdir(), "gmem-s3-device-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolvePaths(join(root, "project"), join(root, "personal"));
  const repository = new PersonalRepository(paths);
  const service = new CloudService(repository, { clock: () => new Date("2026-10-27T00:00:00.000Z") });
  return { paths, repository, service, statePath: join(paths.personal.base, ".cloud", "state.json") };
}

function configure(endpoint: string) {
  vi.stubEnv("GMEM_S3_ENDPOINT", endpoint);
  vi.stubEnv("GMEM_S3_REGION", "us-east-1");
  vi.stubEnv("GMEM_S3_ACCESS_KEY_ID", "test-access");
  vi.stubEnv("GMEM_S3_SECRET_ACCESS_KEY", "test-secret");
  vi.stubEnv("GMEM_S3_FORCE_PATH_STYLE", "true");
}

async function pairedDevices() {
  const f = await fixture();
  configure(f.endpoint);
  const a = await device();
  const b = await device();
  for (const name of ["x", "y", "z"]) {
    await a.repository.writePersonalFile(`concepts/${name}.md`, Buffer.from(`base-${name}`));
  }
  await a.service.backup({ remoteTarget, passphrase: "test-passphrase", dryRun: false });
  await b.service.syncApply({ remoteTarget, passphrase: "test-passphrase" });
  return { f, a, b };
}

describe("S3 conditional manifests over the AWS SDK transport", () => {
  it("lets only one of two first writers publish a manifest", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      f.remote.writeManifest(manifest()),
      f.remote.writeManifest(manifest("2026-10-27T01:00:00.000Z")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "CLOUD_MANIFEST_REVISION_CONFLICT" },
    });
    expect(f.requests.filter((r) => r.method === "PUT")).toEqual([
      expect.objectContaining({ ifNoneMatch: "*", ifMatch: undefined }),
      expect.objectContaining({ ifNoneMatch: "*", ifMatch: undefined }),
    ]);
  });

  it("updates the observed ETag and preserves the winner when a stale device writes", async () => {
    const f = await fixture();
    await f.remote.writeManifest(manifest());
    const observed = (await f.remote.readManifest())!;
    const winner = manifest("2026-10-27T02:00:00.000Z");
    await expect(f.remote.writeManifest(winner, { expectedRevision: observed.revision })).resolves.toHaveProperty("etag");
    await expect(f.remote.writeManifest(manifest("2026-10-27T03:00:00.000Z"), {
      expectedRevision: observed.revision,
    })).rejects.toMatchObject({ code: "CLOUD_MANIFEST_REVISION_CONFLICT" });
    expect(f.requests.at(-1)).toMatchObject({ ifMatch: observed.revision.etag, ifNoneMatch: undefined });
    expect((await f.remote.readManifest())!.manifest).toEqual(winner);
  });

  it.each([{}, { etag: "" }, { etag: "   " }, { versionId: "version-only" }])(
    "rejects an update without a usable ETag before sending a PUT: %j", async (revision) => {
      const f = await fixture();
      await expect(f.remote.writeManifest(manifest(), { expectedRevision: revision })).rejects.toMatchObject({
        code: "CLOUD_MANIFEST_REVISION_REQUIRED",
      });
      expect(f.requests).toHaveLength(0);
    },
  );

  it.each([
    { status: 409, code: "ConditionalRequestConflict" },
    { status: 412, code: "PreconditionFailed" },
  ])("reports a concurrent write without retrying or dropping its condition: $status", async (failure) => {
    const f = await fixture();
    f.control.failure = failure;
    await expect(f.remote.writeManifest(manifest())).rejects.toMatchObject({
      code: "CLOUD_MANIFEST_REVISION_CONFLICT",
    });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.ifNoneMatch).toBe("*");
  });

  it("reports unsupported conditional operations without an unconditional retry", async () => {
    const f = await fixture();
    f.control.failure = { status: 501, code: "NotImplemented" };
    await expect(f.remote.writeManifest(manifest())).rejects.toMatchObject({
      code: "CLOUD_MANIFEST_CONDITIONAL_WRITE_UNSUPPORTED",
    });
    expect(f.requests).toHaveLength(1);
    expect(f.objects.has(manifestPath)).toBe(false);
  });

  it("preserves authorization errors instead of labeling them revision conflicts", async () => {
    const f = await fixture();
    f.control.failure = { status: 403, code: "AccessDenied" };
    await expect(f.remote.writeManifest(manifest())).rejects.toMatchObject({ name: "AccessDenied" });
    expect(f.objects.has(manifestPath)).toBe(false);
  });
});

describe("S3 encrypted service synchronization", () => {
  it.each(["local", "remote", "both"] as const)(
    "preserves unrelated sync baselines when resolving one conflict with %s", async (strategy) => {
      const { a, b } = await pairedDevices();
      await b.repository.writePersonalFile("concepts/x.md", Buffer.from("remote-x"));
      await b.repository.writePersonalFile("concepts/y.md", Buffer.from("remote-y"));
      await b.repository.writePersonalFile("concepts/new.md", Buffer.from("remote-new"));
      await b.service.syncApply({ remoteTarget, passphrase: "test-passphrase" });
      await a.repository.writePersonalFile("concepts/x.md", Buffer.from("local-x"));
      await a.service.resolveConflict({ remoteTarget, passphrase: "test-passphrase", path: "concepts/x.md", strategy });
      await expect(a.service.syncDryRun({ remoteTarget, passphrase: "test-passphrase" })).resolves.toMatchObject({
        wouldDownload: ["concepts/new.md", "concepts/y.md"],
        wouldUpload: [], wouldDelete: [], conflicts: [],
      });
      await a.service.syncApply({ remoteTarget, passphrase: "test-passphrase" });
      await expect(a.repository.readPersonalFile("concepts/y.md")).resolves.toEqual(Buffer.from("remote-y"));
      const c = await device();
      await c.service.syncApply({ remoteTarget, passphrase: "test-passphrase" });
      await expect(c.repository.readPersonalFile("concepts/y.md")).resolves.toEqual(Buffer.from("remote-y"));
      await expect(c.repository.readPersonalFile("concepts/new.md")).resolves.toEqual(Buffer.from("remote-new"));
    },
  );

  it.each(["local", "both"] as const)(
    "preserves remote tombstones when resolving an unrelated conflict with %s", async (strategy) => {
      const { f, a, b } = await pairedDevices();
      await b.repository.writePersonalFile("concepts/x.md", Buffer.from("remote-x"));
      await b.repository.removePersonalFile("concepts/z.md");
      await b.service.syncApply({ remoteTarget, passphrase: "test-passphrase" });
      const deleted = JSON.parse(f.objects.get(manifestPath)!.body.toString()).tombstones;
      expect(deleted).toHaveLength(1);
      await a.repository.writePersonalFile("concepts/x.md", Buffer.from("local-x"));
      await a.service.resolveConflict({ remoteTarget, passphrase: "test-passphrase", path: "concepts/x.md", strategy });
      expect(JSON.parse(f.objects.get(manifestPath)!.body.toString()).tombstones).toEqual(deleted);
      await a.service.syncApply({ remoteTarget, passphrase: "test-passphrase" });
      await expect(a.repository.readPersonalFile("concepts/z.md")).rejects.toMatchObject({ code: "ENOENT" });
      const c = await device();
      await c.service.syncApply({ remoteTarget, passphrase: "test-passphrase" });
      await expect(c.repository.readPersonalFile("concepts/z.md")).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["local", "remote", "both"] as const)(
    "preserves local deletion records when resolving an unrelated conflict with %s", async (strategy) => {
      const { a, b } = await pairedDevices();
      await a.repository.removePersonalFile("concepts/z.md");
      await a.service.syncApply({ remoteTarget, passphrase: "test-passphrase" });
      const previous = JSON.parse(await readFile(a.statePath, "utf8")).tombstones;
      expect(previous).toHaveLength(1);
      await b.repository.writePersonalFile("concepts/x.md", Buffer.from("remote-x"));
      await b.service.syncApply({ remoteTarget, passphrase: "test-passphrase" });
      await a.repository.writePersonalFile("concepts/x.md", Buffer.from("local-x"));
      await a.service.resolveConflict({ remoteTarget, passphrase: "test-passphrase", path: "concepts/x.md", strategy });
      expect(JSON.parse(await readFile(a.statePath, "utf8")).tombstones).toEqual(previous);
    },
  );

  it("checks configuration without issuing network requests and reports conditional writes", async () => {
    const f = await fixture();
    configure(f.endpoint);
    const d = await device();
    await expect(d.service.checkRemote(remoteTarget)).resolves.toMatchObject({
      safeExistingManifestWrite: true,
      capabilities: { conditionalManifestWrite: true, objectListing: false, objectDelete: false },
    });
    expect(f.requests).toHaveLength(0);
  });

  it("backs up twice, synchronizes a second device, and keeps cleanup unavailable", async () => {
    const f = await fixture();
    configure(f.endpoint);
    const a = await device();
    await a.repository.writePersonalFile("concepts/example.md", Buffer.from("# First\n"));
    await a.service.backup({ remoteTarget, passphrase: "test-passphrase", dryRun: false });
    await a.repository.writePersonalFile("concepts/example.md", Buffer.from("# Updated\n"));
    await expect(a.service.backup({ remoteTarget, passphrase: "test-passphrase", dryRun: false })).resolves.toMatchObject({
      uploaded: ["concepts/example.md"],
    });
    const b = await device();
    await expect(b.service.syncApply({ remoteTarget, passphrase: "test-passphrase" })).resolves.toMatchObject({
      downloaded: ["concepts/example.md"],
    });
    await expect(b.repository.readPersonalFile("concepts/example.md")).resolves.toEqual(Buffer.from("# Updated\n"));
    await expect(b.service.cleanupDryRun({ remoteTarget })).rejects.toMatchObject({ code: "CLOUD_REMOTE_LIST_UNSUPPORTED" });
    const wireManifest = f.objects.get(manifestPath)!.body.toString();
    expect(wireManifest).not.toContain("concepts/example.md");
    expect(wireManifest).not.toContain("# Updated");
  });

  it.each(["backup", "sync"])("preserves sync state when a concurrent manifest wins during %s", async (operation) => {
    const f = await fixture();
    configure(f.endpoint);
    const a = await device();
    await a.repository.writePersonalFile("concepts/example.md", Buffer.from("# First\n"));
    await a.service.backup({ remoteTarget, passphrase: "test-passphrase", dryRun: false });
    const stateBefore = await readFile(a.statePath, "utf8");
    const winner = JSON.parse(f.objects.get(manifestPath)!.body.toString());
    winner.createdAt = "2026-10-27T04:00:00.000Z";
    const winningBytes = Buffer.from(JSON.stringify(winner));
    await a.repository.writePersonalFile("concepts/example.md", Buffer.from("# Local edit\n"));
    f.control.beforeManifestPut = () => { f.store(manifestPath, winningBytes); };
    const result = operation === "backup"
      ? a.service.backup({ remoteTarget, passphrase: "test-passphrase", dryRun: false })
      : a.service.syncApply({ remoteTarget, passphrase: "test-passphrase" });
    await expect(result).rejects.toMatchObject({ code: "CLOUD_MANIFEST_REVISION_CONFLICT" });
    expect(f.objects.get(manifestPath)!.body).toEqual(winningBytes);
    expect(await readFile(a.statePath, "utf8")).toBe(stateBefore);
    expect(await a.repository.readPersonalFile("concepts/example.md")).toEqual(Buffer.from("# Local edit\n"));
  });

  it("refuses an update when the provider omitted the observed ETag", async () => {
    const f = await fixture();
    configure(f.endpoint);
    const a = await device();
    await a.repository.writePersonalFile("concepts/example.md", Buffer.from("# First\n"));
    await a.service.backup({ remoteTarget, passphrase: "test-passphrase", dryRun: false });
    const stateBefore = await readFile(a.statePath, "utf8");
    const manifestBefore = f.objects.get(manifestPath)!.body;
    const writesBefore = f.requests.filter((r) => r.path === manifestPath && r.method === "PUT").length;
    f.control.omitEtag = true;
    await a.repository.writePersonalFile("concepts/example.md", Buffer.from("# Local edit\n"));
    await expect(a.service.backup({ remoteTarget, passphrase: "test-passphrase", dryRun: false })).rejects.toMatchObject({
      code: "CLOUD_MANIFEST_REVISION_REQUIRED",
    });
    expect(f.objects.get(manifestPath)!.body).toEqual(manifestBefore);
    expect(f.requests.filter((r) => r.path === manifestPath && r.method === "PUT")).toHaveLength(writesBefore);
    expect(await readFile(a.statePath, "utf8")).toBe(stateBefore);
  });
});

it('round-trips typed growth and v2 records over isolated HTTP S3', async()=> {
 const f=await fixture(); configure(f.endpoint); const a=await device(), b=await device();
 const assets = [['growth/observations/op.json',portableObservation],['growth/reviews/capture.json',portableReview],['capabilities.json',portableCapabilities],['concepts/c.json',portableConcept]] as const;
 for(const [p,v] of assets) await a.repository.writePersonalFile(p,Buffer.from(JSON.stringify(v)));
 await a.repository.writePersonalFile('growth/reports/private.json',Buffer.from('private'));
 const backup=await a.service.backup({remoteTarget,passphrase:'fixture',dryRun:false});
 await b.service.syncApply({remoteTarget,passphrase:'fixture'});
 for(const [p,v] of assets) expect(JSON.parse((await b.repository.readPersonalFile(p)).toString())).toEqual(v);
 await expect(b.repository.readPersonalFile('growth/reports/private.json')).rejects.toMatchObject({code:'ENOENT'});
 await a.repository.writePersonalFile('growth/observations/op.json',Buffer.from(JSON.stringify({...portableObservation,source:'remote human correction'})));
 await a.service.backup({remoteTarget:remoteTarget,passphrase:'fixture',dryRun:false});
 await b.repository.writePersonalFile('growth/observations/op.json',Buffer.from(JSON.stringify({...portableObservation,source:'local human correction'})));
 expect((await b.service.syncDryRun({remoteTarget:remoteTarget,passphrase:'fixture'})).conflicts).toContain('growth/observations/op.json');
 for(const [path,original] of assets) {
  const remoteValue=JSON.parse(JSON.stringify(original)),localValue=JSON.parse(JSON.stringify(original));
  if(path==='capabilities.json'){remoteValue.history[1].input.rationale='remote';localValue.history[1].input.rationale='local';}
  else if(path==='concepts/c.json'){remoteValue.boundary='remote boundary';localValue.boundary='local boundary';}
  else if(path.includes('observations')){remoteValue.source='remote';localValue.source='local';}
  else {remoteValue.templateIds=['aar'];localValue.templateIds=['kpt'];}
  const remoteBytes=Buffer.from(JSON.stringify(remoteValue)),localBytes=Buffer.from(JSON.stringify(localValue));
  await a.repository.writePersonalFile(path,remoteBytes);await a.service.backup({remoteTarget:remoteTarget,passphrase:'fixture',dryRun:false});
  await b.repository.writePersonalFile(path,localBytes);
  const resolved=await b.service.resolveConflict({path,strategy:'both',remoteTarget:remoteTarget,passphrase:'fixture'});
  expect(resolved.resolved).toBe(true);const copy=resolved.writtenLocal.find(p=>p!==path)!;
  expect(await b.repository.readPersonalFile(path)).toEqual(remoteBytes);expect(await b.repository.readPersonalFile(copy)).toEqual(localBytes);
  expect((await b.service.syncDryRun({remoteTarget:remoteTarget,passphrase:'fixture'})).conflicts).not.toContain(path);
  await a.service.syncApply({remoteTarget:remoteTarget,passphrase:'fixture'});expect(await a.repository.readPersonalFile(copy)).toEqual(localBytes);
 }
 const api=await import('../../src/index.js');
 const growth=new api.GrowthService(new api.ProjectRepository(b.repository.paths),b.repository,{clock:()=>new Date('2026-10-30T00:00:00Z'),id:()=> 'fixture'});
 const report=await growth.report();expect(report.coverage.counts.observations).toBe(1);expect(report.coverage.counts.capturedReviews).toBe(1);expect(await growth.history()).toHaveLength(2);
 expect((await b.repository.listConcepts()).filter(c=>c.id==='c')).toHaveLength(1);
 const assetService=new (await import('../../src/index.js')).PersonalAssetService(b.repository,{clock:()=>new Date('2026-10-30T00:00:00Z')});
 const exportBundle=await assetService.exportPersonal(join(b.paths.personal.base,'..','archive-export'));
 expect((await assetService.verifyPersonalBundle(exportBundle.exportRoot)).valid).toBe(true);


});
