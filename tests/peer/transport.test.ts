import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { DomainError } from '../../src/domain/errors.js';
import { ensureIdentity, getTrustedPeer, renewIdentity, forgetPeer, trustPeer } from '../../src/peer/identity.js';
import { connectPeer, pairFromInvitation, serveInvitation, servePeer, TRANSPORT_LIMITS } from '../../src/peer/transport.js';
const roots: string[] = [];
const handles: {
    close(): Promise<void>;
}[] = [];
async function root() {
    const path = await mkdtemp(join(tmpdir(), 'gmem-transport-'));
    roots.push(path);
    return path;
}
afterEach(async () => {
    await Promise.all(handles.splice(0).map(h => h.close()));
    await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })));
});
async function pair() {
    const a = await root(), b = await root(), invite = join(await root(), 'invite.json');
    const listener = await serveInvitation({ personalRoot: a, bind: '127.0.0.1', port: 0, invitationPath: invite });
    handles.push(listener);
    const result = await pairFromInvitation({ personalRoot: b, invitationPath: invite });
    return { a, b, invite, listener, result };
}
async function rawTls(clientRoot: string, serverRoot: string, address: string): Promise<TLSSocket> {
    const identity = await ensureIdentity(clientRoot), serverIdentity = await ensureIdentity(serverRoot);
    const [host, port] = address.split(':');
    const socket = tlsConnect({ host: host!, port: Number(port), key: identity.privateKeyPem, cert: identity.certificatePem, ca: [serverIdentity.certificatePem], servername: `gmem-${serverIdentity.peerId}.invalid`, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
    socket.on('error', () => {
    });
    handles.push({ close: async () => {
            socket.destroy();
        } });
    await new Promise<void>((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
    });
    return socket;
}
function rawFrame(socket: TLSSocket, value: unknown): void {
    const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(5);
    header[0] = 1;
    header.writeUInt32BE(bytes.length, 1);
    socket.write(Buffer.concat([header, bytes]));
}
function closed(socket: TLSSocket): Promise<void> {
    return socket.destroyed ? Promise.resolve() : new Promise(resolve => socket.once('close', () => resolve()));
}
describe('bounded TLS LAN transport (isolated loopback evidence)', () => {
    it('pairs fresh identities and writes a private invitation without revealing the token in results', async () => {
        const { a, b, invite, result } = await pair();
        const ai = await ensureIdentity(a), bi = await ensureIdentity(b);
        expect(await getTrustedPeer(a)).toMatchObject({ peerId: bi.peerId });
        expect(await getTrustedPeer(b)).toMatchObject({ peerId: ai.peerId });
        expect((await stat(invite)).mode & 0o777).toBe(0o600);
        expect(JSON.stringify(result)).not.toContain(JSON.parse(await readFile(invite, 'utf8')).token);
    });
    it('supports same-candidate pairing retry but rejects a second identity and wrong tokens', async () => {
        const { b, invite } = await pair();
        await expect(pairFromInvitation({ personalRoot: b, invitationPath: invite })).resolves.toBeDefined();
        await expect(pairFromInvitation({ personalRoot: await root(), invitationPath: invite })).rejects.toThrow();
        const value = JSON.parse(await readFile(invite, 'utf8'));
        value.token = 'x'.repeat(43);
        await writeFile(invite, JSON.stringify(value), { mode: 0o600 });
        await expect(pairFromInvitation({ personalRoot: b, invitationPath: invite })).rejects.toThrow();
    });
    it('rejects expired invitations and copied self identities', async () => {
        const { a, b, invite } = await pair();
        await expect(pairFromInvitation({ personalRoot: a, invitationPath: invite })).rejects.toThrow();
        const value = JSON.parse(await readFile(invite, 'utf8'));
        value.expiresAt = new Date(0).toISOString();
        await writeFile(invite, JSON.stringify(value), { mode: 0o600 });
        await expect(pairFromInvitation({ personalRoot: b, invitationPath: invite })).rejects.toThrow(/expir/i);
    });
    it('requires authenticated mutual TLS and gives the handler the proven peer identity', async () => {
        const { a, b } = await pair(), bi = await ensureIdentity(b);
        const server = await servePeer({ personalRoot: a, bind: '127.0.0.1', port: 0, allowApply: true, handler: async (request) => ({ peerId: request.peerId, kind: request.kind }) });
        handles.push(server);
        const client = await connectPeer({ personalRoot: b, peerId: (await ensureIdentity(a)).peerId, address: server.address });
        handles.push(client);
        expect(await client.request('snapshot', { peerId: 'forged' })).toEqual({ peerId: bi.peerId, kind: 'snapshot' });
        await expect(connectPeer({ personalRoot: await root(), peerId: (await ensureIdentity(a)).peerId, address: server.address })).rejects.toThrow();
        await forgetPeer(a, bi.peerId);
        await expect(client.request('snapshot', {})).rejects.toThrow();
    });
    it('denies knowledge RPC on a pairing-only listener', async () => {
        const { a, b, listener } = await pair();
        const client = await connectPeer({ personalRoot: b, peerId: (await ensureIdentity(a)).peerId, address: listener.address });
        handles.push(client);
        await expect(client.request('snapshot', {})).rejects.toThrow();
    });
    it('denies mutating methods on read-only servers', async () => {
        const { a, b } = await pair();
        let calls = 0;
        const server = await servePeer({ personalRoot: a, bind: '127.0.0.1', port: 0, allowApply: false, handler: async () => {
                calls++;
                return { ok: true };
            } });
        handles.push(server);
        const client = await connectPeer({ personalRoot: b, peerId: (await ensureIdentity(a)).peerId, address: server.address });
        handles.push(client);
        await expect(client.request('apply', {})).rejects.toMatchObject({ code: 'P2P_READ_ONLY' });
        expect(calls).toBe(0);
        expect(await client.request('snapshot', {})).toEqual({ ok: true });
    });
    it('provides the TLS-proven certificate to business admission checks',async()=>{
        const {a,b}=await pair();
        const server=await servePeer({personalRoot:a,bind:'127.0.0.1',port:0,allowApply:true,handler:async req=>({certificate:req.certificatePem})});
        handles.push(server);
        const client=await connectPeer({personalRoot:b,peerId:(await ensureIdentity(a)).peerId,address:server.address});handles.push(client);
        expect(await client.request('snapshot',{})).toEqual({certificate:(await ensureIdentity(b)).certificatePem});
    });
    it('transfers binary assets in bounded chunks and rejects oversized metadata/assets before handler access', async () => {
        const { a, b } = await pair();
        const bytes = Buffer.alloc(2 * 1024 * 1024, 0xaa);
        let uploaded: Buffer | undefined;
        const server = await servePeer({ personalRoot: a, bind: '127.0.0.1', port: 0, allowApply: true, handler: async (req) => {
                if (req.kind === 'upload') {
                    uploaded = req.asset;
                    return { size: req.asset?.length };
                }
                return bytes;
            } });
        handles.push(server);
        const client = await connectPeer({ personalRoot: b, peerId: (await ensureIdentity(a)).peerId, address: server.address });
        handles.push(client);
        expect(await client.upload('upload', {}, bytes)).toEqual({ size: bytes.length });
        expect(uploaded?.equals(bytes)).toBe(true);
        expect((await client.download('download', {})).equals(bytes)).toBe(true);
        await expect(client.request('snapshot', { large: 'x'.repeat(TRANSPORT_LIMITS.metadataBytes) })).rejects.toThrow(/limit/i);
        await expect(client.upload('upload', {}, Buffer.alloc(TRANSPORT_LIMITS.assetBytes + 1))).rejects.toThrow(/limit/i);
    });
    it('refreshes same-SPKI trust while leaving pending sessions intact', async () => {
        const { a, b } = await pair();
        const ai = await ensureIdentity(a), bi = await ensureIdentity(b);
        const pairDirectory = join(a, '.p2p', 'peers', bi.peerId);
        await mkdir(pairDirectory, { recursive: true, mode: 0o700 });
        const pending = join(pairDirectory, 'pending.json');
        await writeFile(pending, '{"pending":true}');
        await renewIdentity(a);
        await renewIdentity(b);
        const invite = join(await root(), 'refresh.json');
        const listener = await serveInvitation({ personalRoot: a, bind: '127.0.0.1', port: 0, invitationPath: invite, refresh: true });
        handles.push(listener);
        const changedKey = await root();
        await ensureIdentity(changedKey);
        await trustPeer(changedKey, (await ensureIdentity(a)).certificatePem);
        await expect(pairFromInvitation({ personalRoot: changedKey, invitationPath: invite, refresh: true })).rejects.toThrow();
        expect((await getTrustedPeer(a))?.peerId).toBe(bi.peerId);
        await pairFromInvitation({ personalRoot: b, invitationPath: invite, refresh: true });
        expect((await getTrustedPeer(a))?.peerId).toBe(bi.peerId);
        expect((await getTrustedPeer(b))?.peerId).toBe(ai.peerId);
        expect(await readFile(pending, 'utf8')).toBe('{"pending":true}');
        const server = await servePeer({ personalRoot: a, bind: '127.0.0.1', port: 0, allowApply: false, handler: () => ({ refreshed: true }) });
        handles.push(server);
        const client = await connectPeer({ personalRoot: b, peerId: ai.peerId, address: server.address });
        handles.push(client);
        expect(await client.request('status', {})).toEqual({ refreshed: true });
    });
    it.each(['0.0.0.0', '8.8.8.8', 'localhost', '::1', '192.0.2.1', '192.168.254.253'])('rejects invalid/unassigned bind %s', async (bind) => {
        await expect(serveInvitation({ personalRoot: await root(), bind, port: 0, invitationPath: join(await root(), 'invite') })).rejects.toThrow();
    });
    it('closes the listener and active channels without waiting for idle sockets', async () => {
        const { a, b } = await pair();
        const server = await servePeer({ personalRoot: a, bind: '127.0.0.1', port: 0, allowApply: false, handler: async () => ({}) });
        handles.push(server);
        const client = await connectPeer({ personalRoot: b, peerId: (await ensureIdentity(a)).peerId, address: server.address });
        handles.push(client);
        await server.close();
        await expect(client.request('snapshot', {})).rejects.toThrow();
        const [host, port] = server.address.split(':');
        await expect(new Promise((resolve, reject) => {
            const s = createConnection({ host: host!, port: Number(port) });
            s.once('connect', () => {
                s.destroy();
                resolve(undefined);
            });
            s.once('error', reject);
        })).rejects.toThrow();
    });
    it('rejects an unpaired certificate at strict TLS before business dispatch', async () => {
        const { a } = await pair();
        let calls = 0;
        const server = await servePeer({ personalRoot: a, bind: '127.0.0.1', port: 0, allowApply: true, handler: async () => {
                calls++;
                return {};
            } });
        handles.push(server);
        const socket = await rawTls(await root(), a, server.address);
        const done = closed(socket);
        socket.resume();
        rawFrame(socket, { version: 1, kind: 'snapshot', transfer: 'none', metadata: {} });
        await done;
        expect(calls).toBe(0);
    });
    it('pins the invitation certificate while preserving normal server-name validation', async () => {
        const { a, invite } = await pair();
        const attacker = await ensureIdentity(await root());
        const value = JSON.parse(await readFile(invite, 'utf8'));
        value.peerId = attacker.peerId;
        value.certificatePem = attacker.certificatePem;
        await writeFile(invite, JSON.stringify(value));
        await expect(pairFromInvitation({ personalRoot: await root(), invitationPath: invite })).rejects.toThrow(/TLS/i);
        expect((await getTrustedPeer(a))?.peerId).not.toBe(attacker.peerId);
    });
    it('rejects a declared oversized frame before waiting for its payload', async () => {
        const { a, b } = await pair();
        let calls = 0;
        const server = await servePeer({ personalRoot: a, bind: '127.0.0.1', port: 0, allowApply: true, handler: () => {
                calls++;
                return {};
            } });
        handles.push(server);
        const socket = await rawTls(b, a, server.address);
        const done = closed(socket);
        socket.resume();
        const header = Buffer.alloc(5);
        header[0] = 1;
        header.writeUInt32BE(TRANSPORT_LIMITS.metadataBytes + 1, 1);
        socket.write(header);
        await done;
        expect(calls).toBe(0);
    });
    it('bounds the aggregate binary transfer and keeps a connection serialized', async () => {
        const { a, b } = await pair();
        const bytes = Buffer.alloc(TRANSPORT_LIMITS.assetBytes, 0xab);
        let calls = 0;
        const server = await servePeer({ personalRoot: a, bind: '127.0.0.1', port: 0, allowApply: true, handler: () => {
                calls++;
                return { ok: true };
            } });
        handles.push(server);
        const client = await connectPeer({ personalRoot: b, peerId: (await ensureIdentity(a)).peerId, address: server.address });
        handles.push(client);
        for (let n = 0; n < 8; n++)
            await client.upload('upload', {}, bytes);
        await expect(client.upload('upload', {}, Buffer.from('one too many'))).rejects.toThrow(/session.*limit/i);
        expect(calls).toBe(8);
    }, 15000);
    it('preserves stable domain error codes without exposing handler details', async () => {
        const { a, b } = await pair();
        const server = await servePeer({ personalRoot: a, bind: '127.0.0.1', port: 0, allowApply: true, handler: () => {
                throw new DomainError('P2P_PENDING', 'secret-token-in-message', { token: 'secret-token-in-details' });
            } });
        handles.push(server);
        const client = await connectPeer({ personalRoot: b, peerId: (await ensureIdentity(a)).peerId, address: server.address });
        handles.push(client);
        try {
            await client.request('prepare', {});
            throw new Error('must reject');
        }
        catch (error) {
            expect(error).toMatchObject({ code: 'P2P_PENDING' });
            expect(String(error)).not.toContain('secret-token');
            expect((error as DomainError).details).toEqual({});
        }
    });
    it('expires a foreground server and closes a stalled TLS handshake', async () => {
        const { a } = await pair();
        const server = await servePeer({ personalRoot: a, bind: '127.0.0.1', port: 0, allowApply: false, timeoutMs: 100, handler: () => ({}) });
        handles.push(server);
        const [host, port] = server.address.split(':');
        const socket = createConnection({ host: host!, port: Number(port) });
        socket.on('error', () => {
        });
        await new Promise<void>(resolve => socket.once('close', () => resolve()));
        await server.close();
    });
    it('requires invitation output outside knowledge and creates it exclusively', async () => {
        const a = await root(), output = join(await root(), 'existing.json');
        await writeFile(output, 'keep');
        await expect(serveInvitation({ personalRoot: a, bind: '127.0.0.1', port: 0, invitationPath: output })).rejects.toThrow();
        expect(await readFile(output, 'utf8')).toBe('keep');
        await expect(serveInvitation({ personalRoot: a, bind: '127.0.0.1', port: 0, invitationPath: join(a, 'index.md') })).rejects.toThrow(/knowledge/i);
    });
    it('rejects public or hostname connection addresses before opening a socket', async () => {
        const { a, b } = await pair();
        for (const address of ['8.8.8.8:443', 'localhost:444', '0.0.0.0:123', '[::1]:123'])
            await expect(connectPeer({ personalRoot: b, peerId: (await ensureIdentity(a)).peerId, address })).rejects.toThrow(/IPv4/i);
    });
    it.each([{ version: 2, kind: 'snapshot', transfer: 'none', metadata: {} }, { version: 1, kind: 'upload', transfer: 'upload', metadata: {}, size: TRANSPORT_LIMITS.assetBytes + 1 }])('rejects unsupported protocol or oversized wire asset declarations before dispatch', async (request) => {
        const { a, b } = await pair();
        let calls = 0;
        const server = await servePeer({ personalRoot: a, bind: '127.0.0.1', port: 0, allowApply: true, handler: () => {
                calls++;
                return {};
            } });
        handles.push(server);
        const socket = await rawTls(b, a, server.address);
        const done = closed(socket);
        socket.resume();
        rawFrame(socket, request);
        await done;
        expect(calls).toBe(0);
    });
});
