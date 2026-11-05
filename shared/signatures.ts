import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base64url, decodeJwt, importJWK, jwtVerify, SignJWT } from "jose";
import { type Action, actionSchema, adminClaimsSchema, publicKeySchema } from "./schemas";

export type Identity = {
    secretKey: Uint8Array;
    publicKey: string;
};

export const requestLifetimeSeconds = 5 * 60;
const algorithm = "EdDSA";

export function publicKeyFromSecret(secretKey: Uint8Array) {
    return `ed25519:${bytesToHex(ed25519.getPublicKey(secretKey))}`;
}

function publicJwk(value: unknown) {
    const publicKey = publicKeySchema.parse(value);

    return { kty: "OKP", crv: "Ed25519", x: base64url.encode(hexToBytes(publicKey.slice(8))) };
}

export async function signRequest(action: Action, audience: string, identity: Identity, now = Date.now()) {
    if (identity.publicKey !== publicKeyFromSecret(identity.secretKey)) {
        throw new Error("Signing key mismatch");
    }

    const key = await importJWK(
        { ...publicJwk(identity.publicKey), d: base64url.encode(identity.secretKey) },
        algorithm,
    );
    const issued = Math.floor(now / 1000);

    return new SignJWT({ action: actionSchema.parse(action) })
        .setProtectedHeader({ alg: algorithm, typ: "JWT" })
        .setSubject(identity.publicKey)
        .setAudience(audience)
        .setIssuedAt(issued)
        .setExpirationTime(issued + requestLifetimeSeconds)
        .sign(key);
}

/**
 * Verifies signature, audience, lifetime and signed arguments, but does not authorize the subject.
 * The untrusted decoded subject selects a key only; callers must check the current allowlist
 * after verification and must use conditional revisions when applying mutations.
 */
export async function verifyRequest(token: string, audience: string, now = Date.now()) {
    const key = await importJWK(publicJwk(decodeJwt(token).sub), algorithm);
    const { payload } = await jwtVerify(token, key, {
        algorithms: [algorithm],
        typ: "JWT",
        audience,
        currentDate: new Date(now),
        maxTokenAge: requestLifetimeSeconds,
        requiredClaims: ["sub", "aud", "iat", "exp", "action"],
    });
    const claims = adminClaimsSchema.parse(payload);

    if (claims.exp <= claims.iat || claims.exp - claims.iat > requestLifetimeSeconds) {
        throw new Error("Request exceeds the allowed five-minute lifetime");
    }

    return claims;
}
