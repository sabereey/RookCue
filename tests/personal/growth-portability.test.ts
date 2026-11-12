import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { PersonalRepository, PersonalAssetService, resolvePaths } from '../../src/index.js';
import { isPersonalKnowledgeAsset } from '../../src/personal/personal-asset-paths.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'growth-assets-')); roots.push(root); const personal = join(root, 'personal'); const repository = new PersonalRepository(resolvePaths(join(root, 'project'), personal)); return { root, personal, repository, service: new PersonalAssetService(repository, { clock: () => new Date('2026-10-29T00:00:00Z') }) }; }
import { portableObservation, portableReview, portableCapabilities } from '../fixtures/growth-assets.js';
it('admits exactly typed growth safe IDs, excluding private/cache/report paths', () => { for (const p of ['growth/observations/op.json', 'growth/reviews/capture.json'])
    expect(isPersonalKnowledgeAsset(p)).toBe(true); for (const p of ['growth/reports/x.json', 'growth/observations/../x.json', 'growth/reviews/x/y.json', 'growth/reviews/x.txt', '.cloud/state.json', 'project-identity.json'])
    expect(isPersonalKnowledgeAsset(p), p).toBe(false); });
it('exports verifies and previews observations, completed-task witnesses and v2 state', async () => { const f = await fixture(); for (const [p, v] of [['growth/observations/op.json', portableObservation], ['growth/reviews/capture.json', portableReview], ['capabilities.json', portableCapabilities]] as const)
    await f.repository.writePersonalFile(p, Buffer.from(JSON.stringify(v))); await f.repository.writePersonalFile('growth/reports/private.json', Buffer.from('private')); const out = await f.service.exportPersonal(join(f.root, 'out')); expect(out.files).toBe(3); expect((await f.service.verifyPersonalBundle(out.exportRoot)).valid).toBe(true); expect((await f.service.importPersonalBundleDryRun(out.exportRoot)).wouldSkip).toHaveLength(3); expect(JSON.parse(await readFile(join(out.exportRoot, 'growth/reviews/capture.json'), 'utf8')).taskCompletedAt).toBe(portableReview.taskCompletedAt); });
it.each([{ ...portableObservation, version: 2 }, { ...portableObservation, transcript: 'private' }, { ...portableObservation, id: 'different' }])('rejects corrupt growth raw writes %j', async (value) => { const f = await fixture(); await expect(f.repository.writePersonalFile('growth/observations/op.json', Buffer.from(JSON.stringify(value)))).rejects.toMatchObject({ code: 'INVALID_STORED_DATA' }); });
it('rejects symlinked growth parent on both raw reads and writes', async () => { const f = await fixture(); const outside = join(f.root, 'outside'); await mkdir(join(outside, 'observations'), { recursive: true }); await writeFile(join(outside, 'observations/op.json'), JSON.stringify(portableObservation)); await mkdir(f.personal, { recursive: true }); await symlink(outside, join(f.personal, 'growth')); await expect(f.repository.readPersonalFile('growth/observations/op.json')).rejects.toMatchObject({ code: 'UNSAFE_PATH' }); await expect(f.repository.writePersonalFile('growth/observations/op.json', Buffer.from(JSON.stringify(portableObservation)))).rejects.toMatchObject({ code: 'UNSAFE_PATH' }); });
it.each(['version', 'capability', 'symlink', 'traversal'])('rejects %s bundles even with self-consistent checksums', async (mode) => {
    const f = await fixture();
    await f.repository.writePersonalFile('growth/observations/op.json', Buffer.from(JSON.stringify(portableObservation)));
    const out = await f.service.exportPersonal(join(f.root, 'out'));
    const manifestPath = join(out.exportRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (mode === 'symlink') {
        const p = join(out.exportRoot, 'growth/observations/op.json');
        await rm(p);
        const outside = join(f.root, 'outside.json');
        await writeFile(outside, JSON.stringify(portableObservation));
        await symlink(outside, p);
    }
    else if (mode === 'traversal')
        manifest.files[0].path = '../escape.json';
    else {
        const path = mode === 'version' ? 'growth/observations/op.json' : 'capabilities.json';
        const bytes = Buffer.from(JSON.stringify(mode === 'version' ? { ...portableObservation, version: 9 } : { version: 2, records: [{ conceptId: 'c', level: 'seen', evidence: [{ kind: 'explanation', reviewId: 'r', passed: true }], updatedAt: '2026-10-29T00:00:00.000Z' }], history: [] }));
        await writeFile(join(out.exportRoot, path), bytes);
        manifest.files = [{ path, bytes: bytes.length, sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') }];
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(f.service.verifyPersonalBundle(out.exportRoot)).rejects.toThrow();
    await expect(f.service.importPersonalBundleDryRun(out.exportRoot)).rejects.toThrow();
});
it('refuses export with a symbolic growth parent instead of silently omitting history', async () => { const f = await fixture(); const outside = join(f.root, 'outside'); await mkdir(outside); await mkdir(f.personal); await symlink(outside, join(f.personal, 'growth')); await expect(f.service.exportPersonal(join(f.root, 'out'))).rejects.toMatchObject({ code: 'UNSAFE_PATH' }); });
it('rejects a linked personal root before mutation lock or operation', async () => { const f = await fixture(); const outside = join(f.root, 'outside'); await mkdir(outside); await symlink(outside, f.personal); let invoked = false; await expect(f.repository.withMutationLock(async () => { invoked = true; })).rejects.toMatchObject({ code: 'UNSAFE_PATH' }); expect(invoked).toBe(false); });
it('verify rejects a checksum-valid nonportable asset manifest', async () => { const f = await fixture(); const bundle = join(f.root, 'bundle'); await mkdir(bundle); await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ version: 1, schemaVersion: 1, files: [{ path: 'growth/reports/x.json', sha256: 'a'.repeat(64), bytes: 0 }] })); await expect(f.service.verifyPersonalBundle(bundle)).rejects.toMatchObject({ code: 'INVALID_EXPORT_MANIFEST' }); });
