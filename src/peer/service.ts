import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import { PersonalRepository } from "../storage/personal-repository.js";
import { safeChildPath } from "../storage/paths.js";
import { assertSafePath } from "../storage/snapshot-files.js";
import { validatePersonalAsset } from "../personal/personal-asset-paths.js";
import { getTrustedPeer, loadIdentity } from "./identity.js";
import { buildPeerPlan, makeSnapshot, validateBaseline, validatePeerPlan, type PeerBaseline, type PeerPlan, type PeerResolution, type PeerSnapshot } from "./planner.js";
import { PeerStore, type PeerJournal, type PeerReceipt } from "./store.js";
import { connectPeer, TRANSPORT_LIMITS, type PeerClient, type PeerRequest } from "./transport.js";
export type PeerTarget = {
    peerId: string;
    address: string;
};
export type PeerEndpointState = {
    snapshot: PeerSnapshot;
    baseline: PeerBaseline;
    pending: PeerJournal | null;
    busy: boolean;
};
export type PeerSyncResult = {
    sessionId: string;
    planDigest: string;
    plan: PeerPlan;
    localReceipt: PeerReceipt;
    remoteReceipt: PeerReceipt;
};
const id = z.string().regex(/^[a-z2-7]{52}$/), session = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const choiceSchema = z.strictObject({ path: z.string(), strategy: z.enum(["local", "remote", "both", "skip"]), localHash: hash.nullable(), remoteHash: hash.nullable() });
const receiptSchema = z.strictObject({ sessionId: session, planDigest: hash, peerId: id, phase: z.enum(["applied", "committed"]) });
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function fail(code: string, message: string, details: Record<string, unknown> = {}): never {
    throw new DomainError(code, message, details);
}
// The private owner record extends this in-process guard to independent CLI processes.
const active = new Set<string>();
/** Authenticated orchestration: root locks cover local transactions, never network I/O. */
export class PeerService {
    readonly root: string;
    private readonly admissions = new AsyncLocalStorage<{peerId:string; ownCertificate:string; peerCertificate:string}>();
    constructor(readonly repository: PersonalRepository) {
        this.root = repository.paths.personal.base;
    }
    private path(peerId: string, ...parts: string[]): string {
        id.parse(peerId);
        let path = join(this.root, ".p2p", "peers", peerId);
        for (const part of parts)
            path = safeChildPath(path, part);
        return path;
    }
    private async read(path: string): Promise<Buffer | undefined> {
        if (!await assertSafePath(path, "file", this.root))
            return undefined;
        const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            return await h.readFile();
        }
        finally {
            await h.close();
        }
    }
    private async write(path: string, bytes: Buffer): Promise<void> {
        await assertSafePath(dirname(path), "directory", this.root);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await assertSafePath(path, "file", this.root);
        const temp = `${path}.${randomUUID()}.tmp`;
        const h = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
            await h.writeFile(bytes);
            await h.sync();
        }
        finally {
            await h.close();
        }
        try {
            await rename(temp, path);
            const dir = await open(dirname(path), "r");
            try {
                await dir.sync();
            }
            catch (e) {
                if (!e || typeof e !== "object" || !("code" in e) || !["EINVAL", "ENOTSUP"].includes(String(e.code)))
                    throw e;
            }
            finally {
                await dir.close();
            }
        }
        finally {
            await rm(temp, { force: true });
        }
    }
    private async context(peerId: string) {
        id.parse(peerId);
        const identity = await loadIdentity(this.root);
        if (!identity)
            fail("P2P_IDENTITY_MISSING", "Initialize or restore the paired device identity");
        if (identity.peerId === peerId)
            fail("P2P_SELF_PEER", "Cannot connect a copied identity to itself");
        const trusted = await getTrustedPeer(this.root, peerId);
        if (!trusted)
            fail("P2P_PEER_UNTRUSTED", "Peer is not trusted");
        const expected=this.admissions.getStore();
        if(expected && (expected.peerId!==peerId || expected.ownCertificate!==identity.certificatePem || expected.peerCertificate!==trusted.certificatePem))
            fail("P2P_PEER_UNTRUSTED", "Peer trust or local identity changed; reconnect before retrying");
        return { identity, trusted, store: new PeerStore(this.repository, peerId) };
    }
    private async admitted<T>(peerId:string, work:()=>Promise<T>):Promise<T>{
        return this.repository.withMutationLock(async()=>{await this.context(peerId);return work();});
    }
    private async busy(peerId: string): Promise<boolean> {
        if (active.has(this.root))
            return true;
        const bytes = await this.read(this.path(peerId, "operation.json"));
        if (!bytes)
            return false;
        const value = z.strictObject({ pid: z.number().int().positive(), token: z.string() }).parse(JSON.parse(bytes.toString()));
        try {
            process.kill(value.pid, 0);
            return true;
        }
        catch (e) {
            if (e && typeof e === "object" && "code" in e && e.code === "ESRCH")
                return false;
            return true;
        }
    }
    private async exclusive<T>(peerId: string, work: () => Promise<T>): Promise<T> {
        const {identity,trusted}=await this.context(peerId);
        return this.admissions.run({peerId,ownCertificate:identity.certificatePem,peerCertificate:trusted.certificatePem},async()=>{
        const token = randomUUID();
        await this.admitted(peerId,async () => {
            if (await this.busy(peerId))
                fail("P2P_BUSY", "Another peer operation is active");
            await this.write(this.path(peerId, "operation.json"), Buffer.from(JSON.stringify({ pid: process.pid, token })));
            active.add(this.root);
        });
        try {
            return await work();
        }
        finally {
            await this.repository.withMutationLock(async () => {
                const value = await this.read(this.path(peerId, "operation.json"));
                if (value && JSON.parse(value.toString()).token === token)
                    await rm(this.path(peerId, "operation.json"));
                active.delete(this.root);
            });
        }
        });
    }
    private async state(peerId: string): Promise<PeerEndpointState> {
        const { identity, store } = await this.context(peerId);
        return { snapshot: await store.snapshot(identity.peerId), baseline: await store.readBaseline(), pending: (await store.pending()) ?? null, busy: await this.busy(peerId) };
    }
    private stateValue(value: unknown, peerId: string): PeerEndpointState {
        const v = z.strictObject({ snapshot: z.unknown(), baseline: z.unknown(), pending: z.unknown().nullable(), busy: z.boolean() }).parse(value);
        const raw = z.strictObject({ peerId: id, entries: z.array(z.strictObject({ path: z.string(), sha256: hash, bytes: z.number().int().nonnegative() })), digest: hash }).parse(v.snapshot);
        const snapshot = makeSnapshot(raw.peerId, raw.entries);
        if (snapshot.peerId !== peerId || snapshot.digest !== raw.digest)
            fail("P2P_SNAPSHOT_INVALID", "Invalid peer snapshot");
        return { snapshot, baseline: validateBaseline(v.baseline), pending: v.pending === null ? null : this.journalValue(v.pending, peerId), busy: v.busy };
    }
    private journalValue(value: unknown, ownId: string): PeerJournal {
        const v = z.object({ version: z.literal(1), sessionId: session, role: z.enum(["local", "remote"]), phase: z.enum(["prepared", "applying", "applied", "committed", "aborted"]), plan: z.unknown(), operations: z.array(z.unknown()), receipt: receiptSchema.nullable() }).parse(value);
        const plan = validatePeerPlan(v.plan);
        if ((v.role === "local" ? plan.localPeerId : plan.remotePeerId) !== ownId)
            fail("P2P_PEER_MISMATCH", "Journal endpoint identity mismatch");
        return { ...v, plan } as PeerJournal;
    }
    private async choices(peerId: string): Promise<PeerResolution[]> {
        const bytes = await this.read(this.path(peerId, "resolutions.json"));
        return bytes ? z.array(choiceSchema).max(4096).parse(JSON.parse(bytes.toString())) : [];
    }
    private async plan(local: PeerEndpointState, remote: PeerEndpointState, peerId: string): Promise<PeerPlan> {
        if (local.baseline.digest !== remote.baseline.digest)
            fail("P2P_BASE_MISMATCH", "Peer baselines differ; resume the existing session");
        const choices = await this.choices(peerId);
        const unresolved = buildPeerPlan({ local: local.snapshot, remote: remote.snapshot, base: local.baseline });
        const resolutions = choices.filter(c => unresolved.conflicts.some(f => f.path === c.path && f.localHash === c.localHash && f.remoteHash === c.remoteHash));
        return buildPeerPlan({ local: local.snapshot, remote: remote.snapshot, base: local.baseline, resolutions });
    }
    private async withClient<T>(target: PeerTarget, work: (client: PeerClient) => Promise<T>): Promise<T> {
        await this.context(target.peerId);
        const client = await connectPeer({ personalRoot: this.root, ...target });
        try {
            return await work(client);
        }
        finally {
            await client.close();
        }
    }
    private async remoteState(client: PeerClient, peerId: string) {
        return this.stateValue(await client.request("snapshot", { version: 1 }), peerId);
    }
    async preview(target: PeerTarget): Promise<PeerPlan> {
        return this.withClient(target, async (client) => {
            const local = await this.state(target.peerId), remote = await this.remoteState(client, target.peerId);
            if (local.pending || remote.pending)
                fail("P2P_PENDING_SESSION", "Resume the unfinished session", { sessionId: local.pending?.sessionId ?? remote.pending?.sessionId });
            return this.plan(local, remote, target.peerId);
        });
    }
    async status(target: {
        peerId: string;
        address?: string;
    }): Promise<{
        peerId: string;
        local: PeerEndpointState;
        remote?: PeerEndpointState;
    }> {
        const local = await this.state(target.peerId);
        if (!target.address)
            return { peerId: target.peerId, local };
        return this.withClient({ peerId: target.peerId, address: target.address }, async (client) => ({ peerId: target.peerId, local, remote: await this.remoteState(client, target.peerId) }));
    }
    private payloadPath(peerId: string, sessionId: string, sha256: string): string {
        session.parse(sessionId);
        hash.parse(sha256);
        return this.path(peerId, "service", sessionId, "payloads", sha256);
    }
    private sources(plan: PeerPlan) {
        const result = new Map<string, NonNullable<PeerPlan["localOperations"][number]["source"]>>();
        for (const op of [...plan.localOperations, ...plan.remoteOperations])
            if (op.source)
                result.set(op.source.sha256, op.source);
        let total = 0;
        for (const source of result.values()) {
            const snapshot = source.side === "local" ? plan.localSnapshot : plan.remoteSnapshot;
            const entry = snapshot.entries.find(e => e.path === source.path && e.sha256 === source.sha256);
            if (!entry || (total += entry.bytes) > 64 * 1024 * 1024)
                fail("P2P_LIMIT_EXCEEDED", "Required payloads exceed the session byte limit");
        }
        return [...result.values()];
    }
    private async readAsset(path: string, sha256: string, expectedBytes?: number): Promise<Buffer> {
        makeSnapshot("a".repeat(52), [{ path, sha256, bytes: expectedBytes ?? 0 }]);
        return this.repository.withMutationLock(async () => {
            const absolute = safeChildPath(this.root, path);
            if (!await assertSafePath(absolute, "file", this.root))
                fail("P2P_SNAPSHOT_CHANGED", "Requested source is no longer present");
            const bytes = await this.repository.readPersonalFile(path);
            if (!bytes || digest(bytes) !== sha256 || (expectedBytes !== undefined && bytes.length !== expectedBytes) || bytes.length > 8 * 1024 * 1024)
                fail("P2P_SNAPSHOT_CHANGED", "Requested source changed");
            validatePersonalAsset(path, bytes);
            return bytes;
        });
    }
    // Preserve sources needed only by the other endpoint too: PeerStore stages local writes.
    private async stagePlan(peerId: string, sessionId: string, plan: PeerPlan): Promise<void> {
        const path = this.path(peerId, "service", session.parse(sessionId), "plan.json");
        const prior = await this.read(path);
        if (prior && validatePeerPlan(JSON.parse(prior.toString())).digest !== plan.digest)
            fail("P2P_SESSION_MISMATCH", "Staging session has a different plan");
        if (!prior)
            await this.write(path, Buffer.from(JSON.stringify(plan)));
    }
    private async collect(peerId: string, sessionId: string, plan: PeerPlan, client: PeerClient, ownRole: "local" | "remote"): Promise<Record<string, Buffer>> {
        await this.admitted(peerId,() => this.stagePlan(peerId, sessionId, plan));
        const result: Record<string, Buffer> = {};
        for (const source of this.sources(plan)) {
            let bytes = await this.read(this.payloadPath(peerId, sessionId, source.sha256));
            if (!bytes) {
                bytes = source.side === ownRole ? await this.readAsset(source.path, source.sha256) : await client.download("download", { version: 1, sessionId, planDigest: plan.digest, path: source.path, sha256: source.sha256 });
                if (digest(bytes) !== source.sha256)
                    fail("P2P_PAYLOAD_INVALID", "Peer payload hash mismatch");
                await this.admitted(peerId,() => this.write(this.payloadPath(peerId, sessionId, source.sha256), bytes!));
            }
            if (digest(bytes) !== source.sha256)
                fail("P2P_PAYLOAD_INVALID", "Staged payload is damaged");
            result[source.sha256] = bytes;
        }
        return result;
    }
    private async continueSession(target: PeerTarget, client: PeerClient, journal: PeerJournal): Promise<PeerSyncResult> {
        const { store } = await this.context(target.peerId), plan = journal.plan, sessionId = journal.sessionId;
        let remote: PeerJournal | null = null;
        const response = await client.request("status", { version: 1, sessionId });
        if (response !== null)
            remote = this.journalValue(response, target.peerId);
        if (remote && (remote.sessionId !== sessionId || remote.plan.digest !== plan.digest || remote.role === journal.role))
            fail("P2P_SESSION_MISMATCH", "Remote session differs");
        if (["prepared","aborted"].includes(journal.phase) && (!remote || ["prepared","aborted"].includes(remote.phase))) {
            const localState=await this.state(target.peerId),remoteState=await this.remoteState(client,target.peerId);
            const localExpected=journal.role==="local"?plan.localSnapshot:plan.remoteSnapshot;
            const remoteExpected=journal.role==="local"?plan.remoteSnapshot:plan.localSnapshot;
            const changed=localState.snapshot.digest!==localExpected.digest||remoteState.snapshot.digest!==remoteExpected.digest;
            if(changed||journal.phase==="aborted"||remote?.phase==="aborted"){
                if(localState.baseline.digest!==plan.baseBaseline.digest||remoteState.baseline.digest!==plan.baseBaseline.digest)
                    fail("P2P_BASE_MISMATCH","Cannot abandon a session after either baseline advanced");
                if(remoteState.busy)fail("P2P_BUSY","Peer is already synchronizing");
                // The peer atomically verifies its journal/base and aborts first. If its reply is lost,
                // its terminal journal makes this same decision recoverable on the next resume.
                await client.request("abort-prepared",{version:1,sessionId,planDigest:plan.digest,baseDigest:plan.baseBaseline.digest});
                await this.admitted(target.peerId,()=>store.abortPrepared(sessionId));
                return this.startSession(target,client);
            }
        }
        if (!remote) {
            this.preflight(plan,sessionId);
            const payloads = await this.collect(target.peerId, sessionId, plan, client, journal.role);
            const receivingOperations = journal.role === "local" ? plan.remoteOperations : plan.localOperations;
            const neededHashes = new Set(receivingOperations.flatMap(operation => operation.source ? [operation.source.sha256] : []));
            for (const source of this.sources(plan).filter(source => neededHashes.has(source.sha256)))
                await client.upload("upload", { version: 1, sessionId, plan, sha256: source.sha256, path: source.path }, payloads[source.sha256]!);
            remote = this.journalValue(await client.request("prepare", { version: 1, sessionId, plan, role: journal.role === "local" ? "remote" : "local" }), target.peerId);
        }
        // Both durable prepare journals now exist; preserve responder-first application.
        let localReceipt: PeerReceipt, remoteReceipt: PeerReceipt;
        if (journal.role === "local") {
            remoteReceipt = this.receiptValue(await client.request("apply", { version: 1, sessionId }), plan, target.peerId, sessionId);
            localReceipt = await this.admitted(target.peerId,()=>store.apply(sessionId));
        }
        else {
            localReceipt = await this.admitted(target.peerId,()=>store.apply(sessionId));
            remoteReceipt = this.receiptValue(await client.request("apply", { version: 1, sessionId }), plan, target.peerId, sessionId);
        }
        remoteReceipt = this.receiptValue(await client.request("finalize", { version: 1, sessionId, receipt: localReceipt }), plan, target.peerId, sessionId);
        localReceipt = await this.admitted(target.peerId,()=>store.finalize(sessionId, remoteReceipt));
        return { sessionId, planDigest: plan.digest, plan, localReceipt, remoteReceipt };
    }
    private receiptValue(value: unknown, plan: PeerPlan, peerId: string, sessionId: string): PeerReceipt {
        const receipt = receiptSchema.parse(value);
        if (receipt.peerId !== peerId || receipt.planDigest !== plan.digest || receipt.sessionId !== sessionId)
            fail("P2P_RECEIPT_MISMATCH", "Peer receipt does not match the session");
        return receipt;
    }
    private preflight(plan:PeerPlan,sessionId:string):void {
        // Check wire envelopes, not just the manifest. Leave room for error text and future fields.
        const check=(value:unknown)=>{
            const bytes=Buffer.byteLength(JSON.stringify(value));
            if(bytes>TRANSPORT_LIMITS.metadataBytes-16*1024)
                fail("P2P_METADATA_LIMIT","Sync plan exceeds the 1 MiB metadata limit; reduce the number or length of asset paths before retrying",{bytes,limit:TRANSPORT_LIMITS.metadataBytes});
        };
        const request=(kind:string,metadata:unknown,transfer="none",size?:number)=>check({version:1,kind,metadata,transfer,...(size===undefined?{}:{size})});
        const sources=this.sources(plan);
        const longest=sources.reduce<string>((path,source)=>Buffer.byteLength(source.path)>Buffer.byteLength(path)?source.path:path,"");
        request("upload",{version:1,sessionId,plan,path:longest,sha256:"f".repeat(64)},"upload",TRANSPORT_LIMITS.assetBytes);
        request("download",{version:1,sessionId,planDigest:plan.digest,path:longest,sha256:"f".repeat(64)},"download");
        for(const role of ["local","remote"] as const){
            request("prepare",{version:1,sessionId,plan,role});
            const peerId=role==="local"?plan.localPeerId:plan.remotePeerId;
            const receipt={sessionId,planDigest:plan.digest,peerId,phase:"committed"};
            const operations=(role==="local"?plan.localOperations:plan.remoteOperations).map(operation=>({operation,state:"pending",attempt:100,overrideBefore:"f".repeat(64)}));
            const journal={version:1,sessionId,role,plan,phase:"committed",operations,receipt};
            check({version:1,ok:true,result:journal});
            for(const snapshot of [plan.localSnapshot,plan.remoteSnapshot,plan.localTarget,plan.remoteTarget])
                for(const baseline of [plan.baseBaseline,plan.nextBaseline])
                    check({version:1,ok:true,result:{snapshot,baseline,pending:journal,busy:false}});
            request("finalize",{version:1,sessionId,receipt});
        }
        for(const kind of ["status","apply","resolve-recovery","abort-prepared"])
            request(kind,{version:1,sessionId,planDigest:plan.digest,baseDigest:plan.baseBaseline.digest,preserveCurrent:true});
    }
    private async startSession(target:PeerTarget,client:PeerClient):Promise<PeerSyncResult>{
        const {store}=await this.context(target.peerId),local=await this.state(target.peerId),remote=await this.remoteState(client,target.peerId);
        if(local.pending||remote.pending)fail("P2P_PENDING_SESSION","Resume the unfinished session",{sessionId:local.pending?.sessionId??remote.pending?.sessionId});
        if(remote.busy)fail("P2P_BUSY","Peer is already synchronizing");
        const plan=await this.plan(local,remote,target.peerId);
        if(plan.conflicts.some(c=>c.resolution===null))fail("P2P_SYNC_CONFLICT","Resolve conflicts before applying");
        const sessionId=randomUUID();this.preflight(plan,sessionId);
        const payloads=await this.collect(target.peerId,sessionId,plan,client,"local");
        const journal=await this.admitted(target.peerId,()=>store.prepare({sessionId,plan,role:"local",payloads}));
        return this.continueSession(target,client,journal);
    }
    async sync(target: PeerTarget): Promise<PeerSyncResult> {
        return this.exclusive(target.peerId,()=>this.withClient(target,client=>this.startSession(target,client)));
    }
    async resume(target: PeerTarget): Promise<PeerSyncResult> {
        return this.exclusive(target.peerId, () => this.withClient(target, async (client) => {
            const { store, identity } = await this.context(target.peerId);
            let pending = await store.pending();
            if (!pending) {
                const remote = await this.remoteState(client, target.peerId);
                if (remote.busy)
                    fail("P2P_BUSY", "Peer is already synchronizing");
                if (remote.pending) {
                    pending = await store.status(remote.pending.sessionId);
                }
                else {
                    const baseline = await store.readBaseline();
                    if (!baseline.lastSessionId || baseline.lastSessionId !== remote.baseline.lastSessionId)
                        fail("P2P_NO_PENDING_SESSION", "No recoverable peer session");
                    pending = await store.status(baseline.lastSessionId);
                }
            }
            if ((pending.role === "local" ? pending.plan.localPeerId : pending.plan.remotePeerId) !== identity.peerId)
                fail("P2P_PEER_MISMATCH", "Session belongs to another endpoint");
            return this.continueSession(target, client, pending);
        }));
    }
    async listConflicts(target: PeerTarget) {
        return (await this.preview(target)).conflicts;
    }
    async showConflict(target: PeerTarget & {
        path: string;
    }) {
        return this.withClient(target, async (client) => {
            const local = await this.state(target.peerId), remote = await this.remoteState(client, target.peerId), plan = await this.plan(local, remote, target.peerId), conflict = plan.conflicts.find(c => c.path === target.path);
            if (!conflict)
                fail("P2P_CONFLICT_NOT_FOUND", "Path is not currently conflicted");
            const localBytes = conflict.localHash ? await this.readAsset(target.path, conflict.localHash) : null;
            const remoteBytes = conflict.remoteHash ? await client.download("download", { version: 1, path: target.path, sha256: conflict.remoteHash }) : null;
            if (remoteBytes && digest(remoteBytes) !== conflict.remoteHash)
                fail("P2P_PAYLOAD_INVALID", "Conflict preview changed");
            return { ...conflict, local: localBytes?.toString("utf8") ?? null, remote: remoteBytes?.toString("utf8") ?? null };
        });
    }
    async resolveConflict(target: PeerTarget & {
        path: string;
        strategy: PeerResolution["strategy"];
    }): Promise<PeerResolution> {
        const plan = await this.preview(target), conflict = plan.conflicts.find(c => c.path === target.path);
        if (!conflict)
            fail("P2P_CONFLICT_NOT_FOUND", "Path is not currently conflicted");
        const choice = choiceSchema.parse({ path: target.path, strategy: target.strategy, localHash: conflict.localHash, remoteHash: conflict.remoteHash });
        await this.admitted(target.peerId,async () => {
            const choices = await this.choices(target.peerId);
            await this.write(this.path(target.peerId, "resolutions.json"), Buffer.from(JSON.stringify([...choices.filter(c => c.path !== target.path), choice])));
        });
        return choice;
    }
    async resolveRecovery(target: PeerTarget & {
        preserveCurrent: true;
    }): Promise<{
        local: {
            archives: string[];
        };
        remote: {
            archives: string[];
        };
    }> {
        if (target.preserveCurrent !== true)
            fail("P2P_RECOVERY_CONFIRMATION_REQUIRED", "Explicit preservation decision required");
        return this.exclusive(target.peerId, () => this.withClient(target, async (client) => {
            const { store } = await this.context(target.peerId), pending = await store.pending();
            if (!pending)
                fail("P2P_NO_PENDING_SESSION", "No pending session");
            const status=await client.request("status",{version:1,sessionId:pending.sessionId});
            const remoteJournal=status===null?null:this.journalValue(status,target.peerId);
            if(remoteJournal && (remoteJournal.plan.digest!==pending.plan.digest||remoteJournal.role===pending.role))
                fail("P2P_SESSION_MISMATCH","Remote session differs");
            if((!remoteJournal||remoteJournal.phase==="aborted") && ["prepared","aborted"].includes(pending.phase))
                fail("P2P_RECOVERY_REPLAN_REQUIRED","This untouched session has no usable peer journal; run peer session resume to verify and replace the plan");
            if(!remoteJournal)fail("P2P_SESSION_NOT_FOUND","Remote recovery journal is missing; preserve the existing local journal");
            const remote = z.strictObject({ archives: z.array(z.string()) }).parse(await client.request("resolve-recovery", { version: 1, sessionId: pending.sessionId, preserveCurrent: true }));
            const local = await this.admitted(target.peerId,()=>store.resolveRecovery(pending.sessionId, { preserveCurrent: true }));
            return { local, remote };
        }));
    }
    readonly handler = (request: PeerRequest): Promise<unknown> => this.handle(request);
    async handle(request: PeerRequest): Promise<unknown> {
        return this.repository.withMutationLock(async()=>{
            const {trusted}=await this.context(request.peerId);
            if(trusted.certificatePem!==request.certificatePem)fail("P2P_PEER_UNTRUSTED","Peer certificate changed; reconnect before retrying");
            return this.dispatch(request);
        });
    }
    private async dispatch(request: PeerRequest): Promise<unknown> {
        const { store, identity } = await this.context(request.peerId);
        const common = { version: z.literal(1) };
        const parse = <T extends z.ZodRawShape>(shape: T) => z.strictObject({ ...common, ...shape }).parse(request.metadata);
        if (!["upload"].includes(request.kind) && request.asset !== undefined)
            fail("P2P_REQUEST_INVALID", "Unexpected asset payload");
        if (["upload", "prepare", "apply", "finalize", "resolve-recovery", "abort-prepared"].includes(request.kind) && await this.busy(request.peerId))
            fail("P2P_BUSY", "Endpoint has an active initiating operation");
        if (request.kind === "snapshot" || request.kind === "conflicts") {
            parse({});
            return this.state(request.peerId);
        }
        if (request.kind === "status") {
            const meta = parse({ sessionId: session.optional() });
            if (!meta.sessionId)
                return this.state(request.peerId);
            try {
                return await store.status(meta.sessionId);
            }
            catch (e) {
                if (e instanceof DomainError && e.code === "P2P_SESSION_NOT_FOUND")
                    return null;
                throw e;
            }
        }
        if (request.kind === "download") {
            const meta = parse({ path: z.string(), sha256: hash, sessionId: session.optional(), planDigest: hash.optional() });
            makeSnapshot(identity.peerId, [{ path: meta.path, sha256: meta.sha256, bytes: 0 }]);
            if (meta.sessionId) {
                const manifest = await this.read(this.path(request.peerId, "service", meta.sessionId, "plan.json"));
                if (manifest) {
                    const plan = validatePeerPlan(JSON.parse(manifest.toString()));
                    this.endpoints(plan, request.peerId, identity.peerId);
                    if (plan.digest !== meta.planDigest || !this.sources(plan).some(s => s.path === meta.path && s.sha256 === meta.sha256))
                        fail("P2P_PAYLOAD_INVALID", "Source does not match the prepared plan");
                }
                const staged = manifest ? await this.read(this.payloadPath(request.peerId, meta.sessionId, meta.sha256)) : undefined;
                if (staged) {
                    if (digest(staged) !== meta.sha256)
                        fail("P2P_PAYLOAD_INVALID", "Staged source damaged");
                    return staged;
                }
            }
            return this.readAsset(meta.path, meta.sha256);
        }
        if (request.kind === "upload") {
            const meta = parse({ sessionId: session, plan: z.unknown(), path: z.string(), sha256: hash });
            const plan = validatePeerPlan(meta.plan);
            if (plan.localPeerId !== request.peerId || plan.remotePeerId !== identity.peerId)
                fail("P2P_PEER_MISMATCH", "Upload requires the initiating endpoint");
            this.endpoints(plan, request.peerId, identity.peerId);
            const pending = await store.pending();
            if (pending && (pending.sessionId !== meta.sessionId || pending.plan.digest !== plan.digest))
                fail("P2P_BUSY", "Another session is pending");
            if (!this.sources(plan).some(s => s.path === meta.path && s.sha256 === meta.sha256) || !request.asset || digest(request.asset) !== meta.sha256)
                fail("P2P_PAYLOAD_INVALID", "Unexpected source or damaged upload");
            validatePersonalAsset(meta.path, request.asset);
            const source = this.sources(plan).find(s => s.path === meta.path && s.sha256 === meta.sha256)!;
            const entry = (source.side === "local" ? plan.localSnapshot : plan.remoteSnapshot).entries.find(e => e.path === meta.path)!;
            if (entry.bytes !== request.asset.length)
                fail("P2P_PAYLOAD_INVALID", "Payload byte length mismatch");
            await this.stagePlan(request.peerId, meta.sessionId, plan);
            await this.repository.withMutationLock(() => this.write(this.payloadPath(request.peerId, meta.sessionId, meta.sha256), request.asset!));
            return { sha256: meta.sha256 };
        }
        if (request.kind === "prepare") {
            const meta = parse({ sessionId: session, plan: z.unknown(), role: z.enum(["local", "remote"]) }), plan = validatePeerPlan(meta.plan);
            this.endpoints(plan, request.peerId, identity.peerId);
            if (meta.role !== "remote" || plan.localPeerId !== request.peerId || plan.remotePeerId !== identity.peerId)
                fail("P2P_PEER_MISMATCH", "Wrong prepare endpoint");
            this.preflight(plan,meta.sessionId);
            const payloads: Record<string, Buffer> = {};
            for (const source of this.sources(plan)) {
                const bytes = await this.read(this.payloadPath(request.peerId, meta.sessionId, source.sha256));
                if (bytes)
                    payloads[source.sha256] = bytes;
            }
            return store.prepare({ sessionId: meta.sessionId, plan, role: meta.role, payloads });
        }
        if (request.kind === "abort-prepared") {
            const meta=parse({sessionId:session,planDigest:hash,baseDigest:hash});
            if((await store.readBaseline()).digest!==meta.baseDigest)fail("P2P_BASE_MISMATCH","Cannot abandon a session after baseline advancement");
            const pending=await store.pending();
            if(pending && pending.sessionId!==meta.sessionId)fail("P2P_BUSY","Another session is pending");
            let journal:PeerJournal;
            try{journal=await store.status(meta.sessionId);}catch(error){
                if(error instanceof DomainError && error.code==="P2P_SESSION_NOT_FOUND")return null;
                throw error;
            }
            if(journal.plan.digest!==meta.planDigest)fail("P2P_SESSION_MISMATCH","Remote session differs");
            return store.abortPrepared(meta.sessionId);
        }
        if (request.kind === "apply") {
            const meta = parse({ sessionId: session });
            return store.apply(meta.sessionId);
        }
        if (request.kind === "finalize") {
            const meta = parse({ sessionId: session, receipt: receiptSchema });
            return store.finalize(meta.sessionId, meta.receipt);
        }
        if (request.kind === "resolve-recovery") {
            const meta = parse({ sessionId: session, preserveCurrent: z.literal(true) });
            return store.resolveRecovery(meta.sessionId, { preserveCurrent: true });
        }
        return fail("P2P_REQUEST_INVALID", "Unknown peer business request");
    }
    private endpoints(plan: PeerPlan, peerId: string, ownId: string): void {
        if (!((plan.localPeerId === peerId && plan.remotePeerId === ownId) || (plan.remotePeerId === peerId && plan.localPeerId === ownId)))
            fail("P2P_PEER_MISMATCH", "Plan does not match authenticated endpoints");
    }
}
