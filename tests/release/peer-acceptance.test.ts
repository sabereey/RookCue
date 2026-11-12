import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { runPeerAcceptance } from '../../scripts/release/verify-peer.mjs';

it('runs the independent acceptance harness against real CLI child processes', async () => {
  const evidence = await runPeerAcceptance({ executable: process.execPath, prefix: [resolve('dist/src/cli.js')] });
  expect(evidence.scope).toBe('same-host-loopback');
  expect(evidence.checks).toEqual(expect.arrayContaining([
    'private-pairing', 'initial-bidirectional', 'incremental-bidirectional', 'no-op',
    'conflict-resolution', 'intentional-deletion', 'process-interruption-resume',
  ]));
  expect(evidence.interruptedSession).toMatch(/^[0-9a-f-]{36}$/);
  expect(evidence.path).toBe('');
}, 90_000);
