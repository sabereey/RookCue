import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DomainError } from '../domain/errors.js';
import { isPersonalKnowledgeAsset, validatePersonalAsset } from '../personal/personal-asset-paths.js';
import { PersonalRepository } from '../storage/personal-repository.js';
import { assertSeparateStorageRoots, safeChildPath } from '../storage/paths.js';
import { assertSafePath, isMissing } from '../storage/snapshot-files.js';
import { emptyBaseline, makeBaseline, makeSnapshot, stableDigest, validateBaseline, validatePeerPlan,
  type PeerBaseline, type PeerOperation, type PeerPlan, type PeerSnapshot } from './planner.js';

export type PeerReceipt = { sessionId: string; planDigest: string; peerId: string; phase: 'applied' | 'committed' };
type OperationState = { operation: PeerOperation; state: 'pending' | 'intent' | 'done'; attempt: number; overrideBefore?: string | null };
export type PeerJournal = { version: 1; sessionId: string; role: 'local' | 'remote'; plan: PeerPlan;
  phase: 'prepared' | 'applying' | 'applied' | 'committed' | 'aborted'; operations: OperationState[]; receipt: PeerReceipt | null };
export type PreparePeerSession = { sessionId: string; plan: PeerPlan; role: 'local' | 'remote'; payloads: Record<string, Buffer> };
const digestBytes = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const validId = /^[a-zA-Z0-9_-]{1,128}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const fail = (code: string, message: string, details: Record<string, unknown> = {}): never => { throw new DomainError(code, message, details); };

/** Durable endpoint state. Networking and ownership of the other endpoint belong to PeerService. */
export class PeerStore {
  readonly root: string;
  constructor(readonly repository: PersonalRepository, readonly peerId: string) {
    if (!/^[a-z2-7]{52}$/.test(peerId)) fail('P2P_PEER_INVALID', 'Invalid peer identity');
    this.root = repository.paths.personal.base;
  }
  private path(...parts: string[]): string {
    let current = safeChildPath(this.root, '.p2p');
    for (const part of parts) current = safeChildPath(current, part);
    return current;
  }
  private sessionPath(id: string, ...parts: string[]): string {
    if (!validId.test(id)) fail('P2P_SESSION_INVALID', 'Invalid session identifier');
    return this.path('peers', this.peerId, 'sessions', id, ...parts);
  }
  private async directory(path: string): Promise<void> {
    await assertSafePath(path, 'directory', this.root);
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  private async privateRead(path: string): Promise<Buffer | undefined> {
    if (!await assertSafePath(path, 'file', this.root)) return undefined;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return await handle.readFile(); } finally { await handle.close(); }
  }
  private async flushDirectory(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try { await handle.sync(); }
    catch (error) { if (!(typeof error === 'object' && error && 'code' in error && ['EINVAL','ENOTSUP'].includes(String(error.code)))) throw error; }
    finally { await handle.close(); }
  }
  private async writePrivate(path: string, bytes: Buffer): Promise<void> {
    await this.directory(dirname(path)); await assertSafePath(path, 'file', this.root);
    const temp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temp, path); await this.flushDirectory(dirname(path)); }
    finally { await rm(temp, {force:true}); }
  }
  private async json(path: string, data: unknown): Promise<void> { await this.writePrivate(path, Buffer.from(JSON.stringify(data))); }
  private async readJson(path: string): Promise<unknown | undefined> {
    const bytes = await this.privateRead(path);
    if (!bytes) return undefined;
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { return fail('P2P_STATE_INVALID', 'Invalid persisted peer state', {path}); }
  }
  private journalPath(id: string): string { return this.sessionPath(id, 'journal.json'); }
  private async save(journal: PeerJournal): Promise<void> { await this.json(this.journalPath(journal.sessionId), journal); }
  private ownId(journal: PeerJournal): string { return journal.role === 'local' ? journal.plan.localPeerId : journal.plan.remotePeerId; }
  private receipt(journal: PeerJournal, phase: PeerReceipt['phase']): PeerReceipt {
    return {sessionId:journal.sessionId,planDigest:journal.plan.digest,peerId:this.ownId(journal),phase};
  }
  async status(sessionId: string): Promise<PeerJournal> {
    const data = await this.readJson(this.journalPath(sessionId));
    if (!data || typeof data !== 'object') return fail('P2P_SESSION_NOT_FOUND', 'Peer session not found', {sessionId});
    const journal = data as PeerJournal;
    const plan = validatePeerPlan(journal.plan);
    if (journal.version !== 1 || journal.sessionId !== sessionId || !['local','remote'].includes(journal.role) ||
        !['prepared','applying','applied','committed','aborted'].includes(journal.phase) || !Array.isArray(journal.operations)) {
      return fail('P2P_STATE_INVALID', 'Invalid peer journal');
    }
    const operations = journal.role === 'local' ? plan.localOperations : plan.remoteOperations;
    if (operations.length !== journal.operations.length || journal.operations.some((item,index) =>
      stableDigest(item.operation) !== stableDigest(operations[index]) || !['pending','intent','done'].includes(item.state) ||
      !Number.isInteger(item.attempt) || item.attempt < 0 || item.attempt > 100 ||
      (item.overrideBefore !== undefined && item.overrideBefore !== null && !hashPattern.test(item.overrideBefore)))) {
      return fail('P2P_STATE_INVALID','Invalid peer operation journal');
    }
    const remote = journal.role === 'local' ? plan.remotePeerId : plan.localPeerId;
    if (remote !== this.peerId) return fail('P2P_STATE_INVALID','Journal belongs to another peer');
    if (journal.receipt && stableDigest(journal.receipt) !== stableDigest(this.receipt(journal,journal.phase === 'committed' ? 'committed':'applied'))) {
      return fail('P2P_STATE_INVALID','Invalid local receipt');
    }
    return {...journal, plan};
  }
  async pending(): Promise<PeerJournal | undefined> {
    const pointer = await this.readJson(this.path('peers', this.peerId, 'pending.json'));
    if (pointer === undefined) return undefined;
    if (!pointer || typeof pointer !== 'object' || !('sessionId' in pointer) || typeof pointer.sessionId !== 'string') return fail('P2P_STATE_INVALID','Invalid pending session');
    return this.status(pointer.sessionId);
  }
  async readBaseline(): Promise<PeerBaseline> {
    const data = await this.readJson(this.path('peers',this.peerId,'state.json'));
    return data === undefined ? emptyBaseline() : validateBaseline(data);
  }
  private async asset(path: string, raw = false): Promise<Buffer | undefined> {
    if (!isPersonalKnowledgeAsset(path)) return fail('P2P_PATH_UNSUPPORTED','Path is outside personal assets',{path});
    const target = safeChildPath(this.root,path);
    const info=await lstat(target).catch(error=>{if(isMissing(error))return undefined;throw error;});
    if(info?.isDirectory()){await assertSafePath(target,'directory',this.root);return undefined;}
    if (!await assertSafePath(target,'file',this.root)) return undefined;
    if (!raw) return this.repository.readPersonalFile(path);
    return this.recoveryBytes(target);
  }
  // Preserve partial external edits without parsing them, but never retain an 8 MiB
  // allocation for every tiny file. Bounds also cover displaced recovery evidence.
  private async recoveryBytes(target:string):Promise<Buffer|undefined>{
    if(!await assertSafePath(target,'file',this.root))return undefined;
    const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      if(!(await handle.stat()).isFile())return fail('UNSAFE_PATH','Recovery source must be a regular file');
      const limit=8*1024*1024;
      if((await handle.stat()).size>limit)return fail('P2P_LIMIT_EXCEEDED','Recovery content exceeds 8 MiB; preserve it externally before retrying');
      const chunks:Buffer[]=[];let count=0;
      while(count<=limit){
        const chunk=Buffer.alloc(Math.min(64*1024,limit+1-count));
        const read=await handle.read(chunk,0,chunk.length,null);if(!read.bytesRead)break;
        count+=read.bytesRead;
        if(count>limit)return fail('P2P_LIMIT_EXCEEDED','Recovery content exceeds 8 MiB; preserve it externally before retrying');
        chunks.push(chunk.subarray(0,read.bytesRead));
      }
      return Buffer.concat(chunks,count);
    } finally {await handle.close();}
  }
  private async hashAt(path: string): Promise<string | null> { const bytes=await this.asset(path,true); return bytes ? digestBytes(bytes):null; }
  async snapshot(localPeerId: string): Promise<PeerSnapshot> {
    await assertSeparateStorageRoots(this.repository.paths);
    return this.repository.withMutationLock(async()=> {
      const entries: Array<{path:string;sha256:string;bytes:number}>=[];
      let total=0;
      const walk=async(relative: string):Promise<void>=> {
        const path=safeChildPath(this.root,relative);
        const exists=await assertSafePath(path,'directory',this.root); if(!exists)return;
        for(const item of await readdir(path,{withFileTypes:true})) {
          if(item.name.startsWith('._'))continue;
          const child=`${relative}/${item.name}`;
          if(item.isSymbolicLink())fail('UNSAFE_PATH','Symbolic links are not peer assets',{path:child});
          if(item.isDirectory())await walk(child);
          else if(item.isFile() && isPersonalKnowledgeAsset(child)) await add(child);
        }
      };
      const add=async(path: string)=> {
        const bytes=await this.asset(path); if(!bytes)return;
        if(bytes.length>8*1024*1024 || (total+=bytes.length)>64*1024*1024 || entries.length>=4096)fail('P2P_LIMIT_EXCEEDED','Personal snapshot exceeds peer limits');
        entries.push({path,sha256:digestBytes(bytes),bytes:bytes.length});
      };
      for(const dir of ['concepts','reviews','practice','growth'])await walk(dir);
      for(const item of await readdir(this.root,{withFileTypes:true})) {
        if(!isPersonalKnowledgeAsset(item.name))continue;
        if(item.isSymbolicLink())fail('UNSAFE_PATH','Symbolic links are not peer assets',{path:item.name});
        if(item.isFile())await add(item.name);
      }
      return makeSnapshot(localPeerId,entries);
    });
  }
  async prepare(input: PreparePeerSession): Promise<PeerJournal> {
    const plan=validatePeerPlan(input.plan);
    if(plan.conflicts.some(conflict=>conflict.resolution===null))return fail('P2P_SYNC_CONFLICT','Resolve conflicts before applying');
    if(input.role!=='local'&&input.role!=='remote')return fail('P2P_SESSION_INVALID','Invalid endpoint role');
    const otherId=input.role==='local'?plan.remotePeerId:plan.localPeerId;
    if(otherId!==this.peerId)return fail('P2P_PEER_MISMATCH','Plan belongs to a different peer');
    this.sessionPath(input.sessionId);
    return this.repository.withMutationLock(async()=>{
      const pending=await this.pending();
      if(pending && (pending.sessionId!==input.sessionId || pending.plan.digest!==plan.digest))return fail('P2P_BUSY','Another peer session is pending',{sessionId:pending.sessionId});
      if(pending){if(pending.phase==='aborted')return fail('P2P_SESSION_ABORTED','Session was aborted; compute a new plan');return pending;}
      const old=await this.readJson(this.journalPath(input.sessionId));
      if(old!==undefined){
        const journal=await this.status(input.sessionId);
        if(journal.phase==='aborted')return fail('P2P_SESSION_ABORTED','Session was aborted; compute a new plan');
        if(journal.plan.digest!==plan.digest)return fail('P2P_SESSION_MISMATCH','Session identifier already used');
        if(journal.phase!=='committed')await this.json(this.path('peers',this.peerId,'pending.json'),{sessionId:input.sessionId});
        return journal;
      }
      const baseline=await this.readBaseline();
      if(baseline.digest!==plan.baseBaseline.digest)return fail('P2P_BASE_MISMATCH','Peer baseline changed');
      const ownSnapshot=input.role==='local'?plan.localSnapshot:plan.remoteSnapshot;
      if((await this.snapshot(ownSnapshot.peerId)).digest!==ownSnapshot.digest)return fail('P2P_SNAPSHOT_CHANGED','Personal assets changed before preparation');
      const operations=input.role==='local'?plan.localOperations:plan.remoteOperations;
      const required=new Map<string,Buffer>(); let total=0;
      for(const operation of operations){
        if(operation.after===null)continue;
        const source=operation.source;
        if(!source)return fail('P2P_PAYLOAD_INVALID','Missing operation payload');
        const bytes=input.payloads[source.sha256] ?? (source.side===input.role ? await this.asset(source.path):undefined);
        if(!bytes || digestBytes(bytes)!==operation.after || bytes.length>8*1024*1024 || (total+=bytes.length)>64*1024*1024)return fail('P2P_PAYLOAD_INVALID','Invalid or missing peer payload',{path:operation.path});
        validatePersonalAsset(operation.path,bytes); required.set(operation.after,bytes);
      }
      for(const [hash,bytes]of required)await this.writePrivate(this.sessionPath(input.sessionId,'payloads',hash),bytes);
      const journal:PeerJournal={version:1,sessionId:input.sessionId,role:input.role,plan,phase:'prepared',
        operations:operations.map(operation=>({operation,state:'pending',attempt:0})),receipt:null};
      await this.save(journal);
      await this.json(this.path('peers',this.peerId,'pending.json'),{sessionId:input.sessionId});
      return journal;
    });
  }
  /** Only the orchestrator may decide that both endpoints are safe to abandon. */
  async abortPrepared(sessionId:string):Promise<PeerJournal>{
    return this.repository.withMutationLock(async()=>{
      const journal=await this.status(sessionId);
      if(journal.phase!=='aborted'){
        if(journal.phase!=='prepared'||journal.receipt||journal.operations.some(item=>item.state!=='pending'||item.attempt!==0||item.overrideBefore!==undefined))
          return fail('P2P_SESSION_STARTED','An applying or applied session must finish its recorded plan');
        journal.phase='aborted';await this.save(journal);
      }
      const pointer=await this.readJson(this.path('peers',this.peerId,'pending.json'));
      if(pointer&&typeof pointer==='object'&&'sessionId'in pointer&&pointer.sessionId===sessionId){
        await rm(this.path('peers',this.peerId,'pending.json'));await this.flushDirectory(this.path('peers',this.peerId));
      }
      return journal;
    });
  }
  private evidencePath(journal:PeerJournal,index:number,state:OperationState,name:string):string {
    return this.sessionPath(journal.sessionId,'operations',`${index}-${state.attempt}`,name);
  }
  private async exists(path:string):Promise<boolean>{return (await this.privateRead(path))!==undefined;}
  private conflict(path:string):never{return fail('P2P_RECOVERY_CONFLICT','Current data differs from prepared operation; preserve it before resuming',{path});}
  private async applyOperation(journal:PeerJournal,index:number):Promise<void>{
    const item=journal.operations[index]!;if(item.state==='done')return;
    const op=item.operation;
    const target=safeChildPath(this.root,op.path);
    const displaced=this.evidencePath(journal,index,item,'displaced');
    const install=this.evidencePath(journal,index,item,'installation');
    const expected=item.overrideBefore===undefined?op.before:item.overrideBefore;
    if(item.state==='pending'){item.state='intent';await this.save(journal);}
    const original=await this.privateRead(displaced);
    let current=await this.hashAt(op.path);
    if(original!==undefined){
      // A displaced original proves that removal already happened, even if old bytes were recreated.
      if(op.after===null){if(current!==null)this.conflict(op.path);}
      else if(current!==op.after){if(current!==null)this.conflict(op.path);}
    }else if(current!==expected){
      // A lost done write after exclusive installation has the prepared inode as evidence.
      if(op.after!==null && current===op.after && await this.exists(install)){
        const [a,b]=await Promise.all([lstat(target),lstat(install)]);
        if(a.ino===b.ino&&a.dev===b.dev){item.state='done';await this.save(journal);return;}
      }
      this.conflict(op.path);
    }
    if(original===undefined && current!==null){
      await this.directory(dirname(displaced));
      await assertSafePath(target,'file',this.root);
      await rename(target,displaced); await this.flushDirectory(dirname(target)); await this.flushDirectory(dirname(displaced));
      const captured=await this.privateRead(displaced);
      if(!captured || digestBytes(captured)!==expected){
        try{await link(displaced,target);}catch(error){if(!(typeof error==='object'&&error&&'code'in error&&error.code==='EEXIST'))throw error;}
        this.conflict(op.path);
      }
      current=null;
    }
    if(op.after!==null && current!==op.after){
      const bytes=await this.privateRead(this.sessionPath(journal.sessionId,'payloads',op.after));
      if(!bytes || digestBytes(bytes)!==op.after)return fail('P2P_PAYLOAD_INVALID','Prepared payload is damaged');
      validatePersonalAsset(op.path,bytes);
      if(!await this.exists(install))await this.writePrivate(install,bytes);
      await this.directory(dirname(target));
      const existing=await lstat(target).catch(error=>{if(isMissing(error))return undefined;throw error;});
      if(existing?.isDirectory()){
        await assertSafePath(target,'directory',this.root);
        try{await rmdir(target);}catch(error){if(typeof error==='object'&&error&&'code'in error&&['ENOTEMPTY','EEXIST'].includes(String(error.code)))this.conflict(op.path);throw error;}
      }
      try{await link(install,target);}catch(error){if(typeof error==='object'&&error&&'code'in error&&error.code==='EEXIST')this.conflict(op.path);throw error;}
      await this.flushDirectory(dirname(target));
    }
    item.state='done';await this.save(journal);
  }
  async apply(sessionId:string):Promise<PeerReceipt>{
    return this.repository.withMutationLock(async()=>{
      const journal=await this.status(sessionId);
      if(journal.phase==='aborted')return fail('P2P_SESSION_ABORTED','Session was aborted; compute a new plan');
      if(journal.receipt)return journal.receipt;
      if(journal.phase==='prepared'){
        const expected=journal.role==='local'?journal.plan.localSnapshot:journal.plan.remoteSnapshot;
        if((await this.snapshot(expected.peerId)).digest!==expected.digest)return fail('P2P_RECOVERY_CONFLICT','Personal snapshot changed since preparation');
        journal.phase='applying';await this.save(journal);
      }
      const ordered=journal.operations.map((_,index)=>index).sort((a,b)=>{
        const left=journal.operations[a]!.operation,right=journal.operations[b]!.operation;
        if((left.after===null)!==(right.after===null))return left.after===null?-1:1;
        return left.after===null?right.path.length-left.path.length:left.path.localeCompare(right.path);
      });
      for(const index of ordered)await this.applyOperation(journal,index);
      journal.phase='applied';journal.receipt=this.receipt(journal,'applied');await this.save(journal);
      return journal.receipt;
    });
  }
  async finalize(sessionId:string,remoteReceipt:PeerReceipt):Promise<PeerReceipt>{
    return this.repository.withMutationLock(async()=>{
      const journal=await this.status(sessionId);
      if(!remoteReceipt || remoteReceipt.sessionId!==sessionId || remoteReceipt.planDigest!==journal.plan.digest ||
        remoteReceipt.peerId!==this.peerId || !['applied','committed'].includes(remoteReceipt.phase))return fail('P2P_RECEIPT_MISMATCH','Matching peer receipt is required');
      if(!journal.receipt)return fail('P2P_SESSION_NOT_APPLIED','Both endpoints must apply before finalization');
      if(journal.phase!=='committed'){
        const next=makeBaseline({generation:journal.plan.nextBaseline.generation,entries:journal.plan.nextBaseline.entries,lastSessionId:sessionId});
        const current=await this.readBaseline();
        if(current.digest!==journal.plan.baseBaseline.digest && current.digest!==next.digest)return fail('P2P_BASE_MISMATCH','Baseline changed during finalization');
        await this.json(this.path('peers',this.peerId,'state.json'),next);
        journal.phase='committed';journal.receipt=this.receipt(journal,'committed');await this.save(journal);
      }
      const pointer=await this.readJson(this.path('peers',this.peerId,'pending.json'));
      if(pointer&&typeof pointer==='object'&&'sessionId'in pointer&&pointer.sessionId===sessionId){await rm(this.path('peers',this.peerId,'pending.json'));await this.flushDirectory(this.path('peers',this.peerId));}
      // Retain operation evidence and payloads until a separate mutually acknowledged cleanup exists.
      return journal.receipt!;
    });
  }
  async resolveRecovery(sessionId:string,options:{preserveCurrent:true}):Promise<{archives:string[]}>{
    if(options.preserveCurrent!==true)return fail('P2P_RECOVERY_CONFIRMATION_REQUIRED','Explicit preservation decision required');
    return this.repository.withMutationLock(async()=>{
      const journal=await this.status(sessionId);const archives:string[]=[];
      if(journal.phase==='aborted')return fail('P2P_SESSION_ABORTED','Session was aborted; compute a new plan');
      if(journal.receipt)return {archives};
      const evidence=new Map<number,{current:Buffer|undefined;oldDisplaced:Buffer|undefined}>();
      let total=0;
      for(let i=0;i<journal.operations.length;i++){
        const item=journal.operations[i]!;if(item.state==='done')continue;
        const current=await this.asset(item.operation.path,true);
        total+=current?.length??0;
        if(total>64*1024*1024)return fail('P2P_LIMIT_EXCEEDED','Recovery content exceeds 64 MiB; preserve it externally before retrying');
        const oldDisplaced=await this.recoveryBytes(this.evidencePath(journal,i,item,'displaced'));
        total+=oldDisplaced?.length??0;
        if(total>64*1024*1024)return fail('P2P_LIMIT_EXCEEDED','Recovery content exceeds 64 MiB; preserve it externally before retrying');
        evidence.set(i,{current,oldDisplaced});
      }
      for(let i=0;i<journal.operations.length;i++){
        const item=journal.operations[i]!;if(item.state==='done')continue;
        const {current,oldDisplaced}=evidence.get(i)!;
        const archive=this.sessionPath(sessionId,'recovered',`${i}-${item.attempt}-${randomUUID()}`);
        if(current){await this.writePrivate(archive,current);archives.push(archive);}
        if(oldDisplaced){const oldArchive=`${archive}-displaced`;await this.writePrivate(oldArchive,oldDisplaced);archives.push(oldArchive);}
        item.attempt++;item.state='pending';item.overrideBefore=current?digestBytes(current):null;
      }
      journal.phase='applying';await this.save(journal);return {archives};
    });
  }
}
