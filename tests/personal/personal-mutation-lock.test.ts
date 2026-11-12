import { it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalRepository } from '../../src/storage/personal-repository.js';
import { resolvePaths } from '../../src/storage/paths.js';

it('prevents another personal writer from entering an active root mutation', async () => {
  const root=await mkdtemp(join(tmpdir(),'gmem-personal-lock-'));
  const personal=join(root,'personal'); await mkdir(personal);
  const repo=new PersonalRepository(resolvePaths(join(root,'project'),personal));
  let entered!:()=>void, release!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;});
  const gate=new Promise<void>(r=>{release=r;});
  const holder=repo.withMutationLock(async()=>{entered();await gate;});
  await ready;
  const writer=repo.writePersonalFile('practice/p.md',Buffer.from('new'));
  try {
    const result=await Promise.race([writer.then(()=> 'wrote'),new Promise<string>(r=>setTimeout(()=>r('blocked'),40))]);
    expect(result).toBe('blocked');
    await expect(readFile(join(personal,'practice/p.md'))).rejects.toMatchObject({code:'ENOENT'});
  } finally { release(); await holder; await writer; await rm(root,{recursive:true,force:true}); }
});
