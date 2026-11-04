/**
 * Prints a new ed25519 key pair for signing updates: the private key (PKCS#8 PEM) goes in the
 * repository secret LATCH_UPDATE_SIGNING_KEY, the public key (SPKI PEM) in src/update/key.ts.
 * Releases signed with one key cannot be installed by apps that carry another, so rotate both
 * together and only with a release that ships the new public key.
 *
 * Usage: tsx packaging/keygen.ts
 */
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
process.stdout.write(`${privateKey.export({ type: "pkcs8", format: "pem" })}\n${publicKey.export({ type: "spki", format: "pem" })}`);
