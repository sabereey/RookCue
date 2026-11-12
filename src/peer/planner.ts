import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { conflictOriginalPath } from '../personal/conflict-archives.js';
import { isPersonalKnowledgeAsset } from '../personal/personal-asset-paths.js';

export interface AssetEntry { path: string; sha256: string; bytes: number }
export interface PeerSnapshot { peerId: string; entries: AssetEntry[]; digest: string }
export interface PeerBaseline { generation: number; lastSessionId: string | null; entries: Record<string, string | null>; digest: string }
export interface PeerResolution { path: string; strategy: 'local' | 'remote' | 'both' | 'skip'; localHash: string | null; remoteHash: string | null }
export interface PeerOperation { path: string; before: string | null; after: string | null; source: { side: 'local' | 'remote'; path: string; sha256: string } | null }
export interface PeerConflict { path: string; localHash: string | null; remoteHash: string | null; reason: 'edit/edit' | 'edit/delete'; resolution: PeerResolution['strategy'] | null }
export interface PeerPlan {
  protocolVersion: 1;
  localPeerId: string;
  remotePeerId: string;
  localSnapshotDigest: string;
  remoteSnapshotDigest: string;
  baseGeneration: number;
  localSnapshot: PeerSnapshot;
  remoteSnapshot: PeerSnapshot;
  baseBaseline: PeerBaseline;
  resolutions: PeerResolution[];
  localOperations: PeerOperation[];
  remoteOperations: PeerOperation[];
  conflicts: PeerConflict[];
  localTarget: PeerSnapshot;
  remoteTarget: PeerSnapshot;
  nextBaseline: PeerBaseline;
  digest: string;
}
const MAX_ASSETS = 4096;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const peerIdSchema = z.string().regex(/^[a-z2-7]{52}$/);
const assetSchema = z.strictObject({ path: z.string(), sha256: hashSchema, bytes: z.number().int().min(0).max(MAX_ASSET_BYTES) });
const snapshotSchema = z.strictObject({ peerId: peerIdSchema, entries: z.array(assetSchema).max(MAX_ASSETS), digest: hashSchema });
const baselineSchema = z.strictObject({
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  lastSessionId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).nullable(),
  entries: z.record(z.string(), hashSchema.nullable()),
  digest: hashSchema,
});
const resolutionSchema = z.strictObject({ path: z.string(), strategy: z.enum(['local', 'remote', 'both', 'skip']), localHash: hashSchema.nullable(), remoteHash: hashSchema.nullable() });
const planInputSchema = z.strictObject({ local: snapshotSchema, remote: snapshotSchema, base: baselineSchema, resolutions: z.array(resolutionSchema).max(MAX_ASSETS).optional() });

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('Digest requires finite JSON data');
}

/** SHA-256 over JSON with recursively sorted object keys; array order remains meaningful. */
export function stableDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function assertAssetPath(path: string): void {
  const segments = path.split('/');
  if (path.length === 0 || path.length > 1024 || path !== path.normalize('NFC') ||
      /[\\\u0000-\u001f\u007f:]/.test(path) ||
      segments.some(segment => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) ||
      !isPersonalKnowledgeAsset(path)) throw new Error(`Unsafe or unsupported personal asset path: ${path}`);
}

/** Also rejects file/directory aliases that cannot coexist on a portable filesystem. */
function assertPathSet(paths: Iterable<string>): void {
  const folded = new Map<string, string>();
  for (const path of paths) {
    assertAssetPath(path);
    const key = path.toLowerCase();
    const prior = folded.get(key);
    if (prior !== undefined && prior !== path) throw new Error(`Case collision: ${prior} / ${path}`);
    folded.set(key, path);
  }
  for (const [key, path] of folded) {
    const segments = key.split('/');
    for (let i = 1; i < segments.length; i++) {
      if (folded.has(segments.slice(0, i).join('/'))) throw new Error(`File/directory path collision: ${path}`);
    }
  }
}

function sortEntries(entries: Record<string, string | null>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => compare(a, b)));
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export function makeSnapshot(peerId: string, entries: AssetEntry[]): PeerSnapshot {
  peerIdSchema.parse(peerId);
  const parsed = z.array(assetSchema).max(MAX_ASSETS).parse(entries);
  const seen = new Set<string>();
  const sizes = new Map<string, number>();
  let total = 0;
  for (const entry of parsed) {
    if (seen.has(entry.path)) throw new Error(`Duplicate snapshot path: ${entry.path}`);
    seen.add(entry.path);
    if (sizes.has(entry.sha256) && sizes.get(entry.sha256) !== entry.bytes) throw new Error('Identical hashes have inconsistent byte sizes');
    sizes.set(entry.sha256, entry.bytes);
    total += entry.bytes;
  }
  if (total > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot exceeds aggregate byte limit');
  assertPathSet(seen);
  parsed.sort((a, b) => compare(a.path, b.path));
  const payload = { peerId, entries: parsed };
  return { ...payload, digest: stableDigest(payload) };
}

function validateSnapshot(value: unknown): PeerSnapshot {
  const parsed = snapshotSchema.parse(value);
  const snapshot = makeSnapshot(parsed.peerId, parsed.entries);
  if (snapshot.digest !== parsed.digest) throw new Error('Snapshot digest mismatch');
  return snapshot;
}

/** Recompute after finalization assigns lastSessionId; no identity or I/O is needed. */
export function makeBaseline(input: Omit<PeerBaseline, 'digest'>): PeerBaseline {
  const { generation, lastSessionId, entries } = input;
  const parsed = baselineSchema.omit({ digest: true }).parse({ generation, lastSessionId, entries });
  if (Object.keys(parsed.entries).length > MAX_ASSETS) throw new Error('Baseline exceeds asset count limit');
  for (const path of Object.keys(parsed.entries)) assertAssetPath(path);
  assertPathSet(Object.entries(parsed.entries).filter(([,hash]) => hash !== null).map(([path]) => path));
  if (parsed.generation === 0 && (parsed.lastSessionId !== null || Object.keys(parsed.entries).length !== 0)) throw new Error('Fresh baseline must be empty');
  const payload = { generation: parsed.generation, lastSessionId: parsed.lastSessionId, entries: sortEntries(parsed.entries) };
  return { ...payload, digest: stableDigest(payload) };
}

export function validateBaseline(value: unknown): PeerBaseline {
  const parsed = baselineSchema.parse(value);
  const baseline = makeBaseline(parsed);
  if (baseline.digest !== parsed.digest) throw new Error('Baseline digest mismatch');
  return baseline;
}

export function emptyBaseline(): PeerBaseline {
  return makeBaseline({ generation: 0, lastSessionId: null, entries: {} });
}

/** Stable recognized archive suffix; the timestamp is a naming token, never a winner. */
function archivePath(path: string, seed: unknown, occupied: Set<string>): string {
  const extension = posix.extname(path);
  for (let attempt = 0; attempt <= MAX_ASSETS; attempt++) {
    const token = stableDigest({ seed, attempt });
    const date = new Date(Date.UTC(2000, 0, 1) + (Number.parseInt(token.slice(0, 10), 16) % (36525 * 86400)) * 1000);
    const stamp = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const stem = extension ? path.slice(0, -extension.length) : path;
    const candidate = `${stem}.conflict-${stamp}-local${extension}`;
    if (!occupied.has(candidate.toLowerCase())) {
      if (conflictOriginalPath(candidate) !== path) throw new Error('Invalid conflict archive binding');
      assertAssetPath(candidate);
      occupied.add(candidate.toLowerCase());
      return candidate;
    }
  }
  throw new Error('Conflict archive namespace exhausted');
}

/** Pure three-way reconciliation, with local/remote always relative to the initiator. */
export function buildPeerPlan(input: { local: PeerSnapshot; remote: PeerSnapshot; base: PeerBaseline; resolutions?: PeerResolution[] }): PeerPlan {
  const parsed = planInputSchema.parse(input);
  const local = validateSnapshot(parsed.local), remote = validateSnapshot(parsed.remote), base = validateBaseline(parsed.base);
  if (local.peerId === remote.peerId) throw new Error('Cannot sync a peer identity with itself');
  const paths = [...new Set([...local.entries.map(e => e.path), ...remote.entries.map(e => e.path), ...Object.keys(base.entries)])].sort(compare);
  for (const path of paths) assertAssetPath(path);
  const sizes = new Map<string, number>();
  for (const entry of [...local.entries, ...remote.entries]) {
    const size = sizes.get(entry.sha256);
    if (size !== undefined && size !== entry.bytes) throw new Error('Identical hashes have inconsistent byte sizes');
    sizes.set(entry.sha256, entry.bytes);
  }
  const resolutions = [...(parsed.resolutions ?? [])].sort((a, b) => compare(a.path, b.path));
  const choices = new Map<string, PeerResolution>();
  for (const choice of resolutions) {
    assertAssetPath(choice.path);
    if (choices.has(choice.path)) throw new Error(`Duplicate resolution: ${choice.path}`);
    choices.set(choice.path, choice);
  }
  const localEntries = new Map(local.entries.map(e => [e.path, e]));
  const remoteEntries = new Map(remote.entries.map(e => [e.path, e]));
  const localTarget = new Map(localEntries), remoteTarget = new Map(remoteEntries);
  const nextEntries = { ...base.entries };
  const localOperations: PeerOperation[] = [], remoteOperations: PeerOperation[] = [];
  const conflicts: PeerConflict[] = [];
  const occupied = new Set(paths.map(path => path.toLowerCase()));

  function write(side: 'local' | 'remote', path: string, chosen: AssetEntry | undefined, sourceSide: 'local' | 'remote'): void {
    const originals = side === 'local' ? localEntries : remoteEntries;
    const targets = side === 'local' ? localTarget : remoteTarget;
    const operations = side === 'local' ? localOperations : remoteOperations;
    const before = originals.get(path)?.sha256 ?? null;
    const after = chosen?.sha256 ?? null;
    if (before === after) return;
    operations.push({ path, before, after, source: chosen ? { side: sourceSide, path: chosen.path, sha256: chosen.sha256 } : null });
    if (chosen) targets.set(path, { path, sha256: chosen.sha256, bytes: chosen.bytes });
    else targets.delete(path);
  }
  function agree(path: string, chosen: AssetEntry | undefined, sourceSide: 'local' | 'remote'): void {
    write('local', path, chosen, sourceSide);
    write('remote', path, chosen, sourceSide);
    nextEntries[path] = chosen?.sha256 ?? null;
  }

  for (const path of paths) {
    const left = localEntries.get(path), right = remoteEntries.get(path);
    const leftHash = left?.sha256 ?? null, rightHash = right?.sha256 ?? null;
    const prior = base.entries[path] ?? null;
    const conflict = leftHash !== rightHash && leftHash !== prior && rightHash !== prior;
    const choice = choices.get(path);
    if (choice && !conflict) throw new Error(`Resolution path is no longer a conflict: ${path}`);
    if (!conflict) {
      if (leftHash === rightHash) agree(path, left, 'local');
      else if (leftHash === prior) agree(path, right, 'remote');
      else agree(path, left, 'local');
      continue;
    }
    if (choice && (choice.localHash !== leftHash || choice.remoteHash !== rightHash)) throw new Error(`Stale resolution: ${path}`);
    conflicts.push({ path, localHash: leftHash, remoteHash: rightHash, reason: left && right ? 'edit/edit' : 'edit/delete', resolution: choice?.strategy ?? null });
    if (!choice || choice.strategy === 'skip') continue;
    if (choice.strategy === 'local') agree(path, left, 'local');
    else if (choice.strategy === 'remote') agree(path, right, 'remote');
    else if (!left || !right) agree(path, left ?? right, left ? 'local' : 'remote');
    else {
      const archive = archivePath(path, { localPeerId: local.peerId, remotePeerId: remote.peerId, localDigest: local.digest, remoteDigest: remote.digest, baseDigest: base.digest, path }, occupied);
      write('local', archive, left, 'local');
      write('remote', archive, left, 'local');
      nextEntries[archive] = leftHash;
      agree(path, right, 'remote');
    }
  }
  for (const path of choices.keys()) if (!paths.includes(path)) throw new Error(`Resolution path is not a conflict: ${path}`);
  localOperations.sort((a, b) => compare(a.path, b.path));
  remoteOperations.sort((a, b) => compare(a.path, b.path));
  const payload: Omit<PeerPlan, 'digest'> = {
    protocolVersion: 1,
    localPeerId: local.peerId, remotePeerId: remote.peerId,
    localSnapshotDigest: local.digest, remoteSnapshotDigest: remote.digest,
    baseGeneration: base.generation,
    localSnapshot: local, remoteSnapshot: remote, baseBaseline: base, resolutions,
    localOperations, remoteOperations, conflicts,
    localTarget: makeSnapshot(local.peerId, [...localTarget.values()]),
    remoteTarget: makeSnapshot(remote.peerId, [...remoteTarget.values()]),
    nextBaseline: makeBaseline({ generation: base.generation + 1, lastSessionId: null, entries: nextEntries }),
  };
  return { ...payload, digest: stableDigest(payload) };
}

/** Reconstruct every derived field; a self-consistent outer digest alone is insufficient. */
export function validatePeerPlan(value: unknown): PeerPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid peer plan');
  const candidate = value as Record<string, unknown>;
  const rebuilt = buildPeerPlan({ local: candidate.localSnapshot as PeerSnapshot, remote: candidate.remoteSnapshot as PeerSnapshot, base: candidate.baseBaseline as PeerBaseline, resolutions: candidate.resolutions as PeerResolution[] });
  if (canonicalJson(value) !== canonicalJson(rebuilt)) throw new Error('Peer plan does not match deterministic reconciliation');
  return rebuilt;
}
