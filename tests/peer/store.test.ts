import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PersonalRepository } from '../../src/storage/personal-repository.js';
import { resolvePaths } from '../../src/storage/paths.js';
import { buildPeerPlan, emptyBaseline, makeSnapshot } from '../../src/peer/planner.js';
import { PeerStore, type PeerJournal } from '../../src/peer/store.js';

const localId = 'a'.repeat(52), remoteId = 'b'.repeat(52);
const roots: string[] = [];
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gmem-peer-store-')); roots.push(root);
  const personal = join(root, 'personal'); await mkdir(personal);
  const repository = new PersonalRepository(resolvePaths(join(root, 'project'), personal));
  return { root, personal, repository, store: new PeerStore(repository, remoteId) };
}
function snap(id: string, entries: Record<string, string>) {
  return makeSnapshot(id, Object.entries(entries).map(([path, s]) => ({ path, sha256: hash(s), bytes: Buffer.byteLength(s) })));
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });

describe('recoverable peer storage', () => {
  it('stages a remote addition, survives restart and requires both receipts before advancing base', async () => {
    const { personal, repository, store } = await setup();
    const plan = buildPeerPlan({local:snap(localId,{}),remote:snap(remoteId,{'practice/r.md':'remote'}),base:emptyBaseline()});
    const sessionId = randomUUID();
    await store.prepare({sessionId,plan,role:'local',payloads:{[hash('remote')]:Buffer.from('remote')}});
    await expect(readFile(join(personal,'practice/r.md'))).rejects.toMatchObject({code:'ENOENT'});
    const restarted = new PeerStore(repository, remoteId);
    const receipt = await restarted.apply(sessionId);
    expect(await readFile(join(personal,'practice/r.md'),'utf8')).toBe('remote');
    expect((await restarted.readBaseline()).generation).toBe(0);
    await expect(restarted.finalize(sessionId,{...receipt,peerId:localId})).rejects.toMatchObject({code:'P2P_RECEIPT_MISMATCH'});
    await restarted.finalize(sessionId,{...receipt,peerId:remoteId});
    expect((await restarted.readBaseline()).entries['practice/r.md']).toBe(hash('remote'));
    expect(await restarted.pending()).toBeUndefined();
    expect((await restarted.finalize(sessionId,{...receipt,peerId:remoteId})).phase).toBe('committed');
    expect((await stat(join(personal,'.p2p','peers',remoteId,'state.json'))).mode & 0o777).toBe(0o600);
  });

  it('does not re-delete a file recreated with old bytes after an already applied operation', async () => {
    const {personal,store} = await setup();
    await mkdir(join(personal,'practice'));
    await writeFile(join(personal,'practice/x.md'),'old');
    const initial = buildPeerPlan({local:snap(localId,{'practice/x.md':'old'}),remote:snap(remoteId,{'practice/x.md':'old'}),base:emptyBaseline()});
    const firstId=randomUUID(); await store.prepare({sessionId:firstId,plan:initial,role:'local',payloads:{}});
    const firstReceipt=await store.apply(firstId); await store.finalize(firstId,{...firstReceipt,peerId:remoteId});
    const agreed=await store.readBaseline();
    const plan = buildPeerPlan({local:snap(localId,{'practice/x.md':'old'}),remote:snap(remoteId,{}),base:agreed});
    const sessionId=randomUUID(); await store.prepare({sessionId,plan,role:'local',payloads:{}});
    const receipt=await store.apply(sessionId);
    await writeFile(join(personal,'practice/x.md'),'old');
    expect(await store.apply(sessionId)).toEqual(receipt);
    expect(await readFile(join(personal,'practice/x.md'),'utf8')).toBe('old');
  });

  it('preserves a local edit after preparation and offers explicit archive-and-resume recovery', async () => {
    const {personal,store}=await setup();
    const plan=buildPeerPlan({local:snap(localId,{}),remote:snap(remoteId,{'practice/r.md':'remote'}),base:emptyBaseline()});
    const sessionId=randomUUID(); await store.prepare({sessionId,plan,role:'local',payloads:{[hash('remote')]:Buffer.from('remote')}});
    await mkdir(join(personal,'practice')); await writeFile(join(personal,'practice/r.md'),'my new edit');
    await expect(store.apply(sessionId)).rejects.toMatchObject({code:'P2P_RECOVERY_CONFLICT'});
    expect(await readFile(join(personal,'practice/r.md'),'utf8')).toBe('my new edit');
    const resolved=await store.resolveRecovery(sessionId,{preserveCurrent:true});
    expect(await readFile(resolved.archives[0]!, 'utf8')).toBe('my new edit');
    await store.apply(sessionId);
    expect(await readFile(join(personal,'practice/r.md'),'utf8')).toBe('remote');
  });

  it('rejects damaged bytes before making a pending session or changing knowledge', async () => {
    const {store}=await setup();
    const plan=buildPeerPlan({local:snap(localId,{}),remote:snap(remoteId,{'practice/r.md':'remote'}),base:emptyBaseline()});
    await expect(store.prepare({sessionId:randomUUID(),plan,role:'local',payloads:{[hash('remote')]:Buffer.from('damaged')}})).rejects.toMatchObject({code:'P2P_PAYLOAD_INVALID'});
    expect(await store.pending()).toBeUndefined();
  });

  it('restores a missing pending pointer when preparation retries an already durable journal', async () => {
    const {personal,store}=await setup();
    const plan=buildPeerPlan({local:snap(localId,{}),remote:snap(remoteId,{'practice/r.md':'remote'}),base:emptyBaseline()});
    const sessionId=randomUUID(); const input={sessionId,plan,role:'local' as const,payloads:{[hash('remote')]:Buffer.from('remote')}};
    await store.prepare(input);
    await rm(join(personal,'.p2p','peers',remoteId,'pending.json'));
    await store.prepare(input);
    expect((await store.pending())?.sessionId).toBe(sessionId);
  });

  it('rejects a personal root that is actually the selected project memory', async()=>{
    const {root}=await setup();
    const project=join(root,'mixed');const personal=join(project,'.growth-memory');await mkdir(join(personal,'reviews'),{recursive:true});
    await writeFile(join(personal,'reviews/raw.json'),JSON.stringify({rawHumanResponse:'private project response'}));
    const store=new PeerStore(new PersonalRepository(resolvePaths(project,personal)),remoteId);
    await expect(store.snapshot(localId)).rejects.toMatchObject({code:'STORAGE_ROOT_CONFLICT'});
  });

  it('does not repeat a deletion if the process stopped after removal but before its done record', async()=>{
    const {personal,store}=await setup();await mkdir(join(personal,'practice'));await writeFile(join(personal,'practice/x.md'),'old');
    const initial=buildPeerPlan({local:snap(localId,{'practice/x.md':'old'}),remote:snap(remoteId,{'practice/x.md':'old'}),base:emptyBaseline()});
    const firstId=randomUUID();await store.prepare({sessionId:firstId,plan:initial,role:'local',payloads:{}});
    await store.finalize(firstId,{...await store.apply(firstId),peerId:remoteId});
    const plan=buildPeerPlan({local:snap(localId,{'practice/x.md':'old'}),remote:snap(remoteId,{}),base:await store.readBaseline()});
    const id=randomUUID();await store.prepare({sessionId:id,plan,role:'local',payloads:{}});await store.apply(id);
    // Reconstruct the durable crash boundary: rename happened; the done/receipt writes did not.
    const path=join(personal,'.p2p','peers',remoteId,'sessions',id,'journal.json');
    const journal=JSON.parse(await readFile(path,'utf8')) as PeerJournal;
    journal.phase='applying';journal.receipt=null;journal.operations[0]!.state='intent';await writeFile(path,JSON.stringify(journal));
    await writeFile(join(personal,'practice/x.md'),'old');
    await expect(store.apply(id)).rejects.toMatchObject({code:'P2P_RECOVERY_CONFLICT'});
    expect(await readFile(join(personal,'practice/x.md'),'utf8')).toBe('old');
  });

  it('can install an agreed file where only an empty local directory remains',async()=>{
    const {personal,store}=await setup();await mkdir(join(personal,'practice/guide'),{recursive:true});
    const plan=buildPeerPlan({local:snap(localId,{}),remote:snap(remoteId,{'practice/guide':'text'}),base:emptyBaseline()});
    const id=randomUUID();await store.prepare({sessionId:id,plan,role:'local',payloads:{[hash('text')]:Buffer.from('text')}});
    await store.apply(id);
    expect(await readFile(join(personal,'practice/guide'),'utf8')).toBe('text');
  });
});


describe('review recovery admission', () => {
  it('aborts only untouched prepared journals, retains evidence and never resurrects them', async () => {
    const {store,personal}=await setup();
    const plan=buildPeerPlan({local:snap(localId,{}),remote:snap(remoteId,{'practice/r.md':'remote'}),base:emptyBaseline()});
    const input={sessionId:'aborted',plan,role:'local' as const,payloads:{[hash('remote')]:Buffer.from('remote')}};
    await store.prepare(input);
    await store.abortPrepared(input.sessionId);
    expect((await store.status(input.sessionId)).phase).toBe('aborted');
    expect(await store.pending()).toBeUndefined();
    await expect(store.apply(input.sessionId)).rejects.toMatchObject({code:'P2P_SESSION_ABORTED'});
    await expect(store.prepare(input)).rejects.toMatchObject({code:'P2P_SESSION_ABORTED'});
    await expect(store.resolveRecovery(input.sessionId,{preserveCurrent:true})).rejects.toMatchObject({code:'P2P_SESSION_ABORTED'});
    const next={...input,sessionId:'next'};await store.prepare(next);
    await store.abortPrepared(input.sessionId);
    expect((await store.pending())?.sessionId).toBe('next');
    await store.apply('next');
    await expect(store.abortPrepared('next')).rejects.toMatchObject({code:'P2P_SESSION_STARTED'});
    expect(await readFile(join(personal,'practice/r.md'),'utf8')).toBe('remote');
  });
  it('archives exact malformed capability bytes and then completes the valid prepared plan', async () => {
    const {store,personal}=await setup();
    const valid=JSON.stringify({version:1,records:[]});
    const plan=buildPeerPlan({local:snap(localId,{}),remote:snap(remoteId,{'capabilities.json':valid}),base:emptyBaseline()});
    await store.prepare({sessionId:'partial-json',plan,role:'local',payloads:{[hash(valid)]:Buffer.from(valid)}});
    await writeFile(join(personal,'capabilities.json'),'{partial');
    await expect(store.apply('partial-json')).rejects.toThrow();
    const recovery=await store.resolveRecovery('partial-json',{preserveCurrent:true});
    expect(await readFile(recovery.archives[0]!,'utf8')).toBe('{partial');
    await store.apply('partial-json');
    expect(await readFile(join(personal,'capabilities.json'),'utf8')).toBe(valid);
  });
  it('includes recognized root archives and rejects symlink archives', async () => {
    const {store,personal}=await setup();
    const path='index.conflict-20261105-120000-local.md';
    await writeFile(join(personal,path),'archive');
    expect((await store.snapshot(localId)).entries.map(e=>e.path)).toContain(path);
    await rm(join(personal,path));await symlink(join(personal,'index.md'),join(personal,path));
    await expect(store.snapshot(localId)).rejects.toMatchObject({code:'UNSAFE_PATH'});
  });
});


it('rejects oversized current recovery bytes before archiving or changing the journal',async()=>{
  const {store,personal}=await setup();
  const plan=buildPeerPlan({local:snap(localId,{}),remote:snap(remoteId,{'practice/a.md':'a','practice/b.md':'b'}),base:emptyBaseline()});
  await store.prepare({sessionId:'oversized-recovery',plan,role:'local',payloads:{[hash('a')]:Buffer.from('a'),[hash('b')]:Buffer.from('b')}});
  await mkdir(join(personal,'practice'));await writeFile(join(personal,'practice/a.md'),'changed');
  await writeFile(join(personal,'practice/b.md'),Buffer.alloc(8*1024*1024+1));
  await expect(store.resolveRecovery('oversized-recovery',{preserveCurrent:true})).rejects.toMatchObject({code:'P2P_LIMIT_EXCEEDED'});
  expect((await store.status('oversized-recovery')).phase).toBe('prepared');
  await expect(stat(join(personal,'.p2p','peers',remoteId,'sessions','oversized-recovery','recovered'))).rejects.toMatchObject({code:'ENOENT'});
});

it('bounds aggregate current recovery bytes before retaining archives or changing the journal',async()=>{
  const {store,personal}=await setup();
  const entries=Object.fromEntries(Array.from({length:9},(_,i)=>[`practice/${i}.md`,'a']));
  const plan=buildPeerPlan({local:snap(localId,{}),remote:snap(remoteId,entries),base:emptyBaseline()});
  await store.prepare({sessionId:'aggregate-recovery',plan,role:'local',payloads:{[hash('a')]:Buffer.from('a')}});
  await mkdir(join(personal,'practice'));
  const bytes=Buffer.alloc(8*1024*1024,120);
  for(const path of Object.keys(entries))await writeFile(join(personal,path),bytes);
  await expect(store.resolveRecovery('aggregate-recovery',{preserveCurrent:true})).rejects.toMatchObject({code:'P2P_LIMIT_EXCEEDED'});
  expect((await store.status('aggregate-recovery')).phase).toBe('prepared');
  await expect(stat(join(personal,'.p2p','peers',remoteId,'sessions','aggregate-recovery','recovered'))).rejects.toMatchObject({code:'ENOENT'});
});
