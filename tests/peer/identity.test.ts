import { X509Certificate, createHash, createPublicKey, webcrypto } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPersonalKnowledgeAsset } from "../../src/personal/personal-asset-paths.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), "gmem-peer-identity-")); roots.push(value); return value; }
async function api() { return import("../../src/peer/identity.js"); }

describe("peer identity", () => {
  it("persists a stable P-256 identity with a matching SAN, private paths and no exported secrets", async () => {
    const { ensureIdentity, loadIdentity, validatePeerCertificate } = await api();
    const personal = await root();
    const identity = await ensureIdentity(personal);
    const loaded = await loadIdentity(personal);
    expect(loaded?.peerId).toBe(identity.peerId);
    expect(loaded?.privateKeyPem === identity.privateKeyPem).toBe(true);
    expect((await ensureIdentity(personal)).peerId).toBe(identity.peerId);
    expect(identity.peerId).toMatch(/^[a-z2-7]{52}$/);
    const cert = new X509Certificate(identity.certificatePem);
    expect(cert.subjectAltName).toBe(`DNS:gmem-${identity.peerId}.invalid`);
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.ca).toBe(false);
    expect(cert.keyUsage).toEqual(expect.arrayContaining(["1.3.6.1.5.5.7.3.1", "1.3.6.1.5.5.7.3.2"]));
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    const digest = createHash("sha256").update(createPublicKey(identity.privateKeyPem).export({ type: "spki", format: "der" })).digest();
    const bits = [...digest].map(byte => byte.toString(2).padStart(8, "0")).join("").padEnd(260, "0");
    expect(identity.peerId).toBe(Array.from({ length: 52 }, (_, i) => alphabet[Number.parseInt(bits.slice(i * 5, i * 5 + 5), 2)]).join(""));
    expect(validatePeerCertificate(identity.certificatePem, identity.peerId).peerId).toBe(identity.peerId);
    expect((await stat(join(personal, ".p2p"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(personal, ".p2p/identity.json"))).mode & 0o777).toBe(0o600);
    expect(isPersonalKnowledgeAsset(".p2p/identity.json")).toBe(false);
    expect(isPersonalKnowledgeAsset(".p2p/trust.json")).toBe(false);
  });

  it("rejects self trust, a second peer and a changed-key refresh", async () => {
    const { ensureIdentity, trustPeer, getTrustedPeer } = await api();
    const personal = await root();
    const own = await ensureIdentity(personal);
    const first = await ensureIdentity(await root());
    const other = await ensureIdentity(await root());
    await expect(trustPeer(personal, own.certificatePem)).rejects.toThrow(/self/i);
    const trusted = await trustPeer(personal, first.certificatePem);
    expect(await getTrustedPeer(personal, first.peerId)).toEqual(trusted);
    await expect(trustPeer(personal, other.certificatePem)).rejects.toThrow(/peer/i);
    await expect(trustPeer(personal, other.certificatePem, { refresh: true })).rejects.toThrow(/refresh|key|peer/i);
    expect(await getTrustedPeer(personal)).toEqual(trusted);
    expect((await stat(join(personal, ".p2p/trust.json"))).mode & 0o777).toBe(0o600);
  });

  it("explicitly renews the same key and refreshes expired trust without clearing pending sessions", async () => {
    const { ensureIdentity, renewIdentity, trustPeer, getTrustedPeer, validatePeerCertificate } = await api();
    const personal = await root();
    await ensureIdentity(personal);
    const remoteRoot = await root();
    const old = await ensureIdentity(remoteRoot);
    await trustPeer(personal, old.certificatePem);
    const peerDirectory = join(personal, ".p2p/peers", old.peerId);
    await mkdir(peerDirectory, { recursive: true, mode: 0o700 });
    const pending = join(peerDirectory, "pending.json");
    await writeFile(pending, '{"sessionId":"unfinished","generation":4}', { mode: 0o600 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 367 * 86400_000));
    expect(() => validatePeerCertificate(old.certificatePem)).toThrow(/expir|valid/i);
    expect((await getTrustedPeer(personal))?.peerId).toBe(old.peerId);
    const renewed = await renewIdentity(remoteRoot);
    expect(renewed.peerId).toBe(old.peerId);
    expect(renewed.privateKeyPem === old.privateKeyPem).toBe(true);
    expect(renewed.certificatePem).not.toBe(old.certificatePem);
    await expect(trustPeer(personal, renewed.certificatePem)).rejects.toThrow(/refresh/i);
    await trustPeer(personal, renewed.certificatePem, { refresh: true });
    expect((await getTrustedPeer(personal))?.certificatePem).toBe(renewed.certificatePem);
    expect(await readFile(pending, "utf8")).toBe('{"sessionId":"unfinished","generation":4}');
  });

  it("refuses identity recreation with retained peer state and forgetting with pending sessions", async () => {
    const { ensureIdentity, trustPeer, forgetPeer, loadIdentity } = await api();
    const personal = await root();
    await ensureIdentity(personal);
    const other = await ensureIdentity(await root());
    await trustPeer(personal, other.certificatePem);
    const peerDirectory = join(personal, ".p2p/peers", other.peerId);
    await mkdir(peerDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(peerDirectory, "pending.json"), '{"sessionId":"unfinished"}', { mode: 0o600 });
    await expect(forgetPeer(personal, other.peerId)).rejects.toThrow(/pending|unfinished/i);
    await rm(join(peerDirectory, "pending.json"));
    await forgetPeer(personal, other.peerId);
    await rm(join(personal, ".p2p/identity.json"));
    await mkdir(peerDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(peerDirectory, "state.json"), "{}", { mode: 0o600 });
    await expect(ensureIdentity(personal)).rejects.toThrow(/identity/i);
    expect(await loadIdentity(personal)).toBeUndefined();
  });

  it.each(["revoke-write", "trust-delete", "history-delete", "history-deleted", "marker-delete"] as const)("recovers interrupted forgetting at %s without trusted-but-erased history", async (boundary) => {
    const { ensureIdentity, trustPeer, forgetPeer, getTrustedPeer } = await api();
    const personal = await root();
    await ensureIdentity(personal);
    const other = await ensureIdentity(await root());
    await trustPeer(personal, other.certificatePem);
    const pairDirectory = join(personal, ".p2p/peers", other.peerId);
    const baseline = join(pairDirectory, "state.json");
    const marker = join(personal, ".p2p/forgetting.json");
    const trust = join(personal, ".p2p/trust.json");
    await mkdir(pairDirectory, { recursive: true, mode: 0o700 });
    await writeFile(baseline, '{"generation":9,"baseline":"retained"}', { mode: 0o600 });
    const originalRename = filesystem.rename;
    const originalRm = filesystem.rm;
    let injected = false;
    const fail = () => { injected = true; throw Object.assign(new Error(`injected ${boundary}`), { code: "EIO" }); };
    filesystem.rename = async (from, to) => {
      if (boundary === "revoke-write" && to === marker) fail();
      return originalRename(from, to);
    };
    filesystem.rm = async (path, options) => {
      if (boundary === "trust-delete" && path === trust || boundary === "history-delete" && path === pairDirectory || boundary === "marker-delete" && path === marker) fail();
      await originalRm(path, options);
      if (boundary === "history-deleted" && path === pairDirectory) fail();
    };
    syncBuiltinESMExports();
    try {
      await expect(forgetPeer(personal, other.peerId)).rejects.toThrow(/injected/);
    } finally {
      filesystem.rename = originalRename;
      filesystem.rm = originalRm;
      syncBuiltinESMExports();
    }
    expect(injected).toBe(true);
    const trusted = await getTrustedPeer(personal);
    const baselineExists = await stat(baseline).then(() => true, () => false);
    expect(Boolean(trusted) && !baselineExists).toBe(false);
    if (boundary === "revoke-write") {
      expect(trusted?.peerId).toBe(other.peerId);
      expect(baselineExists).toBe(true);
    } else {
      expect(trusted).toBeUndefined();
      expect((await stat(marker)).mode & 0o777).toBe(0o600);
      await expect(trustPeer(personal, other.certificatePem).then(() => undefined)).rejects.toThrow(/forget|revok|cleanup/i);
      if (boundary === "trust-delete" || boundary === "history-delete") expect(baselineExists).toBe(true);
    }
    await forgetPeer(personal, other.peerId);
    await forgetPeer(personal, other.peerId);
    expect(await getTrustedPeer(personal)).toBeUndefined();
    await expect(stat(pairDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    // Cleanup has a terminal state that allows an explicit fresh pair.
    expect((await trustPeer(personal, other.certificatePem)).peerId).toBe(other.peerId);
  });

  it("rejects mismatched pins, malformed certificates, unsafe state paths and permissive key files", async () => {
    const { ensureIdentity, loadIdentity, validatePeerCertificate } = await api();
    const identity = await ensureIdentity(await root());
    expect(() => validatePeerCertificate(identity.certificatePem, "a".repeat(52))).toThrow();
    expect(() => validatePeerCertificate("not a certificate")).toThrow();
    const outside = await root();
    const personal = await root();
    await symlink(outside, join(personal, ".p2p"));
    await expect(ensureIdentity(personal)).rejects.toThrow(/symlink|path/i);
    const insecure = await root();
    await ensureIdentity(insecure);
    await chmod(join(insecure, ".p2p/identity.json"), 0o644);
    await expect(loadIdentity(insecure).then(() => undefined)).rejects.toThrow(/permission|private/i);
  });

  it("rejects certificate algorithm, SAN, usages, CA and validity profile violations", async () => {
    const { validatePeerCertificate } = await api();
    const x509 = await import("@peculiar/x509");
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const bytes = createHash("sha256").update(Buffer.from(await webcrypto.subtle.exportKey("spki", keys.publicKey))).digest();
    const bits = [...bytes].map(byte => byte.toString(2).padStart(8, "0")).join("").padEnd(260, "0");
    const peerId = Array.from({ length: 52 }, (_, i) => "abcdefghijklmnopqrstuvwxyz234567"[Number.parseInt(bits.slice(i * 5, i * 5 + 5), 2)]).join("");
    for (const variant of ["sha384", "san", "ca", "usage", "future", "too-long"] as const) {
      const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: "CN=test-profile",
        keys: keys as unknown as CryptoKeyPair,
        signingAlgorithm: { name: "ECDSA", hash: variant === "sha384" ? "SHA-384" : "SHA-256" },
        notBefore: new Date(Date.now() + (variant === "future" ? 86400_000 : -60_000)),
        notAfter: new Date(Date.now() + (variant === "too-long" ? 400 : 365) * 86400_000),
        extensions: [
          new x509.BasicConstraintsExtension(variant === "ca", undefined, true),
          new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
          new x509.ExtendedKeyUsageExtension(variant === "usage" ? [x509.ExtendedKeyUsage.serverAuth] : [x509.ExtendedKeyUsage.serverAuth, x509.ExtendedKeyUsage.clientAuth]),
          new x509.SubjectAlternativeNameExtension([{ type: "dns", value: variant === "san" ? "attacker.invalid" : `gmem-${peerId}.invalid` }]),
        ],
      }, webcrypto as unknown as Crypto);
      expect(() => validatePeerCertificate(cert.toString("pem"))).toThrow();
    }
  });

  it("rejects symlinked and hard-linked secret files", async () => {
    const { ensureIdentity, loadIdentity } = await api();
    const first = await root();
    const second = await root();
    await ensureIdentity(first);
    await mkdir(join(second, ".p2p"), { mode: 0o700 });
    await symlink(join(first, ".p2p/identity.json"), join(second, ".p2p/identity.json"));
    await expect(loadIdentity(second).then(() => undefined)).rejects.toThrow(/symbolic|path/i);
    await rm(join(second, ".p2p/identity.json"));
    await link(join(first, ".p2p/identity.json"), join(second, ".p2p/identity.json"));
    await expect(loadIdentity(second).then(() => undefined)).rejects.toThrow(/private|link/i);
  });

  it("rejects fresh pairing when orphan pending work exists", async () => {
    const { ensureIdentity, trustPeer, getTrustedPeer } = await api();
    const personal = await root();
    await ensureIdentity(personal);
    const other = await ensureIdentity(await root());
    const pendingRoot = join(personal, ".p2p/peers", other.peerId);
    await mkdir(pendingRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(pendingRoot, "pending.json"), '{"sessionId":"preserve-me"}', { mode: 0o600 });
    await expect(trustPeer(personal, other.certificatePem)).rejects.toThrow(/pending|unfinished/i);
    expect(await getTrustedPeer(personal)).toBeUndefined();
    expect(await readFile(join(pendingRoot, "pending.json"), "utf8")).toBe('{"sessionId":"preserve-me"}');
  });

  it("rejects executable secret files rather than accepting owner-only nonstandard modes", async () => {
    const { ensureIdentity, loadIdentity } = await api();
    const personal = await root();
    await ensureIdentity(personal);
    await chmod(join(personal, ".p2p/identity.json"), 0o700);
    await expect(loadIdentity(personal).then(() => undefined)).rejects.toThrow(/permission|private/i);
  });

  it("creates bounded single-use invitations without persisting tokens in knowledge", async () => {
    const { ensureIdentity, createInvitation } = await api();
    const identity = await ensureIdentity(await root());
    const before = Date.now();
    const invitation = createInvitation(identity, "192.168.1.10:43123");
    expect(invitation.version).toBe(1);
    expect(invitation.peerId).toBe(identity.peerId);
    expect(invitation.certificatePem).toBe(identity.certificatePem);
    expect(Buffer.from(invitation.token, "base64url")).toHaveLength(32);
    expect(invitation.pairingId).not.toBe(createInvitation(identity, "192.168.1.10:43123").pairingId);
    expect(Date.parse(invitation.expiresAt) - before).toBeGreaterThanOrEqual(299000);
    expect(Date.parse(invitation.expiresAt) - before).toBeLessThanOrEqual(301000);
    expect(invitation.refresh).toBe(false);
    expect(() => createInvitation(identity, "0.0.0.0:1")).toThrow();
    expect(() => createInvitation(identity, "8.8.8.8:443")).toThrow();
  });
});
