import {
  base64UrlToBytes,
  bytesToBase64Url,
  concatBytes,
  getRandomBytes,
  utf8ToBytes
} from './utils.ts';
import {
  hkdfSha256,
  x25519GenerateKeyPair,
  x25519ScalarMult,
  xchacha20poly1305Decrypt,
  xchacha20poly1305Encrypt
} from './primitives.ts';

export interface UserKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function generateUserKeyPair(): UserKeyPair {
  return x25519GenerateKeyPair();
}

/**
 * Seals the 256-bit team key to a recipient's X25519 public key.
 * Uses ephemeral X25519 + HKDF-SHA256 + XChaCha20-Poly1305.
 * Format: "box.v1.<ephemeral_pub_b64url>.<nonce_b64url>.<ciphertext_tag_b64url>"
 */
export function sealTeamKey(teamKey: Uint8Array, recipientPublicKey: Uint8Array): string {
  if (teamKey.length !== 32) {
    throw new Error('Team key must be 32 bytes');
  }
  if (recipientPublicKey.length !== 32) {
    throw new Error('Recipient public key must be 32 bytes');
  }

  // 1. Ephemeral key pair
  const ephemeral = x25519GenerateKeyPair();

  // 2. Diffie-Hellman shared secret
  const sharedSecret = x25519ScalarMult(ephemeral.privateKey, recipientPublicKey);

  // 3. Derive 256-bit wrapping key via HKDF-SHA256
  const salt = concatBytes(ephemeral.publicKey, recipientPublicKey);
  const info = utf8ToBytes('sms:sealed-box:v1');
  const wrappingKey = hkdfSha256(sharedSecret, salt, info, 32);

  // 4. Encrypt team key with XChaCha20-Poly1305
  const nonce = getRandomBytes(24);
  const aad = utf8ToBytes('sms:sealed-team-key');
  const ciphertextWithTag = xchacha20poly1305Encrypt(wrappingKey, nonce, teamKey, aad);

  return `box.v1.${bytesToBase64Url(ephemeral.publicKey)}.${bytesToBase64Url(nonce)}.${bytesToBase64Url(ciphertextWithTag)}`;
}

/**
 * Opens a sealed team key using the recipient's X25519 private key.
 */
export function openSealedTeamKey(sealedBlob: string, recipientPrivateKey: Uint8Array): Uint8Array {
  if (recipientPrivateKey.length !== 32) {
    throw new Error('Recipient private key must be 32 bytes');
  }

  const parts = sealedBlob.split('.');
  if (parts.length !== 5 || parts[0] !== 'box' || parts[1] !== 'v1') {
    throw new Error('Invalid sealed blob format');
  }

  const ephemeralPublicKey = base64UrlToBytes(parts[2]);
  const nonce = base64UrlToBytes(parts[3]);
  const ciphertextWithTag = base64UrlToBytes(parts[4]);

  if (ephemeralPublicKey.length !== 32) {
    throw new Error('Invalid ephemeral public key length in sealed blob');
  }
  if (nonce.length !== 24) {
    throw new Error('Invalid nonce length in sealed blob');
  }

  // Diffie-Hellman shared secret
  const sharedSecret = x25519ScalarMult(recipientPrivateKey, ephemeralPublicKey);

  // Derive recipient's public key to reconstruct the exact salt
  const myPublicKey = x25519ScalarMult(recipientPrivateKey, new Uint8Array([9, ...new Array(31).fill(0)]));
  const salt = concatBytes(ephemeralPublicKey, myPublicKey);
  const info = utf8ToBytes('sms:sealed-box:v1');
  const wrappingKey = hkdfSha256(sharedSecret, salt, info, 32);

  const aad = utf8ToBytes('sms:sealed-team-key');
  return xchacha20poly1305Decrypt(wrappingKey, nonce, ciphertextWithTag, aad);
}

/**
 * Encrypts a user's private key for persistence under their passphrase key.
 */
export function wrapPrivateKey(privateKey: Uint8Array, passphraseKey: Uint8Array): string {
  if (privateKey.length !== 32) throw new Error('Private key must be 32 bytes');
  if (passphraseKey.length !== 32) throw new Error('Passphrase key must be 32 bytes');

  const nonce = getRandomBytes(24);
  const aad = utf8ToBytes('user_keys.enc_private_key');
  const ctWithTag = xchacha20poly1305Encrypt(passphraseKey, nonce, privateKey, aad);

  return `v1.${bytesToBase64Url(nonce)}.${bytesToBase64Url(ctWithTag)}`;
}

/**
 * Decrypts a user's private key using their passphrase key.
 */
export function unwrapPrivateKey(wrapped: string, passphraseKey: Uint8Array): Uint8Array {
  const parts = wrapped.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('Invalid wrapped private key format');
  }

  const nonce = base64UrlToBytes(parts[1]);
  const ctWithTag = base64UrlToBytes(parts[2]);
  const aad = utf8ToBytes('user_keys.enc_private_key');

  return xchacha20poly1305Decrypt(passphraseKey, nonce, ctWithTag, aad);
}
