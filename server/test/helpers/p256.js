import crypto from "node:crypto";

/** A fresh, valid raw (uncompressed) P-256 public key as base64url. */
export function makeP256PublicKey() {
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]).toString("base64url");
}

export const b64u = (length, fill = 7) =>
  Buffer.alloc(length, fill).toString("base64url");
