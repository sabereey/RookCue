import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Independent black-box acceptance: builtins + CLI only; never imports application code. */
export async function runPeerAcceptance({ executable, prefix = [] }) {
  executable = resolve(executable);
  const root = await mkdtemp(join(tmpdir(), 'gmem-peer-acceptance-'));
  const checks = [], children = new Set();
  const a = { project: join(root, 'project-a'), personal: join(root, 'personal-a') };
  const b = { project: join(root, 'project-b'), personal: join(root, 'personal-b') };
  const flags = endpoint => ['--project', endpoint.project, '--personal', endpoint.personal, '--json'];
  function start(args) {
    const child = spawn(executable, [...prefix, ...args], { env: { PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const done = new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { children.delete(child); accept({ code, signal, stdout, stderr }); });
    });
    // Attach immediately so an early spawn error is always observed.
    done.catch(() => {});
    return { child, done };
  }
  async function finish(process, expected = 0) {
    let timer;
    try {
      const result = await Promise.race([process.done, new Promise((_, reject) => {
        timer = setTimeout(() => { process.child.kill('SIGKILL'); reject(new Error('CLI acceptance timeout')); }, 45000);
      })]);
      if (expected !== null) assert.equal(result.code, expected, `CLI failed: ${result.stderr}\n${result.stdout}`);
      return result;
    } finally { clearTimeout(timer); }
  }
  const run = async args => {
    const result = await finish(start(args));
    const events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(events.length && events.every(e => e.ok), 'Expected successful CLI envelopes');
    return events.at(-1).data;
  };
  async function listen(endpoint, kind, more = []) {
    const readyPath = join(root, `${kind}-${Math.random().toString(16).slice(2)}.ready.json`);
    const process = start(['peer', kind, ...flags(endpoint), '--bind', '127.0.0.1', '--port', '0', '--timeout', '120000', '--ready-file', readyPath, ...more]);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const bytes = await readFile(readyPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (bytes) {
        assert.equal((await stat(readyPath)).mode & 0o777, 0o600);
        const event = JSON.parse(bytes); assert.equal(event.ok, true); assert.equal(event.data.event, 'ready');
        return { ...process, address: event.data.address };
      }
      if (process.child.exitCode !== null) {
        const result = await process.done;
        throw new Error(`Listener failed before ready: ${result.stderr}\n${result.stdout}`);
      }
      await new Promise(accept => setTimeout(accept, 10));
    }
    throw new Error('Listener never became ready');
  }
  async function stop(process) {
    process.child.kill('SIGTERM');
    const result = await finish(process);
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(e => e.ok && e.data.event === 'stopped'));
  }
  async function put(endpoint, path, text) {
    await mkdir(dirname(join(endpoint.personal, path)), { recursive: true });
    await writeFile(join(endpoint.personal, path), text);
  }
  async function equal(path, text) {
    assert.equal(await readFile(join(a.personal, path), 'utf8'), text);
    assert.equal(await readFile(join(b.personal, path), 'utf8'), text);
  }
  try {
    const version = (await finish(start(['--version']))).stdout.trim();
    assert.match((await finish(start(['peer', '--help']))).stdout, /\bsync\b/);
    for (const endpoint of [a, b]) await run(['init', ...flags(endpoint)]);
    const invitationPath = join(root, 'private-invitation.json');
    const invitation = await listen(b, 'invite', ['--out', invitationPath]);
    assert.equal((await stat(invitationPath)).mode & 0o777, 0o600);
    const paired = await run(['peer', 'pair', ...flags(a), '--invite-file', invitationPath]);
    assert.notEqual(paired.peerId, paired.localPeerId);
    await stop(invitation); checks.push('private-pairing');
    const server = await listen(b, 'serve', ['--allow-apply']);
    const target = ['--peer', paired.peerId, '--address', server.address];
    const sync = mode => run(['peer', 'sync', ...flags(a), ...target, mode]);
    await put(a, 'practice/left.md', 'initial left');
    await put(b, 'practice/right.md', 'initial right');
    await sync('--dry-run');
    await assert.rejects(readFile(join(a.personal, 'practice/right.md')));
    await sync('--apply');
    await equal('practice/left.md', 'initial left'); await equal('practice/right.md', 'initial right');
    checks.push('initial-bidirectional');
    const noop = await sync('--dry-run');
    assert.deepEqual(noop.localOperations, []); assert.deepEqual(noop.remoteOperations, []); checks.push('no-op');
    await put(a, 'practice/left.md', 'increment left'); await put(b, 'practice/right.md', 'increment right');
    await sync('--apply'); await equal('practice/left.md', 'increment left'); await equal('practice/right.md', 'increment right');
    checks.push('incremental-bidirectional');
    await put(a, 'practice/left.md', 'local conflict'); await put(b, 'practice/left.md', 'remote conflict');
    const conflicts = await run(['peer', 'conflict', 'list', ...flags(a), ...target]);
    assert.ok(conflicts.some(conflict => conflict.path === 'practice/left.md'));
    const blocked = await finish(start(['peer', 'sync', ...flags(a), ...target, '--apply']), null);
    assert.notEqual(blocked.code, 0); assert.equal(JSON.parse(blocked.stdout).error.code, 'P2P_SYNC_CONFLICT');
    await run(['peer', 'conflict', 'resolve', ...flags(a), ...target, '--path', 'practice/left.md', '--strategy', 'remote']);
    await sync('--apply'); await equal('practice/left.md', 'remote conflict'); checks.push('conflict-resolution');
    await rm(join(a.personal, 'practice/left.md')); await sync('--apply');
    for (const endpoint of [a, b]) await assert.rejects(readFile(join(endpoint.personal, 'practice/left.md')), { code: 'ENOENT' });
    checks.push('intentional-deletion');

    // Watch the durable pending pointer, then kill the real initiator process.
    // Several operations keep this boundary observable without application fault hooks.
    for (let index = 0; index < 24; index++) await put(b, `practice/retry-${index}.md`, `${index}\n${'retry data\n'.repeat(1024)}`);
    const peerDir = join(a.personal, '.p2p', 'peers', paired.peerId);
    let syncing, observed = false;
    const watcher = watch(peerDir, (event, name) => {
      if (name?.toString() === 'pending.json' && syncing && !observed) { observed = true; syncing.child.kill('SIGKILL'); }
    });
    try {
      syncing = start(['peer', 'sync', ...flags(a), ...target, '--apply']);
      const interrupted = await finish(syncing, null);
      assert.equal(observed, true, 'Did not observe durable session before process exit');
      assert.equal(interrupted.signal, 'SIGKILL');
    } finally { watcher.close(); }
    const pending = JSON.parse(await readFile(join(peerDir, 'pending.json'), 'utf8'));
    const resumed = await run(['peer', 'session', 'resume', ...flags(a), ...target]);
    assert.equal(resumed.sessionId, pending.sessionId);
    assert.equal(resumed.localReceipt.phase, 'committed'); assert.equal(resumed.remoteReceipt.phase, 'committed');
    await equal('practice/retry-23.md', `23\n${'retry data\n'.repeat(1024)}`);
    checks.push('process-interruption-resume');
    await stop(server);
    return { scope: 'same-host-loopback', version, executableSHA256: createHash('sha256').update(await readFile(executable)).digest('hex'), checks, interruptedSession: pending.sessionId, path: '' };
  } finally {
    const stopped = [...children].map(child => new Promise(accept => { child.once('close', accept); child.kill('SIGKILL'); }));
    await Promise.all(stopped);
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2), index = args.indexOf('--executable');
  assert.equal(args.length, 2, 'Usage: node scripts/release/verify-peer.mjs --executable /absolute/path/to/gmem');
  assert.equal(index, 0, 'Use --executable /absolute/path/to/gmem');
  console.log(JSON.stringify(await runPeerAcceptance({ executable: args[1] })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
