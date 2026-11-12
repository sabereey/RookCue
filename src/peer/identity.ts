import "reflect-metadata";
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, webcrypto, X509Certificate as NodeCertificate } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isIPv4 } from "node:net";
import { z } from "zod";
import { BasicConstraintsExtension, ExtendedKeyUsage, ExtendedKeyUsageExtension, KeyUsageFlags, KeyUsagesExtension, SubjectAlternativeNameExtension, X509Certificate, X509CertificateGenerator } from "@peculiar/x509";
import { DomainError } from "../domain/errors.js";
import { withLocalRootLock } from "../storage/root-lock.js";
import { assertSafePath } from "../storage/snapshot-files.js";

export interface PeerIdentity { peerId: string; privateKeyPem: string; certificatePem: string; expiresAt: string }
export interface TrustedPeer { peerId: string; certificatePem: string; pairedAt: string }
export interface PeerInvitation { version: 1; address: string; certificatePem: string; peerId: string; token: string; pairingId: string; expiresAt: string; refresh: boolean }
export interface ValidatedPeerCertificate { peerId: string; certificatePem: string; expiresAt: string }

const peerIdSchema = z.string().regex(/^[a-z2-7]{52}$/);
const identitySchema = z.object({ peerId: peerIdSchema, privateKeyPem: z.string().max(4096), certificatePem: z.string().max(16384), expiresAt: z.iso.datetime() }).strict();
const trustSchema = z.object({ peerId: peerIdSchema, certificatePem: z.string().max(16384), pairedAt: z.iso.datetime() }).strict();
const YEAR_MS = 365 * 86400_000;
const MAX_STATE_BYTES = 32768;
const signingAlgorithm = { name: "ECDSA", hash: "SHA-256" };
const keyAlgorithm = { name: "ECDSA", namedCurve: "P-256" };

function invalid(message: string): never { throw new DomainError("PEER_IDENTITY_INVALID", message); }
function peerIdFor(publicKeyDer: Buffer): string {
  const bytes = createHash("sha256").update(publicKeyDer).digest();
  let accumulator = 0, bits = 0, result = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; result += "abcdefghijklmnopqrstuvwxyz234567"[(accumulator >>> bits) & 31]; }
  }
  if (bits) result += "abcdefghijklmnopqrstuvwxyz234567"[(accumulator << (5 - bits)) & 31];
  return result;
}

/** Validate the certificate profile and stable SPKI identity. Public callers always enforce validity. */
export function validatePeerCertificate(certificatePem: string, expectedPeerId?: string): ValidatedPeerCertificate {
  return inspectCertificate(certificatePem, expectedPeerId, true);
}

function inspectCertificate(certificatePem: string, expectedPeerId: string | undefined, enforceValidity: boolean): ValidatedPeerCertificate {
  try {
    if (typeof certificatePem !== "string" || certificatePem.length > 16384 || !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\s*$/.test(certificatePem)) invalid("Invalid peer certificate encoding");
    const cert = new NodeCertificate(certificatePem);
    const parsed = new X509Certificate(certificatePem);
    const signature = parsed.signatureAlgorithm as { name: string; hash?: { name: string } };
    if (signature.name !== "ECDSA" || signature.hash?.name !== "SHA-256" || cert.publicKey.asymmetricKeyType !== "ec" || cert.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") invalid("Peer certificate must use P-256 and ECDSA SHA-256");
    const peerId = peerIdFor(cert.publicKey.export({ type: "spki", format: "der" }));
    if (expectedPeerId !== undefined && (!peerIdSchema.safeParse(expectedPeerId).success || expectedPeerId !== peerId)) invalid("Peer certificate SPKI does not match expected peer identity");
    if (cert.subject !== cert.issuer || !cert.verify(cert.publicKey)) invalid("Peer certificate must be self-signed");
    if (cert.subjectAltName !== `DNS:gmem-${peerId}.invalid`) invalid("Peer certificate SAN does not match SPKI identity");
    const basic = parsed.getExtension(BasicConstraintsExtension);
    const usages = parsed.getExtension(KeyUsagesExtension);
    const extended = parsed.getExtension(ExtendedKeyUsageExtension);
    if (!basic || basic.ca || cert.ca || !usages || usages.usages !== KeyUsageFlags.digitalSignature || !extended || extended.usages.length !== 2 || !extended.usages.includes(ExtendedKeyUsage.serverAuth) || !extended.usages.includes(ExtendedKeyUsage.clientAuth)) invalid("Invalid peer certificate constraints or key usages");
    const extensionTypes = parsed.extensions.map(extension => extension.type);
    if (new Set(extensionTypes).size !== extensionTypes.length) invalid("Duplicate peer certificate extensions");
    const known = new Set(["2.5.29.19", "2.5.29.15", "2.5.29.37", "2.5.29.17"]);
    if (parsed.extensions.some(extension => extension.critical && !known.has(extension.type))) invalid("Unknown critical peer certificate extension");
    const before = parsed.notBefore.getTime(), after = parsed.notAfter.getTime();
    if (!Number.isFinite(before) || !Number.isFinite(after) || after <= before || after - before > YEAR_MS + 60_000) invalid("Invalid peer certificate validity period");
    if (enforceValidity && (Date.now() < before || Date.now() >= after)) invalid("Peer certificate expired or not yet valid; explicitly renew and refresh trust");
    return { peerId, certificatePem: cert.toString(), expiresAt: new Date(after).toISOString() };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    invalid("Invalid peer certificate");
  }
}

async function privateDirectory(root: string, create: boolean): Promise<boolean> {
  const personal = resolve(root), directory = join(personal, ".p2p");
  await assertSafePath(personal, "directory", personal);
  if (create) await mkdir(personal, { recursive: true, mode: 0o700 });
  if (!await assertSafePath(directory, "directory", personal)) {
    if (!create) return false;
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
  }
  await assertPrivatePath(personal, directory, "directory");
  return true;
}

async function assertPrivatePath(root: string, path: string, kind: "file" | "directory"): Promise<boolean> {
  if (!await assertSafePath(path, kind, root)) return false;
  const details = await lstat(path);
  if ((details.mode & 0o777) !== (kind === "file" ? 0o600 : 0o700) || (kind === "file" && details.nlink !== 1) || (typeof process.getuid === "function" && details.uid !== process.getuid())) invalid("Peer state requires private permissions, ownership and non-linked files");
  return true;
}

async function readPrivate(root: string, name: string): Promise<unknown | undefined> {
  if (!await privateDirectory(root, false)) return undefined;
  const path = join(resolve(root), ".p2p", name);
  if (!await assertPrivatePath(resolve(root), path, "file")) return undefined;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > MAX_STATE_BYTES) invalid("Invalid private peer state file");
    const raw = await handle.readFile("utf8");
    const after = await handle.stat();
    const current = await lstat(path);
    if (before.ino !== current.ino || before.dev !== current.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) invalid("Peer state changed while reading");
    try { return JSON.parse(raw); } catch { invalid("Invalid private peer state JSON"); }
  } finally { await handle.close(); }
}

async function flushDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && ["EINVAL", "ENOTSUP", "EISDIR"].includes(String(error.code)))) throw error;
  } finally { await handle.close(); }
}

async function writePrivate(root: string, name: string, value: unknown): Promise<void> {
  await privateDirectory(root, true);
  const personal = resolve(root), path = join(personal, ".p2p", name);
  await assertPrivatePath(personal, path, "file");
  const temporary = join(dirname(path), `.write-${randomUUID()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync();
    await assertPrivatePath(personal, path, "file");
    await assertPrivatePath(personal, dirname(path), "directory");
    await rename(temporary, path); await flushDirectory(dirname(path));
  } finally { await handle.close(); await rm(temporary, { force: true }); }
}

async function locked<T>(root: string, operation: () => Promise<T>): Promise<T> {
  await privateDirectory(root, true);
  await assertSafePath(join(resolve(root), ".mutation.lock"), "directory", resolve(root));
  return withLocalRootLock(root, operation);
}

export async function loadIdentity(personalRoot: string): Promise<PeerIdentity | undefined> {
  const raw = await readPrivate(personalRoot, "identity.json");
  if (raw === undefined) return undefined;
  let identity: PeerIdentity;
  try { identity = identitySchema.parse(raw); } catch { invalid("Invalid stored identity schema"); }
  const cert = inspectCertificate(identity.certificatePem, identity.peerId, false);
  try {
    const privateKey = createPrivateKey(identity.privateKeyPem);
    if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" || peerIdFor(createPublicKey(privateKey).export({ type: "spki", format: "der" })) !== identity.peerId || identity.expiresAt !== cert.expiresAt) invalid("Identity key and certificate do not match");
  } catch { invalid("Identity key and certificate do not match"); }
  return identity;
}

async function certificateFor(privateKeyPem?: string): Promise<PeerIdentity> {
  let keys: webcrypto.CryptoKeyPair;
  if (privateKeyPem) {
    const privateDer = createPrivateKey(privateKeyPem).export({ type: "pkcs8", format: "der" });
    const publicDer = createPublicKey(privateKeyPem).export({ type: "spki", format: "der" });
    keys = { privateKey: await webcrypto.subtle.importKey("pkcs8", privateDer, keyAlgorithm, true, ["sign"]), publicKey: await webcrypto.subtle.importKey("spki", publicDer, keyAlgorithm, true, ["verify"]) };
  } else {
    keys = await webcrypto.subtle.generateKey(keyAlgorithm, true, ["sign", "verify"]);
    const der = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
    privateKeyPem = createPrivateKey({ key: der, type: "pkcs8", format: "der" }).export({ type: "pkcs8", format: "pem" }).toString();
  }
  const peerId = peerIdFor(Buffer.from(await webcrypto.subtle.exportKey("spki", keys.publicKey)));
  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: `CN=gmem-${peerId}.invalid`, keys: keys as unknown as CryptoKeyPair, signingAlgorithm,
    serialNumber: `01${randomBytes(15).toString("hex")}`,
    notBefore: new Date(Date.now() - 30_000), notAfter: new Date(Date.now() + YEAR_MS),
    extensions: [new BasicConstraintsExtension(false, undefined, true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true), new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth, ExtendedKeyUsage.clientAuth]), new SubjectAlternativeNameExtension([{ type: "dns", value: `gmem-${peerId}.invalid` }])],
  }, webcrypto as unknown as Crypto);
  const certificatePem = certificate.toString("pem");
  const checked = validatePeerCertificate(certificatePem, peerId);
  return { ...checked, privateKeyPem };
}

export async function ensureIdentity(personalRoot: string): Promise<PeerIdentity> {
  return locked(personalRoot, async () => {
    const existing = await loadIdentity(personalRoot);
    if (existing) return existing;
    const privateRoot = join(resolve(personalRoot), ".p2p");
    // Any durable peer/session state makes silent regeneration unsafe.
    const names = await readdir(privateRoot);
    if (names.some(name => name !== "identity.json" && !name.startsWith(".write-"))) invalid("Identity is missing while peer state remains; restore the original identity");
    const identity = await certificateFor();
    await writePrivate(personalRoot, "identity.json", identity);
    return identity;
  });
}

export async function renewIdentity(personalRoot: string): Promise<PeerIdentity> {
  return locked(personalRoot, async () => {
    const existing = await loadIdentity(personalRoot);
    if (!existing) invalid("Identity does not exist; initialize before explicit renewal");
    const renewed = await certificateFor(existing.privateKeyPem);
    await writePrivate(personalRoot, "identity.json", renewed);
    return renewed;
  });
}

export async function getTrustedPeer(personalRoot: string, peerId?: string): Promise<TrustedPeer | undefined> {
  if (peerId !== undefined && !peerIdSchema.safeParse(peerId).success) invalid("Invalid peer identity");
  const forgetting = await readPrivate(personalRoot, "forgetting.json");
  if (forgetting !== undefined) {
    const result = z.object({ version:z.literal(1), peerId:peerIdSchema }).strict().safeParse(forgetting);
    if (!result.success) invalid("Invalid pending revocation state");
    return undefined;
  }
  const raw = await readPrivate(personalRoot, "trust.json");
  if (raw === undefined) return undefined;
  let peer: TrustedPeer;
  try { peer = trustSchema.parse(raw); } catch { invalid("Invalid trusted peer schema"); }
  inspectCertificate(peer.certificatePem, peer.peerId, false);
  return peerId === undefined || peerId === peer.peerId ? peer : undefined;
}

export async function trustPeer(personalRoot: string, certificatePem: string, options: { refresh?: boolean } = {}): Promise<TrustedPeer> {
  const certificate = validatePeerCertificate(certificatePem);
  return locked(personalRoot, async () => {
    if (await readPrivate(personalRoot, "forgetting.json") !== undefined) invalid("Finish pending peer forgetting cleanup before pairing");
    const identity = await loadIdentity(personalRoot);
    if (!identity) invalid("Local identity is required before trusting a peer");
    if (certificate.peerId === identity.peerId) invalid("Cannot trust self peer identity");
    const previous = await getTrustedPeer(personalRoot);
    if (previous && previous.peerId !== certificate.peerId) invalid("A second peer or changed-key refresh is not allowed; explicitly forget the existing peer first");
    if (!previous) {
      const peers = join(resolve(personalRoot), ".p2p/peers");
      if (await assertSafePath(peers, "directory", resolve(personalRoot))) {
        for (const name of await readdir(peers)) {
          if (!peerIdSchema.safeParse(name).success) invalid("Invalid retained peer state path");
          if (await assertSafePath(join(peers, name, "pending.json"), "file", resolve(personalRoot))) invalid("Cannot create fresh trust with unfinished pending sync work");
          if (name === certificate.peerId && await assertSafePath(join(peers, name, "state.json"), "file", resolve(personalRoot))) invalid("Cannot infer fresh pairing from retained baseline state; explicitly forget it first");
        }
      }
    }
    if (options.refresh && !previous) invalid("Certificate refresh requires an existing peer");
    if (previous && previous.certificatePem !== certificate.certificatePem && !options.refresh) invalid("Certificate changed; explicit same-key refresh is required");
    if (previous?.certificatePem === certificate.certificatePem) return previous;
    const trusted = { peerId: certificate.peerId, certificatePem: certificate.certificatePem, pairedAt: previous?.pairedAt ?? new Date().toISOString() };
    await writePrivate(personalRoot, "trust.json", trusted);
    return trusted;
  });
}

export async function forgetPeer(personalRoot: string, peerId: string): Promise<void> {
  if (!peerIdSchema.safeParse(peerId).success) invalid("Invalid peer identity");
  return locked(personalRoot, async () => {
    const marker = await readPrivate(personalRoot, "forgetting.json");
    if (marker !== undefined) {
      const result=z.object({version:z.literal(1),peerId:peerIdSchema}).strict().safeParse(marker);
      if (!result.success || result.data.peerId !== peerId) invalid("Another peer forgetting cleanup is pending");
    }
    const rawTrust=await readPrivate(personalRoot,"trust.json");
    if(rawTrust!==undefined){
      const parsed=trustSchema.safeParse(rawTrust);
      if(!parsed.success || parsed.data.peerId!==peerId)invalid("A different peer is trusted");
    }
    const pairDirectory=join(resolve(personalRoot),".p2p/peers",peerId);
    const pending=join(pairDirectory,"pending.json");
    if(await assertSafePath(pending,"file",resolve(personalRoot)))invalid("Cannot forget a peer with an unfinished pending sync session");
    const retained=await assertSafePath(pairDirectory,"directory",resolve(personalRoot));
    if(marker===undefined && rawTrust===undefined && !retained)return;
    // Marker is durably visible before any history is removed. Readers fail closed during cleanup.
    if(marker===undefined)await writePrivate(personalRoot,"forgetting.json",{version:1,peerId});
    await rm(join(resolve(personalRoot),".p2p/trust.json"),{force:true});
    await flushDirectory(join(resolve(personalRoot),".p2p"));
    await rm(pairDirectory,{recursive:true,force:true});
    const peers=dirname(pairDirectory);
    if(await assertSafePath(peers,"directory",resolve(personalRoot)))await flushDirectory(peers);
    await rm(join(resolve(personalRoot),".p2p/forgetting.json"));
    await flushDirectory(join(resolve(personalRoot),".p2p"));
  });
}

export function createInvitation(identity: PeerIdentity, address: string, options: { refresh?: boolean; ttlMs?: number; pairingId?: string } = {}): PeerInvitation {
  validatePeerCertificate(identity.certificatePem, identity.peerId);
  const match = /^([^:]+):([0-9]{1,5})$/.exec(address);
  const host = match?.[1] ?? "", port = Number(match?.[2]);
  const octets = host.split(".").map(Number);
  const privateAddress = octets[0] === 10 || octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31 || octets[0] === 192 && octets[1] === 168 || octets[0] === 127;
  if (!match || !isIPv4(host) || !privateAddress || port < 1 || port > 65535) invalid("Invitation address must be a numeric private IPv4 address and port");
  const ttlMs = options.ttlMs ?? 300_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 300_000) invalid("Invitation expiry must be between 1ms and five minutes");
  const pairingId = options.pairingId ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(pairingId)) invalid("Invalid invitation pairing ID");
  const expiry = Math.min(Date.now() + ttlMs, Date.parse(identity.expiresAt));
  return { version: 1, address, certificatePem: identity.certificatePem, peerId: identity.peerId, token: randomBytes(32).toString("base64url"), pairingId, expiresAt: new Date(expiry).toISOString(), refresh: options.refresh ?? false };
}
