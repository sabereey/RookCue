import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PersonalRepository } from '../../src/storage/personal-repository.js';
import { resolvePaths } from '../../src/storage/paths.js';
import { ensureIdentity, forgetPeer, getTrustedPeer } from '../../src/peer/identity.js';
import { pairFromInvitation, serveInvitation, servePeer, connectPeer, type PeerRequest } from '../../src/peer/transport.js';
import { PeerStore } from '../../src/peer/store.js';
import { PersonalAssetService } from '../../src/personal/personal-asset-service.js';
import { PeerService } from '../../src/peer/service.js';
const roots: string[] = [], handles: Array<{
    close(): Promise<void>;
}> = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(h => h.close())); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture(options: {
    readOnly?: boolean;
    intercept?: (request: PeerRequest, next: () => Promise<unknown>) => Promise<unknown>;
} = {}) {
    const parent = await mkdtemp(join(tmpdir(), 'gmem-service-'));
    roots.push(parent);
    const a = join(parent, 'a'), b = join(parent, 'b');
    await mkdir(a);
    await mkdir(b);
    const invitation = await serveInvitation({ personalRoot: a, bind: '127.0.0.1', port: 0, invitationPath: join(parent, 'invite.json') });
    handles.push(invitation);
    await pairFromInvitation({ personalRoot: b, invitationPath: join(parent, 'invite.json') });
    await invitation.close();
    const ai = await ensureIdentity(a), bi = await ensureIdentity(b);
    const ar = new PersonalRepository(resolvePaths(join(parent, 'project-a'), a)), br = new PersonalRepository(resolvePaths(join(parent, 'project-b'), b));
    const service = new PeerService(ar), remote = new PeerService(br);
    const server = await servePeer({ personalRoot: b, bind: '127.0.0.1', port: 0, allowApply: !options.readOnly, handler: r => options.intercept ? options.intercept(r, () => remote.handle(r)) : remote.handle(r) });
    handles.push(server);
    const target = { peerId: bi.peerId, address: server.address };
    const put = async (root: string, path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
    return { a, b, ai, bi, ar, br, service, remote, target, put };
}
describe('peer service over real mutual TLS (same-host loopback evidence)', () => {
    it('pairs independent roots, unions both directions, recomputes previews, commits and propagates intentional deletion', async () => {
        const f = await fixture();
        await f.put(f.a, 'practice/a.md', 'alpha');
        await f.put(f.b, 'practice/b.md', 'beta');
        const preview = await f.service.preview(f.target);
        expect(preview.localOperations).toHaveLength(1);
        expect(preview.remoteOperations).toHaveLength(1);
        await f.put(f.b, 'practice/b.md', 'new beta');
        const result = await f.service.sync(f.target);
        expect(result.localReceipt.phase).toBe('committed');
        expect(await readFile(join(f.a, 'practice/b.md'), 'utf8')).toBe('new beta');
        expect(await readFile(join(f.b, 'practice/a.md'), 'utf8')).toBe('alpha');
        const next = await f.service.preview(f.target);
        expect(next.localOperations).toEqual([]);
        expect(next.remoteOperations).toEqual([]);
        await rm(join(f.a, 'practice/a.md'));
        await f.service.sync(f.target);
        await expect(readFile(join(f.b, 'practice/a.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it.each(['local', 'remote', 'both', 'skip'] as const)('persists hash-bound %s conflict choices and keeps skip base', async (strategy) => {
        const f = await fixture();
        await f.put(f.a, 'practice/x.md', 'base');
        await f.service.sync(f.target);
        await f.put(f.a, 'practice/x.md', 'left');
        await f.put(f.b, 'practice/x.md', 'right');
        expect(await f.service.listConflicts(f.target)).toHaveLength(1);
        await expect(f.service.sync(f.target)).rejects.toMatchObject({ code: 'P2P_SYNC_CONFLICT' });
        const shown = await f.service.showConflict({ ...f.target, path: 'practice/x.md' });
        expect(shown.local).toBe('left');
        expect(shown.remote).toBe('right');
        await f.service.resolveConflict({ ...f.target, path: 'practice/x.md', strategy });
        const restarted = new PeerService(f.ar);
        const result = await restarted.sync(f.target);
        if (strategy === 'skip') {
            expect(await readFile(join(f.a, 'practice/x.md'), 'utf8')).toBe('left');
            expect(await readFile(join(f.b, 'practice/x.md'), 'utf8')).toBe('right');
            expect((await restarted.listConflicts(f.target))).toHaveLength(1);
        }
        else {
            const expected = strategy === 'local' ? 'left' : 'right';
            expect(await readFile(join(f.a, 'practice/x.md'), 'utf8')).toBe(expected);
            expect(await readFile(join(f.b, 'practice/x.md'), 'utf8')).toBe(expected);
        }
        if (strategy === 'both') {
            const archive = result.plan.localTarget.entries.find(e => e.path.includes('.conflict-'))!;
            expect(await readFile(join(f.b, archive.path), 'utf8')).toBe('left');
        }
    });
    it('expires stale choices and reports edit/delete conflicts', async () => {
        const f = await fixture();
        await f.put(f.a, 'practice/x.md', 'base');
        await f.service.sync(f.target);
        await f.put(f.a, 'practice/x.md', 'left');
        await rm(join(f.b, 'practice/x.md'));
        expect((await f.service.listConflicts(f.target))[0]?.reason).toBe('edit/delete');
        await f.service.resolveConflict({ ...f.target, path: 'practice/x.md', strategy: 'local' });
        await f.put(f.a, 'practice/x.md', 'new left');
        await expect(f.service.sync(f.target)).rejects.toMatchObject({ code: 'P2P_SYNC_CONFLICT' });
    });
    it.each(['upload', 'prepare', 'apply', 'finalize'])('resumes a lost reply after remote %s using the same immutable session', async (kind) => {
        let fired = false;
        const f = await fixture({ intercept: async (r, next) => { const result = await next(); if (!fired && r.kind === kind) {
                fired = true;
                throw new Error('lost reply');
            } return result; } });
        await f.put(f.a, 'practice/a.md', 'alpha');
        await f.put(f.b, 'practice/b.md', 'beta');
        await expect(f.service.sync(f.target)).rejects.toThrow();
        const pending = (await f.service.status({ peerId: f.bi.peerId })).local.pending!;
        expect(pending).toBeDefined();
        await expect(f.service.sync(f.target)).rejects.toMatchObject({ code: 'P2P_PENDING_SESSION' });
        const resumed = await new PeerService(f.ar).resume(f.target);
        expect(resumed.sessionId).toBe(pending.sessionId);
        expect(resumed.localReceipt.phase).toBe('committed');
        expect(resumed.remoteReceipt.phase).toBe('committed');
        expect(await readFile(join(f.a, 'practice/b.md'), 'utf8')).toBe('beta');
        expect(await readFile(join(f.b, 'practice/a.md'), 'utf8')).toBe('alpha');
    });
    it('preserves concurrent content explicitly before finishing the recorded session', async () => {
        let touched = false;
        let f: Awaited<ReturnType<typeof fixture>>;
        f = await fixture({ intercept: async (r, next) => { if (r.kind === 'apply' && !touched) {
                touched = true;
                await f.put(f.a, 'practice/x.md', 'new local');
            } return next(); } });
        await f.put(f.b, 'practice/x.md', 'remote');
        await expect(f.service.sync(f.target)).rejects.toMatchObject({ code: 'P2P_RECOVERY_CONFLICT' });
        const recovery = await f.service.resolveRecovery({ ...f.target, preserveCurrent: true });
        expect(await readFile(recovery.local.archives[0]!, 'utf8')).toBe('new local');
        await f.service.resume(f.target);
        expect(await readFile(join(f.a, 'practice/x.md'), 'utf8')).toBe('remote');
    });
    it('retries an already-applied deletion without deleting recreated old bytes', async () => {
        let drop = false;
        const f = await fixture({ intercept: async (r, next) => { if (drop && r.kind === 'finalize') {
                drop = false;
                throw new Error('offline before finalize');
            } return next(); } });
        await f.put(f.a, 'practice/x.md', 'old');
        await f.service.sync(f.target);
        await rm(join(f.b, 'practice/x.md'));
        drop = true;
        await expect(f.service.sync(f.target)).rejects.toThrow();
        await f.put(f.a, 'practice/x.md', 'old');
        await f.service.resume(f.target);
        expect(await readFile(join(f.a, 'practice/x.md'), 'utf8')).toBe('old');
    });
    it('rejects read-only mutations, unknown schemas and forged identity before knowledge writes', async () => {
        const f = await fixture({ readOnly: true });
        await f.put(f.a, 'practice/a.md', 'alpha');
        await expect(f.service.sync(f.target)).rejects.toMatchObject({ code: 'P2P_READ_ONLY' });
        await expect(readFile(join(f.b, 'practice/a.md'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(f.remote.handle({ peerId: f.ai.peerId, certificatePem:f.ai.certificatePem, kind: 'snapshot', metadata: { version: 99 } })).rejects.toThrow();
        await expect(f.remote.handle({ peerId: 'a'.repeat(52), certificatePem:f.ai.certificatePem, kind: 'snapshot', metadata: { version: 1 } })).rejects.toThrow();
    });
    it.each(['upload', 'prepare', 'apply', 'finalize'])('recovers a failure before remote %s without changing the session', async (kind) => {
        let fired = false;
        const f = await fixture({ intercept: async (r, next) => { if (!fired && r.kind === kind) {
                fired = true;
                throw new Error('boundary unavailable');
            } return next(); } });
        await f.put(f.a, 'practice/a.md', 'alpha');
        await f.put(f.b, 'practice/b.md', 'beta');
        await expect(f.service.sync(f.target)).rejects.toThrow();
        const pending = (await f.service.status({ peerId: f.bi.peerId })).local.pending!;
        const result = await f.service.resume(f.target);
        expect(result.sessionId).toBe(pending.sessionId);
        expect(result.localReceipt.phase).toBe('committed');
    });
    it('allows the responder to resume the initiator session after an apply reply is lost', async () => {
        let fail = true;
        const f = await fixture({ intercept: async (r, next) => { const result = await next(); if (fail && r.kind === 'apply') {
                fail = false;
                throw new Error('lost apply reply');
            } return result; } });
        await f.put(f.a, 'practice/a.md', 'alpha');
        await f.put(f.b, 'practice/b.md', 'beta');
        await expect(f.service.sync(f.target)).rejects.toThrow();
        const server = await servePeer({ personalRoot: f.a, bind: '127.0.0.1', port: 0, allowApply: true, handler: f.service.handler });
        handles.push(server);
        const result = await f.remote.resume({ peerId: f.ai.peerId, address: server.address });
        expect(result.localReceipt.phase).toBe('committed');
        expect((await f.service.status({ peerId: f.bi.peerId })).local.pending).toBeNull();
    });
    it('returns busy for opposing operations and never leaves a second prepared session', async () => {
        const f = await fixture();
        const server = await servePeer({ personalRoot: f.a, bind: '127.0.0.1', port: 0, allowApply: true, handler: f.service.handler });
        handles.push(server);
        await f.put(f.a, 'practice/a.md', 'alpha');
        await f.put(f.b, 'practice/b.md', 'beta');
        const results = await Promise.allSettled([f.service.sync(f.target), f.remote.sync({ peerId: f.ai.peerId, address: server.address })]);
        expect(results.some(r => r.status === 'rejected' && r.reason.code === 'P2P_BUSY')).toBe(true);
        const a = (await f.service.status({ peerId: f.bi.peerId })).local.pending, b = (await f.remote.status({ peerId: f.ai.peerId })).local.pending;
        if (a && b)
            expect(a.sessionId).toBe(b.sessionId);
        if (a)
            await f.service.resume(f.target);
        else if (b)
            await f.remote.resume({ peerId: f.ai.peerId, address: server.address });
    });
    it('keeps conflict choices private and rejects upload identity, path, source and byte mismatches', async () => {
        const f = await fixture();
        await f.put(f.a, 'practice/x.md', 'left');
        await f.put(f.b, 'practice/x.md', 'right');
        await f.service.resolveConflict({ ...f.target, path: 'practice/x.md', strategy: 'local' });
        expect((await stat(join(f.a, '.p2p', 'peers', f.bi.peerId, 'resolutions.json'))).mode & 0o777).toBe(0o600);
        const plan = await f.service.preview(f.target);
        const client = await connectPeer({ personalRoot: f.a, ...f.target });
        handles.push(client);
        const sessionId = 'bad-upload';
        const source = plan.remoteOperations[0]!.source!;
        await expect(client.upload('upload', { version: 1, sessionId, plan, path: source.path, sha256: source.sha256 }, Buffer.from('damaged'))).rejects.toThrow();
        await expect(client.download('download', { version: 1, path: '../private', sha256: source.sha256 })).rejects.toThrow();
        await expect(client.request('prepare', { version: 1, sessionId, plan, role: 'local' })).rejects.toThrow();
        expect((await f.remote.status({ peerId: f.ai.peerId })).local.pending).toBeNull();
    });
    it.each(['local', 'remote', 'both', 'skip'] as const)('handles the %s strategy for an edit/delete conflict', async (strategy) => {
        const f = await fixture();
        await f.put(f.a, 'practice/x.md', 'base');
        await f.service.sync(f.target);
        await f.put(f.a, 'practice/x.md', 'left');
        await rm(join(f.b, 'practice/x.md'));
        await f.service.resolveConflict({ ...f.target, path: 'practice/x.md', strategy });
        await f.service.sync(f.target);
        if (strategy === 'remote') {
            await expect(readFile(join(f.a, 'practice/x.md'))).rejects.toMatchObject({ code: 'ENOENT' });
        }
        else {
            expect(await readFile(join(f.a, 'practice/x.md'), 'utf8')).toBe('left');
            if (strategy !== 'skip')
                expect(await readFile(join(f.b, 'practice/x.md'), 'utf8')).toBe('left');
        }
    });
});


describe('review admission over real mutual TLS', () => {
  it.each(['missing','prepared'] as const)('replans a stale never-applied session when responder journal is %s',async(boundary)=>{
    let changed=false;let f:Awaited<ReturnType<typeof fixture>>;
    f=await fixture({intercept:async(r,next)=>{
      if(!changed && r.kind==='prepare'){
        changed=true;
        if(boundary==='prepared'){await next();await f.put(f.b,'practice/b.md','edited');throw new Error('lost prepare');}
        await f.put(f.b,'practice/b.md','edited');
      }
      return next();
    }});
    await f.put(f.a,'practice/a.md','alpha');await f.put(f.b,'practice/b.md','beta');
    await expect(f.service.sync(f.target)).rejects.toThrow();
    const old=(await f.service.status({peerId:f.bi.peerId})).local.pending!;
    expect(old.phase).toBe('prepared');
    if(boundary==='missing'){
      await expect(f.service.resolveRecovery({...f.target,preserveCurrent:true})).rejects.toMatchObject({code:'P2P_RECOVERY_REPLAN_REQUIRED'});
      expect((await new PeerStore(f.ar,f.bi.peerId).status(old.sessionId)).phase).toBe('prepared');
      await expect(stat(join(f.a,'.p2p','peers',f.bi.peerId,'sessions',old.sessionId,'recovered'))).rejects.toMatchObject({code:'ENOENT'});
    }
    const result=await new PeerService(f.ar).resume(f.target);
    expect(result.sessionId).not.toBe(old.sessionId);
    expect((await new PeerStore(f.ar,f.bi.peerId).status(old.sessionId)).phase).toBe('aborted');
    if(boundary==='prepared')expect((await new PeerStore(f.br,f.ai.peerId).status(old.sessionId)).phase).toBe('aborted');
    expect(await readFile(join(f.a,'practice/b.md'),'utf8')).toBe('edited');
    expect(result.localReceipt.phase).toBe('committed');
  });
  it('rechecks trust after a controlled download/forget interleaving before staging or prepare',async()=>{
    let forgotten=false;let f:Awaited<ReturnType<typeof fixture>>;
    f=await fixture({intercept:async(r,next)=>{
      const result=await next();
      if(r.kind==='download'&&!forgotten){forgotten=true;await forgetPeer(f.a,f.bi.peerId);}
      return result;
    }});
    await f.put(f.b,'practice/b.md','beta');
    await expect(f.service.sync(f.target)).rejects.toMatchObject({code:'P2P_PEER_UNTRUSTED'});
    expect(await getTrustedPeer(f.a)).toBeUndefined();
    expect(await new PeerStore(f.ar,f.bi.peerId).pending()).toBeUndefined();
    await expect(readFile(join(f.a,'practice/b.md'))).rejects.toMatchObject({code:'ENOENT'});
    await expect(stat(join(f.a,'.p2p','peers',f.bi.peerId))).rejects.toMatchObject({code:'ENOENT'});
  });
  it.each(['index.md','capabilities.json'])('keeps %s Both archives in later snapshots, no-op sync and export',async(path)=>{
    const f=await fixture();
    const left=path==='index.md'?'left':JSON.stringify({version:1,records:[]});
    const right=path==='index.md'?'right':JSON.stringify({version:1,records:[]},null,2);
    await f.put(f.a,path,left);await f.put(f.b,path,right);
    await f.service.resolveConflict({...f.target,path,strategy:'both'});
    const first=await f.service.sync(f.target);
    const archive=first.plan.localTarget.entries.find(e=>e.path.includes('.conflict-'))!;
    const state=await f.service.status(f.target);
    expect(state.local.snapshot.entries.map(e=>e.path)).toContain(archive.path);
    expect(state.remote!.snapshot.entries.map(e=>e.path)).toContain(archive.path);
    const next=await f.service.sync(f.target);
    expect(next.plan.localOperations).toEqual([]);expect(next.plan.remoteOperations).toEqual([]);
    const exported=await new PersonalAssetService(f.ar,{clock:()=>new Date()}).exportPersonal(join(f.a,'..','export'));
    expect(await readFile(join(exported.exportRoot,archive.path),'utf8')).toBe(left);
  });
  it('rejects 1500 tiny assets whose full plan envelopes exceed metadata limits before durable admission',async()=>{
    const f=await fixture();
    for(let i=0;i<1500;i++)await f.put(f.a,`practice/${String(i).padStart(4,'0')}.md`,'x');
    await expect(f.service.sync(f.target)).rejects.toMatchObject({code:'P2P_METADATA_LIMIT'});
    expect(await new PeerStore(f.ar,f.bi.peerId).pending()).toBeUndefined();
    expect(await new PeerStore(f.br,f.ai.peerId).pending()).toBeUndefined();
    await expect(stat(join(f.a,'.p2p','peers',f.bi.peerId,'sessions'))).rejects.toMatchObject({code:'ENOENT'});
    await expect(stat(join(f.b,'practice'))).rejects.toMatchObject({code:'ENOENT'});
  },30000);
});


describe('review recovery safety boundaries',()=>{
  it('recovers a lost abort reply without resurrecting the old prepared plan',async()=>{
    let prepared=false,aborted=false;let f:Awaited<ReturnType<typeof fixture>>;
    f=await fixture({intercept:async(r,next)=>{
      const result=await next();
      if(r.kind==='prepare'&&!prepared){prepared=true;await f.put(f.b,'practice/b.md','changed');throw new Error('lost prepare');}
      if(r.kind==='abort-prepared'&&!aborted){aborted=true;throw new Error('lost abort');}
      return result;
    }});
    await f.put(f.a,'practice/a.md','alpha');await f.put(f.b,'practice/b.md','beta');
    await expect(f.service.sync(f.target)).rejects.toThrow();
    const old=(await new PeerStore(f.ar,f.bi.peerId).pending())!;
    await expect(f.service.resume(f.target)).rejects.toThrow();
    expect((await new PeerStore(f.br,f.ai.peerId).status(old.sessionId)).phase).toBe('aborted');
    expect((await new PeerStore(f.ar,f.bi.peerId).status(old.sessionId)).phase).toBe('prepared');
    const result=await f.service.resume(f.target);
    expect(result.sessionId).not.toBe(old.sessionId);
    expect(await readFile(join(f.a,'practice/b.md'),'utf8')).toBe('changed');
  });
  it('never aborts when the remote begins recovery before abort admission',async()=>{
    let prepared=false;let f:Awaited<ReturnType<typeof fixture>>;
    f=await fixture({intercept:async(r,next)=>{
      if(r.kind==='abort-prepared')await new PeerStore(f.br,f.ai.peerId).resolveRecovery(String(r.metadata.sessionId),{preserveCurrent:true});
      const result=await next();
      if(r.kind==='prepare'&&!prepared){prepared=true;await f.put(f.b,'practice/b.md','changed');throw new Error('lost prepare');}
      return result;
    }});
    await f.put(f.a,'practice/a.md','alpha');await f.put(f.b,'practice/b.md','beta');
    await expect(f.service.sync(f.target)).rejects.toThrow();
    const old=(await new PeerStore(f.ar,f.bi.peerId).pending())!;
    await expect(f.service.resume(f.target)).rejects.toMatchObject({code:'P2P_SESSION_STARTED'});
    expect((await new PeerStore(f.ar,f.bi.peerId).status(old.sessionId)).phase).toBe('prepared');
    expect((await new PeerStore(f.br,f.ai.peerId).status(old.sessionId)).phase).toBe('applying');
  });
  it('keeps forgetting blocked once local preparation has reserved the session',async()=>{
    let rejected=false;let f:Awaited<ReturnType<typeof fixture>>;
    f=await fixture({intercept:async(r,next)=>{
      if(r.kind==='upload'&&!rejected){await expect(forgetPeer(f.a,f.bi.peerId)).rejects.toThrow(/unfinished pending/);rejected=true;}
      return next();
    }});
    await f.put(f.a,'practice/a.md','alpha');
    await f.service.sync(f.target);
    expect(rejected).toBe(true);expect(await getTrustedPeer(f.a)).toBeDefined();
  });
  it('rechecks trust at responder admission after authentication but before upload staging',async()=>{
    let revoked=false;let f:Awaited<ReturnType<typeof fixture>>;
    f=await fixture({intercept:async(r,next)=>{
      if(r.kind==='upload'&&!revoked){revoked=true;await forgetPeer(f.b,f.ai.peerId);}
      return next();
    }});
    await f.put(f.a,'practice/a.md','alpha');
    await expect(f.service.sync(f.target)).rejects.toMatchObject({code:'P2P_PEER_UNTRUSTED'});
    expect(await new PeerStore(f.br,f.ai.peerId).pending()).toBeUndefined();
    await expect(stat(join(f.b,'.p2p','peers',f.ai.peerId))).rejects.toMatchObject({code:'ENOENT'});
    await expect(stat(join(f.b,'practice'))).rejects.toMatchObject({code:'ENOENT'});
  });
});

it('resumes archived malformed responder content using journals before taking another snapshot',async()=>{
  let edited=false;let f:Awaited<ReturnType<typeof fixture>>;
  f=await fixture({intercept:async(r,next)=>{
    if(r.kind==='apply'&&!edited){edited=true;await f.put(f.b,'capabilities.json','{partial responder');}
    return next();
  }});
  const valid=JSON.stringify({version:1,records:[]});
  await f.put(f.a,'capabilities.json',valid);
  await expect(f.service.sync(f.target)).rejects.toThrow();
  const pending=(await new PeerStore(f.ar,f.bi.peerId).pending())!;
  const recovery=await f.service.resolveRecovery({...f.target,preserveCurrent:true});
  expect(await readFile(recovery.remote.archives[0]!,'utf8')).toBe('{partial responder');
  const result=await new PeerService(f.ar).resume(f.target);
  expect(result.sessionId).toBe(pending.sessionId);
  expect(result.localReceipt.phase).toBe('committed');
  expect(result.remoteReceipt.phase).toBe('committed');
  expect(await readFile(join(f.b,'capabilities.json'),'utf8')).toBe(valid);
});
