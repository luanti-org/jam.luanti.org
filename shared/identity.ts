import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import { type Identity, publicKeyFromSecret } from "./signatures";

const encoder = new TextEncoder();

// Protocol constant: changing this changes every key restored from an existing phrase.
const identityDerivationSaltV1 = encoder.encode("luanti-game-jam/identity/v1");

export async function createIdentity() {
    const phrase = generateMnemonic(wordlist, 128);

    return { phrase, identity: await restoreIdentity(phrase) };
}

export async function restoreIdentity(input: string): Promise<Identity> {
    const phrase = input.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ");

    if (phrase.split(" ").length !== 12 || !validateMnemonic(phrase, wordlist)) {
        throw new Error("Enter a valid 12-word English recovery phrase");
    }

    const seed = await mnemonicToSeed(phrase, "");

    try {
        const secretKey = hkdf(sha256, seed, identityDerivationSaltV1, encoder.encode("ed25519"), 32);

        return {
            secretKey,
            publicKey: publicKeyFromSecret(secretKey),
        };
    } finally {
        seed.fill(0);
    }
}
