import { randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { connect, createServer, type TLSSocket, type Server } from 'node:tls';
import { isIP } from 'node:net';
import { constants } from 'node:fs';
import { DomainError } from '../domain/errors.js';
import { isPersonalKnowledgeAsset } from '../personal/personal-asset-paths.js';
import { createInvitation, ensureIdentity, getTrustedPeer, loadIdentity, trustPeer, validatePeerCertificate, type PeerInvitation } from './identity.js';
export const TRANSPORT_LIMITS = Object.freeze({ metadataBytes: 1024 * 1024, assetBytes: 8 * 1024 * 1024, sessionBytes: 64 * 1024 * 1024, chunkBytes: 64 * 1024, pathCount: 4096, idleMs: 30000 });
const VERSION = 1;
const READ_ONLY = new Set(['snapshot', 'status', 'download', 'conflicts']);
export interface PeerRequest {
    peerId: string;
    certificatePem: string;
    kind: string;
    metadata: Record<string, unknown>;
    asset?: Buffer;
}
export type PeerHandler = (request: PeerRequest) => Promise<unknown> | unknown;
export interface PeerServer {
    address: string;
    expiresAt: string;
    close(): Promise<void>;
}
export interface PeerClient {
    request(kind: string, metadata: Record<string, unknown>): Promise<unknown>;
    upload(kind: string, metadata: Record<string, unknown>, bytes: Uint8Array): Promise<unknown>;
    download(kind: string, metadata: Record<string, unknown>): Promise<Buffer>;
    close(): Promise<void>;
}
interface ListenOptions {
    personalRoot: string;
    bind: string;
    port: number;
    timeoutMs?: number;
}
interface WireRequest {
    version: 1;
    kind: string;
    metadata: Record<string, unknown>;
    transfer: 'none' | 'upload' | 'download';
    size?: number;
}
function failure(message: string): Error {
    return new DomainError('P2P_TRANSPORT_ERROR', message);
}
function privateAddress(ip: string): boolean {
    if (isIP(ip) !== 4)
        return false;
    const p = ip.split('.').map(Number);
    return p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168) || p[0] === 127;
}
function parseAddress(address: string): {
    host: string;
    port: number;
} {
    const match = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(address);
    if (!match || !privateAddress(match[1]!))
        throw failure('Address must be a numeric private IPv4 address and port');
    const port = Number(match[2]);
    if (port < 1 || port > 65535)
        throw failure('Invalid peer port');
    return { host: match[1]!, port };
}
function validateBind(bind: string, port: number): void {
    if (!privateAddress(bind))
        throw failure('Bind must be an assigned private IPv4 address');
    if (!bind.startsWith('127.') && !Object.values(networkInterfaces()).flat().some(n => n?.family === 'IPv4' && n.address === bind))
        throw failure('Bind address is not assigned to this machine');
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw failure('Invalid listening port');
}
function timeout(options: ListenOptions): number {
    const ms = options.timeoutMs ?? 300000;
    if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 3600000)
        throw failure('Invalid bounded server timeout');
    return ms;
}
function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function json(value: unknown): Buffer {
    let bytes: Buffer;
    try {
        bytes = Buffer.from(JSON.stringify(value));
    }
    catch {
        throw failure('Invalid JSON metadata');
    }
    if (bytes.length > TRANSPORT_LIMITS.metadataBytes)
        throw failure('Metadata byte limit exceeded');
    return bytes;
}
function requestSchema(value: unknown): WireRequest {
    if (!record(value) || value.version !== VERSION || typeof value.kind !== 'string' || !(/^[a-z][a-z0-9-]{0,63}$/).test(value.kind) || !record(value.metadata) || !['none', 'upload', 'download'].includes(String(value.transfer)))
        throw failure('Invalid protocol request');
    if (value.transfer === 'upload' && (!Number.isSafeInteger(value.size) || Number(value.size) < 0 || Number(value.size) > TRANSPORT_LIMITS.assetBytes))
        throw failure('Asset byte limit exceeded');
    return value as unknown as WireRequest;
}
function peerCertificate(socket: TLSSocket): string {
    const cert = socket.getPeerCertificate();
    if (!cert.raw)
        throw failure('Peer certificate required');
    return new X509Certificate(cert.raw).toString();
}
function sameCertificate(a: string, b: string): boolean {
    return new X509Certificate(a).raw.equals(new X509Certificate(b).raw);
}
function configure(socket: TLSSocket, idleMs: number): void {
    socket.setNoDelay(true);
    socket.setTimeout(idleMs, () => socket.destroy(failure('Peer network timeout')));
    socket.on('error', () => {
    });
}
async function readBytes(socket: TLSSocket, size: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let remaining = size;
    while (remaining) {
        // Consume partial TLS records immediately; read(n) with buffered < n can repeatedly signal readable.
        const available = socket.read(Math.min(remaining, 64 * 1024, socket.readableLength)) as Buffer | null;
        if (available) {
            parts.push(available);
            remaining -= available.length;
            continue;
        }
        if (socket.destroyed || socket.readableEnded)
            throw failure('Peer connection closed');
        await new Promise<void>((resolve, reject) => {
            const done = () => {
                cleanup();
                resolve();
            };
            const closed = () => {
                cleanup();
                reject(failure('Peer connection closed'));
            };
            const failed = () => {
                cleanup();
                reject(failure('Peer network failure'));
            };
            const cleanup = () => {
                socket.off('readable', done);
                socket.off('close', closed);
                socket.off('end', closed);
                socket.off('error', failed);
            };
            socket.once('readable', done);
            socket.once('close', closed);
            socket.once('end', closed);
            socket.once('error', failed);
        });
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, size);
}
async function frame(socket: TLSSocket, type: 1 | 2, max: number): Promise<Buffer> {
    const header = await readBytes(socket, 5);
    const size = header.readUInt32BE(1);
    if (header[0] !== type || size > max)
        throw failure('Peer frame byte limit or type invalid');
    return readBytes(socket, size);
}
async function sendFrame(socket: TLSSocket, type: 1 | 2, bytes: Buffer): Promise<void> {
    if (socket.destroyed || !socket.writable)
        throw failure('Peer connection closed');
    const header = Buffer.alloc(5);
    header[0] = type;
    header.writeUInt32BE(bytes.length, 1);
    for (const part of [header, bytes])
        await new Promise<void>((resolve, reject) => {
            socket.write(part, error => error ? reject(failure('Peer write failed')) : resolve());
        });
}
async function readJson(socket: TLSSocket): Promise<unknown> {
    try {
        return JSON.parse((await frame(socket, 1, TRANSPORT_LIMITS.metadataBytes)).toString('utf8'));
    }
    catch {
        throw failure('Invalid or oversized peer metadata');
    }
}
async function writeJson(socket: TLSSocket, value: unknown): Promise<void> {
    await sendFrame(socket, 1, json(value));
}
async function readAsset(socket: TLSSocket, size: number): Promise<Buffer> {
    if (!Number.isSafeInteger(size) || size < 0 || size > TRANSPORT_LIMITS.assetBytes)
        throw failure('Asset byte limit exceeded');
    const chunks: Buffer[] = [];
    let received = 0;
    while (received < size) {
        const chunk = await frame(socket, 2, Math.min(TRANSPORT_LIMITS.chunkBytes, size - received));
        if (!chunk.length)
            throw failure('Invalid empty asset chunk');
        chunks.push(chunk);
        received += chunk.length;
    }
    return Buffer.concat(chunks, size);
}
async function writeAsset(socket: TLSSocket, bytes: Buffer): Promise<void> {
    for (let n = 0; n < bytes.length; n += TRANSPORT_LIMITS.chunkBytes)
        await sendFrame(socket, 2, bytes.subarray(n, n + TRANSPORT_LIMITS.chunkBytes));
}
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(failure('Peer operation timeout')), ms);
                timer.unref();
            })]);
    }
    finally {
        clearTimeout(timer);
    }
}
async function privateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
        throw failure('Peer state directory must be private and not a symlink');
}
async function privateState(path: string, value: unknown): Promise<void> {
    const temp = join(dirname(path), `.${randomUUID()}.tmp`);
    let file;
    try {
        file = await open(temp, 'wx', 0o600);
        await file.writeFile(JSON.stringify(value));
        await file.sync();
        await file.close();
        file = undefined;
        await rename(temp, path);
        const dir = await open(dirname(path), 'r');
        try {
            await dir.sync();
        }
        finally {
            await dir.close();
        }
    }
    finally {
        await file?.close();
        await unlink(temp).catch(() => {
        });
    }
}
async function invitationOutput(root: string, path: string): Promise<string> {
    const target = join(await realpath(dirname(resolve(path))), basename(path));
    const rel = relative(await realpath(root), target).split(sep).join('/');
    if (!rel.startsWith('../') && !isAbsolute(rel) && isPersonalKnowledgeAsset(rel))
        throw failure('Invitation cannot be a knowledge asset');
    return target;
}
async function listen(options: ListenOptions, tlsOptions: Parameters<typeof createServer>[0], handle: (socket: TLSSocket) => Promise<void>): Promise<PeerServer> {
    validateBind(options.bind, options.port);
    const lifetime = timeout(options);
    const sockets = new Set<TLSSocket>();
    let closing: Promise<void> | undefined;
    const server: Server = createServer({ ...tlsOptions, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', handshakeTimeout: Math.min(lifetime, TRANSPORT_LIMITS.idleMs) }, socket => {
        sockets.add(socket);
        configure(socket, Math.min(lifetime, TRANSPORT_LIMITS.idleMs));
        socket.once('close', () => sockets.delete(socket));
        void handle(socket).catch(() => socket.destroy());
    });
    server.maxConnections = 8;
    server.on('connection', socket => {
        const tlsSocket = socket as TLSSocket;
        sockets.add(tlsSocket);
        socket.once('close', () => sockets.delete(tlsSocket));
    });
    server.on('tlsClientError', () => {
    });
    server.on('error', () => {
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.bind, () => {
            server.off('error', reject);
            resolve();
        });
    });
    const bound = server.address();
    if (!bound || typeof bound === 'string')
        throw failure('Listener address unavailable');
    const close = (): Promise<void> => closing ??= (async () => {
        clearTimeout(timer);
        for (const socket of sockets)
            socket.destroy();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    })();
    const timer = setTimeout(() => {
        void close();
    }, lifetime);
    timer.unref();
    return { address: `${options.bind}:${bound.port}`, expiresAt: new Date(Date.now() + lifetime).toISOString(), close };
}
async function secureConnect(personalRoot: string, peerId: string, certificatePem: string, address: string): Promise<TLSSocket> {
    const identity = await loadIdentity(personalRoot);
    if (!identity)
        throw failure('Local peer identity is missing');
    validatePeerCertificate(identity.certificatePem, identity.peerId);
    validatePeerCertificate(certificatePem, peerId);
    if (identity.peerId === peerId)
        throw failure('Cannot connect identity to itself');
    const target = parseAddress(address);
    const socket = connect({ ...target, key: identity.privateKeyPem, cert: identity.certificatePem, ca: [certificatePem], servername: `gmem-${peerId}.invalid`, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: true });
    configure(socket, TRANSPORT_LIMITS.idleMs);
    try {
        await bounded(new Promise<void>((resolve, reject) => {
            socket.once('secureConnect', () => {
                socket.off('error', reject);
                resolve();
            });
            socket.once('error', reject);
            socket.once('close', () => reject(failure('TLS connection closed')));
        }), TRANSPORT_LIMITS.idleMs);
        const actual = peerCertificate(socket);
        validatePeerCertificate(actual, peerId);
        if (!sameCertificate(actual, certificatePem))
            throw failure('Peer certificate pin differs');
        return socket;
    }
    catch {
        socket.destroy();
        throw failure('Authenticated TLS connection failed');
    }
}
export async function serveInvitation(options: ListenOptions & {
    invitationPath: string;
    refresh?: boolean;
}): Promise<PeerServer> {
    validateBind(options.bind, options.port);
    const lifetime = Math.min(timeout(options), 300000);
    const identity = await ensureIdentity(options.personalRoot);
    if (options.refresh && !await getTrustedPeer(options.personalRoot))
        throw failure('Refresh requires existing trust');
    const output = await invitationOutput(options.personalRoot, options.invitationPath);
    const p2p = join(options.personalRoot, '.p2p');
    await privateDirectory(p2p);
    await privateDirectory(join(p2p, 'pairings'));
    let invitation: PeerInvitation;
    let candidate: string | undefined;
    let gate: Promise<unknown> = Promise.resolve();
    const server = await listen({ ...options, timeoutMs: lifetime }, { key: identity.privateKeyPem, cert: identity.certificatePem, requestCert: true, rejectUnauthorized: false }, async (socket) => {
        while (!socket.destroyed) {
            const raw = await readJson(socket);
            const process = gate.then(async () => {
                try {
                    const request = requestSchema(raw);
                    if (request.kind !== 'pair' || request.transfer !== 'none')
                        throw failure('Pairing listener accepts pairing only');
                    if (Date.parse(invitation.expiresAt) <= Date.now())
                        throw failure('Invitation expired');
                    const meta = request.metadata;
                    const token = typeof meta.token === 'string' ? Buffer.from(meta.token) : Buffer.alloc(0);
                    const expected = Buffer.from(invitation.token);
                    if (meta.pairingId !== invitation.pairingId || meta.refresh !== invitation.refresh || token.length !== expected.length || !timingSafeEqual(token, expected))
                        throw failure('Invalid pairing authorization');
                    const certificate = peerCertificate(socket);
                    const validated = validatePeerCertificate(certificate);
                    if (candidate && candidate !== validated.peerId)
                        throw failure('Invitation already redeemed');
                    await trustPeer(options.personalRoot, certificate, { refresh: invitation.refresh });
                    candidate = validated.peerId;
                    await privateState(join(p2p, 'pairings', `${invitation.pairingId}.json`), { version: 1, pairingId: invitation.pairingId, peerId: candidate, expiresAt: invitation.expiresAt });
                    await writeJson(socket, { version: VERSION, ok: true, result: { peerId: identity.peerId, localPeerId: candidate } });
                }
                catch {
                    await writeJson(socket, { version: VERSION, ok: false, error: 'Pairing rejected' });
                }
            });
            gate = process.catch(() => {
            });
            await process;
        }
    });
    try {
        invitation = createInvitation(identity, server.address, { refresh: options.refresh ?? false, ttlMs: lifetime });
        const file = await open(output, 'wx', 0o600);
        try {
            await file.writeFile(JSON.stringify(invitation));
            await file.sync();
        }
        finally {
            await file.close();
        }
        return server;
    }
    catch (error) {
        await server.close();
        throw error;
    }
}
export async function pairFromInvitation(options: {
    personalRoot: string;
    invitationPath: string;
    refresh?: boolean;
}): Promise<{
    peerId: string;
    localPeerId: string;
}> {
    const path = resolve(options.invitationPath);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: unknown;
    try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > TRANSPORT_LIMITS.metadataBytes)
            throw failure('Invitation must be a private bounded regular file');
        try {
            const bytes = Buffer.alloc(info.size + 1);
            const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
            const after = await file.stat();
            if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
                throw failure('Invitation changed while reading');
            value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
        }
        catch {
            throw failure('Invalid invitation file');
        }
    }
    finally {
        await file.close();
    }
    if (!record(value) || value.version !== 1 || typeof value.address !== 'string' || typeof value.peerId !== 'string' || typeof value.certificatePem !== 'string' || typeof value.token !== 'string' || !(/^[A-Za-z0-9_-]{43}$/).test(value.token) || typeof value.pairingId !== 'string' || typeof value.expiresAt !== 'string' || typeof value.refresh !== 'boolean')
        throw failure('Invalid invitation');
    const invitation = value as unknown as PeerInvitation;
    const expires = Date.parse(invitation.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 300000)
        throw failure('Invitation expired or validity invalid');
    if (invitation.refresh !== (options.refresh ?? false))
        throw failure('Refresh must be explicit on both endpoints');
    parseAddress(invitation.address);
    validatePeerCertificate(invitation.certificatePem, invitation.peerId);
    const identity = await ensureIdentity(options.personalRoot);
    if (identity.peerId === invitation.peerId)
        throw failure('Cannot pair identity to itself');
    const existing = await getTrustedPeer(options.personalRoot);
    if (existing && (existing.peerId !== invitation.peerId || (!options.refresh && !sameCertificate(existing.certificatePem, invitation.certificatePem))))
        throw failure('Existing peer trust differs');
    if (options.refresh && !existing)
        throw failure('Refresh requires existing trust');
    const socket = await secureConnect(options.personalRoot, invitation.peerId, invitation.certificatePem, invitation.address);
    try {
        await writeJson(socket, { version: VERSION, kind: 'pair', transfer: 'none', metadata: { token: invitation.token, pairingId: invitation.pairingId, refresh: invitation.refresh } });
        const response = await readJson(socket);
        if (!record(response) || response.ok !== true || !record(response.result) || response.result.peerId !== invitation.peerId)
            throw failure('Pairing rejected');
        await trustPeer(options.personalRoot, invitation.certificatePem, { refresh: options.refresh ?? false });
        return { peerId: invitation.peerId, localPeerId: identity.peerId };
    }
    finally {
        socket.destroy();
    }
}
export async function servePeer(options: ListenOptions & {
    allowApply: boolean;
    handler: PeerHandler;
}): Promise<PeerServer> {
    const identity = await loadIdentity(options.personalRoot);
    if (!identity)
        throw failure('Local peer identity is missing');
    validatePeerCertificate(identity.certificatePem, identity.peerId);
    const trusted = await getTrustedPeer(options.personalRoot);
    if (!trusted)
        throw failure('No trusted peer');
    validatePeerCertificate(trusted.certificatePem, trusted.peerId);
    return listen(options, { key: identity.privateKeyPem, cert: identity.certificatePem, ca: [trusted.certificatePem], requestCert: true, rejectUnauthorized: true }, async (socket) => {
        if (!socket.authorized)
            throw failure('Mutual TLS required');
        const certificate = peerCertificate(socket);
        const proven = validatePeerCertificate(certificate, trusted.peerId);
        if (!sameCertificate(certificate, trusted.certificatePem))
            throw failure('Peer certificate differs');
        const checkTrust = async () => {
            const current = await getTrustedPeer(options.personalRoot, proven.peerId);
            if (!current || !sameCertificate(certificate, current.certificatePem))
                throw failure('Peer trust changed');
            validatePeerCertificate(current.certificatePem, proven.peerId);
        };
        let total = 0;
        while (!socket.destroyed) {
            const request = requestSchema(await readJson(socket));
            await checkTrust();
            if (!options.allowApply && !READ_ONLY.has(request.kind)) {
                await writeJson(socket, { version: VERSION, ok: false, error: { code: 'P2P_READ_ONLY', message: 'Peer server is read-only' } });
                if (request.transfer === 'upload')
                    throw failure('Read-only upload rejected');
                continue;
            }
            if (request.kind === 'pair')
                throw failure('Pairing requires a separate invitation listener');
            total += request.transfer === 'upload' ? request.size! : 0;
            if (total > TRANSPORT_LIMITS.sessionBytes)
                throw failure('Session byte limit exceeded');
            const asset = request.transfer === 'upload' ? await readAsset(socket, request.size!) : undefined;
            // An upload can stall while an owner revokes or refreshes trust.
            await checkTrust();
            try {
                const result = await bounded(Promise.resolve(options.handler({ peerId: proven.peerId, certificatePem: certificate, kind: request.kind, metadata: request.metadata, ...(asset ? { asset } : {}) })), Math.min(timeout(options), TRANSPORT_LIMITS.idleMs));
                if (request.transfer === 'download') {
                    if (!Buffer.isBuffer(result) || result.length > TRANSPORT_LIMITS.assetBytes)
                        throw failure('Asset byte limit exceeded');
                    total += result.length;
                    if (total > TRANSPORT_LIMITS.sessionBytes)
                        throw failure('Session byte limit exceeded');
                    await writeJson(socket, { version: VERSION, ok: true, assetSize: result.length });
                    await writeAsset(socket, result);
                }
                else
                    await writeJson(socket, { version: VERSION, ok: true, result: result ?? null });
            }
            catch (error) {
                await writeJson(socket, { version: VERSION, ok: false, error: { code: error instanceof DomainError && /^P2P_[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'P2P_REMOTE_ERROR', message: 'Peer request failed' } });
            }
        }
    });
}
export async function connectPeer(options: {
    personalRoot: string;
    peerId: string;
    address: string;
}): Promise<PeerClient> {
    const trusted = await getTrustedPeer(options.personalRoot, options.peerId);
    if (!trusted)
        throw failure('No trusted peer');
    const socket = await secureConnect(options.personalRoot, options.peerId, trusted.certificatePem, options.address);
    let chain: Promise<unknown> = Promise.resolve();
    let total = 0;
    const operation = async (kind: string, metadata: Record<string, unknown>, transfer: WireRequest['transfer'], bytes?: Uint8Array): Promise<unknown> => {
        const upload = bytes ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : undefined;
        const request: WireRequest = { version: 1, kind, metadata, transfer, ...(upload ? { size: upload.length } : {}) };
        requestSchema(request);
        json(request);
        if (upload && total + upload.length > TRANSPORT_LIMITS.sessionBytes)
            throw failure('Session byte limit exceeded');
        const execute = async () => {
            const current = await getTrustedPeer(options.personalRoot, options.peerId);
            if (!current || !sameCertificate(current.certificatePem, trusted.certificatePem))
                throw failure('Peer trust changed');
            validatePeerCertificate(current.certificatePem, options.peerId);
            if (upload && total + upload.length > TRANSPORT_LIMITS.sessionBytes)
                throw failure('Session byte limit exceeded');
            await writeJson(socket, request);
            if (upload) {
                total += upload.length;
                await writeAsset(socket, upload);
            }
            const reply = await readJson(socket);
            if (!record(reply) || reply.version !== VERSION || typeof reply.ok !== 'boolean')
                throw failure('Invalid protocol response');
            if (!reply.ok) {
                if (record(reply.error) && typeof reply.error.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(reply.error.code))
                    throw new DomainError(reply.error.code, 'Peer request failed');
                throw failure(typeof reply.error === 'string' ? reply.error : 'Peer request failed');
            }
            if (transfer === 'download') {
                const size = reply.assetSize;
                if (!Number.isSafeInteger(size) || Number(size) < 0 || Number(size) > TRANSPORT_LIMITS.assetBytes || total + Number(size) > TRANSPORT_LIMITS.sessionBytes)
                    throw failure('Asset or session byte limit exceeded');
                total += Number(size);
                return readAsset(socket, Number(size));
            }
            return reply.result;
        };
        const next = chain.then(execute);
        chain = next.catch(() => {
        });
        return next;
    };
    return { request: (kind, metadata) => operation(kind, metadata, 'none'), upload: (kind, metadata, bytes) => operation(kind, metadata, 'upload', bytes), download: async (kind, metadata) => await operation(kind, metadata, 'download') as Buffer, close: async () => {
            socket.destroy();
        } };
}
