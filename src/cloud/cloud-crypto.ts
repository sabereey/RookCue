import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";

import type { EncryptedPayload } from "./cloud-types.js";

const scryptAsync = promisify(scrypt);

export async function deriveCloudKey(
  passphrase: string,
  salt: Buffer,
): Promise<Buffer> {
  const key = await scryptAsync(passphrase, salt, 32);
  return Buffer.from(key as Buffer);
}

export function encryptPayload(content: Buffer, key: Buffer): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptPayload(payload: EncryptedPayload, key: Buffer): Buffer {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(payload.ciphertext),
    decipher.final(),
  ]);
}
