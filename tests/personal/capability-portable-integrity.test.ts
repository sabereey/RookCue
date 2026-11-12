import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it} from 'vitest';
import {PersonalRepository,PersonalAssetService,resolvePaths} from '../../src/index.js';
import {validatePersonalAsset} from '../../src/personal/personal-asset-paths.js';
import {portableCapabilities} from '../fixtures/growth-assets.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
// Mutable synthetic wire fixture lets each case break one cross-field relationship.
function stateWithNoop():any {const state:any=JSON.parse(JSON.stringify(portableCapabilities));const prior=state.history[1]!;state.history.push({...structuredClone(prior),kind:'noop',operationId:'later-noop',previousLevel:'understood',at:'2026-10-30T00:00:00.000Z'});return state;}
async function bundle(state:unknown,path='capabilities.json'){
 const root=await mkdtemp(join(tmpdir(),'capability-integrity-'));roots.push(root);const dir=join(root,'bundle');await mkdir(dir);
 const bytes=Buffer.from(JSON.stringify(state));await writeFile(join(dir,path),bytes);await writeFile(join(dir,'manifest.json'),JSON.stringify({version:1,schemaVersion:1,files:[{path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]}));
 const repository=new PersonalRepository(resolvePaths(join(root,'project'),join(root,'personal')));return{dir,bytes,repository,service:new PersonalAssetService(repository,{clock:()=>new Date('2026-10-30T00:00:00Z')})};
}
const cases:Array<[string,(s:any)=>void]>=[
 ['baseline evidence differs from returned record',s=>{s.history[0].evidence=[{kind:'explanation',reviewId:'different-review',passed:false}];}],
 ['transition evidence differs despite matching input',s=>{s.history[1].evidence=[{kind:'explanation',reviewId:'different-review',passed:false}];s.history[1].input.evidence=s.history[1].evidence;}],
 ['baseline date differs from returned record',s=>{s.history[0].at='2026-10-27T00:00:00.000Z';}],
 ['real transition date differs from returned record',s=>{s.history[1].at='2026-10-28T00:00:00.000Z';}],
 ['real assessment date differs from returned record',s=>{const entry=s.history[1];entry.kind='assessment';entry.previousLevel=null;entry.at='2026-10-28T00:00:00.000Z';s.history=[entry];}],
 ['level change labeled assessment',s=>{s.history[1].kind='assessment';}],
 ['same level labeled transition',s=>{s.history[1].newLevel='seen';s.history[1].input.level='seen';s.history[1].returnedRecord.level='seen';s.records[0].level='seen';s.history.pop();}],
 ['noop mutates record timestamp',s=>{s.history[2].returnedRecord.updatedAt='2026-10-30T00:00:00.000Z';s.records[0].updatedAt='2026-10-30T00:00:00.000Z';}],
 ['noop changes known content fingerprint',s=>{s.history[2].contentFingerprint='b'.repeat(64);}],
 ['noop mutates evidence',s=>{const e=[{kind:'explanation',reviewId:'different-review',passed:false}];s.history[2].evidence=e;s.history[2].input.evidence=e;s.history[2].returnedRecord.evidence=e;s.records[0].evidence=e;}],
 ['noop has only an unknown baseline',s=>{const baseline=s.history[0];const noop={...s.history[2],previousLevel:'seen',newLevel:'seen',returnedRecord:structuredClone(baseline.returnedRecord),input:{conceptId:'c',level:'seen',evidence:baseline.evidence}};s.history=[baseline,noop];s.records=[baseline.returnedRecord];}],
];
it.each(cases)('rejects valid-checksum corrupt capability state: %s',async(_label,mutate)=>{
 const state=stateWithNoop();mutate(state);const f=await bundle(state);expect(()=>validatePersonalAsset('capabilities.json',f.bytes)).toThrow();
 await expect(f.repository.writePersonalFile('capabilities.json',f.bytes)).rejects.toMatchObject({code:'INVALID_STORED_DATA'});
 await expect(f.service.verifyPersonalBundle(f.dir)).rejects.toMatchObject({code:'INVALID_STORED_DATA'});
 await expect(f.service.importPersonalBundleDryRun(f.dir)).rejects.toMatchObject({code:'INVALID_STORED_DATA'});
});
it.each(['capabilities.json','capabilities.conflict-20261030-000000-local.json'])('accepts genuine later noop receipt without changing record timestamp: %s',async(path)=>{
 const state=stateWithNoop();const f=await bundle(state,path);expect(()=>validatePersonalAsset(path,f.bytes)).not.toThrow();expect((await f.service.verifyPersonalBundle(f.dir)).valid).toBe(true);expect((await f.service.importPersonalBundleDryRun(f.dir)).wouldAdd).toEqual([path]);
});
