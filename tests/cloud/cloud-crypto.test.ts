import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  decryptPayload,
  deriveCloudKey,
  encryptPayload,
} from "../../src/cloud/cloud-crypto.js";

describe("cloud/cloud-crypto", () => {
  it("encrypts and decrypts payloads with the derived key", async () => {
    const salt = randomBytes(16);
    const key = await deriveCloudKey("secret passphrase", salt);
    const encrypted = encryptPayload(Buffer.from("personal knowledge"), key);

    expect(encrypted.ciphertext.toString("utf8")).not.toBe("personal knowledge");
    expect(decryptPayload(encrypted, key).toString("utf8")).toBe("personal knowledge");
  });

  it("rejects decryption with the wrong key", async () => {
    const encrypted = encryptPayload(
      Buffer.from("personal knowledge"),
      await deriveCloudKey("secret passphrase", randomBytes(16)),
    );

    expect(() =>
      decryptPayload(
        encrypted,
        Buffer.alloc(32, 1),
      ),
    ).toThrow();
  });
});
