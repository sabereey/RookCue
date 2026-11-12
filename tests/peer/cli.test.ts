import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile), roots:string[]=[];
async function run(args:string[]){
  try{return {code:0,...await exec(process.execPath,[resolve('dist/src/cli.js'),...args],{timeout:15000})};}
  catch(error){const e=error as {code:number;stdout:string;stderr:string};return e;}
}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
it('lists a fresh personal root without exposing or generating invitation secrets',async()=>{
  const root=await mkdtemp(join(tmpdir(),'gmem-peer-cli-'));roots.push(root);
  const result=await run(['peer','list','--project',join(root,'project'),'--personal',join(root,'personal'),'--json']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ok:true,data:{peers:[]}});
});
it('requires an explicit sync mode before creating or contacting peers',async()=>{
  const root=await mkdtemp(join(tmpdir(),'gmem-peer-cli-'));roots.push(root);
  const result=await run(['peer','sync','--project',root,'--personal',join(root,'personal'),'--peer','a'.repeat(52),'--address','127.0.0.1:12345','--json']);
  expect(result.code).not.toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ok:false,error:{code:'P2P_SYNC_MODE_REQUIRED'}});
});
it('rejects conflicting sync modes without contacting a server',async()=>{
  const root=await mkdtemp(join(tmpdir(),'gmem-peer-cli-'));roots.push(root);
  const result=await run(['peer','sync','--project',root,'--personal',join(root,'personal'),'--peer','a'.repeat(52),'--address','127.0.0.1:12345','--dry-run','--apply','--json']);
  expect(result.code).not.toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ok:false,error:{code:'P2P_SYNC_MODE_CONFLICT'}});
});
