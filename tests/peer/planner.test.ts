import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildPeerPlan, emptyBaseline, makeSnapshot, stableDigest, validatePeerPlan, type AssetEntry, type PeerBaseline, type PeerResolution } from '../../src/peer/planner.js';
import { conflictOriginalPath, bindsPersonalRecord } from '../../src/personal/conflict-archives.js';
import { validatePersonalAsset } from '../../src/personal/personal-asset-paths.js';
import { portableObservation } from '../fixtures/growth-assets.js';

const LOCAL = 'a'.repeat(52), REMOTE = 'b'.repeat(52);
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const asset = (path: string, sha256: string = A, bytes = 1): AssetEntry => ({ path, sha256, bytes });
function baseline(entries: Record<string, string | null>): PeerBaseline {
  const value = { generation: 2, lastSessionId: 'committed-session', entries };
  return { ...value, digest: stableDigest(value) };
}
function plan(local: AssetEntry[], remote: AssetEntry[], base = emptyBaseline(), resolutions: PeerResolution[] = []) {
  return buildPeerPlan({ local: makeSnapshot(LOCAL, local), remote: makeSnapshot(REMOTE, remote), base, resolutions });
}
const resolution = (strategy: PeerResolution['strategy'], localHash: string | null = B, remoteHash: string | null = C): PeerResolution => ({ path: 'index.md', strategy, localHash, remoteHash });

describe('peer reconciliation literal cases', () => {
  it('copies the initial union in both directions without interpreting fresh absence as deletion', () => {
    const result = plan([asset('index.md')], [asset('practice/a.md', B)]);
    expect(result.localOperations).toEqual([{ path: 'practice/a.md', before: null, after: B, source: { side: 'remote', path: 'practice/a.md', sha256: B } }]);
    expect(result.remoteOperations).toEqual([{ path: 'index.md', before: null, after: A, source: { side: 'local', path: 'index.md', sha256: A } }]);
    expect(result.nextBaseline.entries).toEqual({ 'index.md': A, 'practice/a.md': B });
    expect(result.nextBaseline.generation).toBe(1);
    expect(result.nextBaseline.lastSessionId).toBeNull();
  });

  it('agrees equal files without transfers', () => {
    const result = plan([asset('index.md')], [asset('index.md')]);
    expect(result.localOperations).toEqual([]);
    expect(result.remoteOperations).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.nextBaseline.entries).toEqual({ 'index.md': A });
  });

  it.each([
    { local: B, remote: A, localOperations: [], remoteOperations: [{ path: 'index.md', before: A, after: B, source: { side: 'local', path: 'index.md', sha256: B } }], agreed: B },
    { local: A, remote: C, localOperations: [{ path: 'index.md', before: A, after: C, source: { side: 'remote', path: 'index.md', sha256: C } }], remoteOperations: [], agreed: C },
  ])('propagates only the changed side: $local / $remote', ({ local, remote, localOperations, remoteOperations, agreed }) => {
    const result = plan([asset('index.md', local)], [asset('index.md', remote)], baseline({ 'index.md': A }));
    expect(result.localOperations).toEqual(localOperations);
    expect(result.remoteOperations).toEqual(remoteOperations);
    expect(result.nextBaseline.entries).toEqual({ 'index.md': agreed });
  });

  it.each(['local', 'remote'] as const)('propagates the intentional %s deletion', side => {
    const result = plan(side === 'local' ? [] : [asset('index.md')], side === 'remote' ? [] : [asset('index.md')], baseline({ 'index.md': A }));
    expect(side === 'local' ? result.remoteOperations : result.localOperations).toEqual([{ path: 'index.md', before: A, after: null, source: null }]);
    expect(side === 'local' ? result.localOperations : result.remoteOperations).toEqual([]);
    expect(result.nextBaseline.entries).toEqual({ 'index.md': null });
  });

  it('copies a recreation after an agreed deletion and retains deletion tombstones', () => {
    const result = plan([asset('index.md', B)], [], baseline({ 'index.md': null, 'practice/gone.md': null }));
    expect(result.remoteOperations).toEqual([{ path: 'index.md', before: null, after: B, source: { side: 'local', path: 'index.md', sha256: B } }]);
    expect(result.nextBaseline.entries).toEqual({ 'index.md': B, 'practice/gone.md': null });
  });

  it('allows a deleted file path to become a directory without dropping its tombstone',()=>{
    const result=plan([asset('practice/guide/intro.md',C)],[asset('practice/guide/intro.md',C)],baseline({'practice/guide':null}));
    expect(result.nextBaseline.entries).toEqual({'practice/guide':null,'practice/guide/intro.md':C});
    expect(result.localOperations).toEqual([]);
  });

  it('allows case-only reuse after the previous spelling was agreed deleted',()=>{
    const result=plan([asset('practice/guide.md',C)],[],baseline({'practice/Guide.md':null}));
    expect(result.remoteOperations).toEqual([{path:'practice/guide.md',before:null,after:C,source:{side:'local',path:'practice/guide.md',sha256:C}}]);
    expect(result.nextBaseline.entries).toEqual({'practice/Guide.md':null,'practice/guide.md':C});
  });

  it('rejects inconsistent byte counts for a shared hash within one snapshot', () => {
    expect(() => makeSnapshot(LOCAL, [asset('index.md', A, 1), asset('practice/a.md', A, 2)])).toThrow(/bytes|size/i);
  });

  it.each([
    { local: B, remote: C, reason: 'edit/edit' },
    { local: null, remote: C, reason: 'edit/delete' },
    { local: B, remote: null, reason: 'edit/delete' },
  ])('reports $reason without choosing a winner', ({ local, remote, reason }) => {
    const result = plan(local ? [asset('index.md', local)] : [], remote ? [asset('index.md', remote)] : [], baseline({ 'index.md': A }));
    expect(result.conflicts).toEqual([{ path: 'index.md', localHash: local, remoteHash: remote, reason, resolution: null }]);
    expect(result.localOperations).toEqual([]);
    expect(result.remoteOperations).toEqual([]);
    expect(result.nextBaseline.entries).toEqual({ 'index.md': A });
  });

  it('conflicts on different initial bytes without inventing prior agreement', () => {
    const result = plan([asset('index.md', B)], [asset('index.md', C)]);
    expect(result.conflicts[0]).toEqual({ path: 'index.md', localHash: B, remoteHash: C, reason: 'edit/edit', resolution: null });
    expect(result.nextBaseline.entries).toEqual({});
  });

  it.each([
    { strategy: 'local', localOperations: [], remoteOperations: [{ path: 'index.md', before: C, after: B, source: { side: 'local', path: 'index.md', sha256: B } }], agreed: B },
    { strategy: 'remote', localOperations: [{ path: 'index.md', before: B, after: C, source: { side: 'remote', path: 'index.md', sha256: C } }], remoteOperations: [], agreed: C },
  ] as const)('applies an explicit $strategy choice tied to both hashes', ({ strategy, localOperations, remoteOperations, agreed }) => {
    const result = plan([asset('index.md', B)], [asset('index.md', C)], baseline({ 'index.md': A }), [resolution(strategy)]);
    expect(result.localOperations).toEqual(localOperations);
    expect(result.remoteOperations).toEqual(remoteOperations);
    expect(result.nextBaseline.entries).toEqual({ 'index.md': agreed });
    expect(result.conflicts[0]?.resolution).toBe(strategy);
  });

  it('skip preserves different target snapshots and the old per-path base while other files sync', () => {
    const result = plan([asset('index.md', B), asset('practice/new.md')], [asset('index.md', C)], baseline({ 'index.md': A }), [resolution('skip')]);
    expect(result.localOperations).toEqual([]);
    expect(result.remoteOperations).toEqual([{ path: 'practice/new.md', before: null, after: A, source: { side: 'local', path: 'practice/new.md', sha256: A } }]);
    expect(result.localTarget.entries).toEqual([asset('index.md', B), asset('practice/new.md')]);
    expect(result.remoteTarget.entries).toEqual([asset('index.md', C), asset('practice/new.md')]);
    expect(result.nextBaseline.entries).toEqual({ 'index.md': A, 'practice/new.md': A });
  });

  it.each([
    { local: null, remote: C, agreed: C, changed: 'local' },
    { local: B, remote: null, agreed: B, changed: 'remote' },
  ] as const)('both retains surviving bytes for edit/delete ($changed) without fabricating an empty archive', ({ local, remote, agreed, changed }) => {
    const result = plan(local ? [asset('index.md', local)] : [], remote ? [asset('index.md', remote)] : [], baseline({ 'index.md': A }), [resolution('both', local, remote)]);
    expect(changed === 'local' ? result.localOperations : result.remoteOperations).toEqual([{ path: 'index.md', before: null, after: agreed, source: { side: changed === 'local' ? 'remote' : 'local', path: 'index.md', sha256: agreed } }]);
    expect(result.nextBaseline.entries).toEqual({ 'index.md': agreed });
    expect(result.localTarget.entries).toEqual([asset('index.md', agreed)]);
    expect(result.conflicts[0]?.resolution).toBe('both');
  });

  it('both copies exact typed initiator bytes into a compatible archive on both endpoints', () => {
    const content = Buffer.from(JSON.stringify(portableObservation));
    const hash = createHash('sha256').update(content).digest('hex');
    const path = 'growth/observations/op.json';
    const result = plan([asset(path, hash, content.length)], [asset(path, C)], baseline({ [path]: A }), [{ path, strategy: 'both', localHash: hash, remoteHash: C }]);
    const archive = result.localOperations.find(op => op.path !== path)!;
    expect(conflictOriginalPath(archive.path)).toBe(path);
    expect(bindsPersonalRecord(archive.path, portableObservation.id)).toBe(true);
    expect(() => validatePersonalAsset(archive.path, content)).not.toThrow();
    expect(archive).toEqual({ path: archive.path, before: null, after: hash, source: { side: 'local', path, sha256: hash } });
    expect(result.remoteOperations).toEqual([archive]);
    expect(result.localOperations.find(op => op.path === path)).toEqual({ path, before: hash, after: C, source: { side: 'remote', path, sha256: C } });
    expect(result.nextBaseline.entries).toEqual({ [path]: C, [archive.path]: hash });
    expect(result.localTarget).toMatchObject({ entries: [{ path: archive.path, sha256: hash, bytes: content.length }, asset(path, C)] });
  });

  it('both keeps extensionless whitelist assets portable', () => {
    const path = 'practice/README';
    const result = plan([asset(path, B)], [asset(path, C)], emptyBaseline(), [{ path, strategy: 'both', localHash: B, remoteHash: C }]);
    const archive = result.remoteOperations[0]!;
    expect(conflictOriginalPath(archive.path)).toBe(path);
    expect(archive).toEqual({ path: archive.path, before: null, after: B, source: { side: 'local', path, sha256: B } });
    expect(result.localTarget.entries.find(entry => entry.path === path)?.sha256).toBe(C);
    expect(result.nextBaseline.entries).toEqual({ [path]: C, [archive.path]: B });
  });

  it('rejects stale, duplicate, and non-conflict resolutions', () => {
    expect(() => plan([asset('index.md', B)], [asset('index.md', C)], baseline({ 'index.md': A }), [resolution('local', A, C)])).toThrow(/stale/i);
    expect(() => plan([asset('index.md', B)], [asset('index.md', C)], baseline({ 'index.md': A }), [resolution('local'), resolution('skip')])).toThrow(/duplicate/i);
    expect(() => plan([asset('index.md', B)], [asset('index.md', B)], baseline({ 'index.md': A }), [resolution('local', B, B)])).toThrow(/conflict/i);
  });
});

describe('planner boundary validation and deterministic digests', () => {
  it.each(['../index.md', '/index.md', 'concepts/../index.md', 'concepts\\a.json', 'concepts//a.json', '.p2p/state.json', 'tasks/a.json', 'concepts/a\u0000.json'])('rejects unsafe or nonportable asset %j', path => {
    expect(() => makeSnapshot(LOCAL, [asset(path)])).toThrow();
  });

  it('rejects duplicate paths and cross-endpoint case collisions', () => {
    expect(() => makeSnapshot(LOCAL, [asset('index.md'), asset('index.md')])).toThrow(/duplicate/i);
    expect(() => plan([asset('concepts/a.json')], [asset('concepts/A.json')])).toThrow(/collision/i);
    expect(() => plan([], [], baseline({ 'concepts/A.json': A, 'concepts/a.json': A }))).toThrow(/collision/i);
  });

  it('rejects malformed metadata, self sync, inconsistent hashes and baseline tampering', () => {
    expect(() => makeSnapshot('not-a-peer', [])).toThrow();
    expect(() => makeSnapshot(LOCAL, [asset('index.md', 'bad')])).toThrow();
    expect(() => makeSnapshot(LOCAL, [asset('index.md', A, -1)])).toThrow();
    expect(() => makeSnapshot(LOCAL, [asset('index.md', A, 8 * 1024 * 1024 + 1)])).toThrow();
    expect(() => buildPeerPlan({ local: makeSnapshot(LOCAL, []), remote: makeSnapshot(LOCAL, []), base: emptyBaseline() })).toThrow(/self|identit/i);
    expect(() => plan([asset('index.md', A, 1)], [asset('index.md', A, 2)])).toThrow(/bytes|size/i);
    expect(() => plan([], [], { ...emptyBaseline(), generation: 2 })).toThrow(/digest/i);
    expect(() => buildPeerPlan({ local: { ...makeSnapshot(LOCAL, []), digest: A }, remote: makeSnapshot(REMOTE, []), base: emptyBaseline() })).toThrow(/digest/i);
  });

  it('gives stable digests and operations regardless of insertion or resolution order', () => {
    const first = plan([asset('practice/z.md', B), asset('index.md', B)], [asset('index.md', C), asset('practice/a.md')], baseline({ 'practice/z.md': A, 'index.md': A }), [resolution('skip')]);
    const second = plan([asset('index.md', B), asset('practice/z.md', B)], [asset('practice/a.md'), asset('index.md', C)], baseline({ 'index.md': A, 'practice/z.md': A }), [resolution('skip')]);
    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(stableDigest({ b: 2, a: 1 })).toBe('43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  });

  it('validates untrusted plans semantically even when an attacker recomputes the outer digest', () => {
    const original = plan([asset('index.md')], []);
    expect(validatePeerPlan(JSON.parse(JSON.stringify(original)))).toEqual(original);
    const tampered = { ...original, remoteOperations: [] };
    const { digest: _digest, ...payload } = tampered;
    tampered.digest = stableDigest(payload);
    expect(() => validatePeerPlan(tampered)).toThrow(/plan/i);
    expect(() => validatePeerPlan({ ...original, unexpected: true })).toThrow();
  });
});
