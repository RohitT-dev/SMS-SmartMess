import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToUtf8,
  getRandomBytes,
  utf8ToBytes
} from './utils.ts';
import { xchacha20poly1305Decrypt, xchacha20poly1305Encrypt } from './primitives.ts';

export interface EncryptEnvelopeParams {
  plaintext: string | Uint8Array;
  subkey: Uint8Array;
  keyVersion: number;
  aad: string; // "<table>.<column>.<row_uuid>"
  nonce?: Uint8Array;
}

export interface DecryptEnvelopeParams {
  envelope: string;
  subkey: Uint8Array;
  aad: string; // Must match AAD bound during encryption
  allowedKeyVersions?: number[];
}

export interface ParsedEnvelope {
  format: 'v1';
  keyVersion: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export function parseEnvelope(envelope: string): ParsedEnvelope {
  const parts = envelope.split('.');
  if (parts.length !== 4) {
    throw new Error('Invalid envelope format: expected 4 dot-separated parts');
  }

  const [version, keyVersionStr, nonceB64, ctB64] = parts;
  if (version !== 'v1') {
    throw new Error(`Unsupported envelope version: ${version}`);
  }

  const keyVersion = parseInt(keyVersionStr, 10);
  if (isNaN(keyVersion) || keyVersion < 1) {
    throw new Error(`Invalid envelope keyVersion: ${keyVersionStr}`);
  }

  const nonce = base64UrlToBytes(nonceB64);
  if (nonce.length !== 24) {
    throw new Error(`Invalid envelope nonce length: expected 24 bytes, got ${nonce.length}`);
  }

  const ciphertext = base64UrlToBytes(ctB64);
  return {
    format: 'v1',
    keyVersion,
    nonce,
    ciphertext
  };
}

export function encryptEnvelope({
  plaintext,
  subkey,
  keyVersion,
  aad,
  nonce
}: EncryptEnvelopeParams): string {
  if (subkey.length !== 32) {
    throw new Error('Subkey must be 32 bytes');
  }
  if (!aad || typeof aad !== 'string') {
    throw new Error('AAD is required and must be a string formatted as <table>.<column>.<row_uuid>');
  }

  const nonceBytes = nonce ?? getRandomBytes(24);
  const ptBytes = typeof plaintext === 'string' ? utf8ToBytes(plaintext) : plaintext;
  const aadBytes = utf8ToBytes(aad);

  const ctWithTag = xchacha20poly1305Encrypt(subkey, nonceBytes, ptBytes, aadBytes);

  return `v1.${keyVersion}.${bytesToBase64Url(nonceBytes)}.${bytesToBase64Url(ctWithTag)}`;
}

export function decryptEnvelope({
  envelope,
  subkey,
  aad,
  allowedKeyVersions
}: DecryptEnvelopeParams): string {
  const parsed = parseEnvelope(envelope);

  if (allowedKeyVersions && !allowedKeyVersions.includes(parsed.keyVersion)) {
    throw new Error(`Key version mismatch: envelope has v${parsed.keyVersion}, allowed: ${allowedKeyVersions.join(',')}`);
  }

  const aadBytes = utf8ToBytes(aad);
  const decryptedBytes = xchacha20poly1305Decrypt(subkey, parsed.nonce, parsed.ciphertext, aadBytes);
  return bytesToUtf8(decryptedBytes);
}

export function decryptEnvelopeBytes({
  envelope,
  subkey,
  aad,
  allowedKeyVersions
}: DecryptEnvelopeParams): Uint8Array {
  const parsed = parseEnvelope(envelope);

  if (allowedKeyVersions && !allowedKeyVersions.includes(parsed.keyVersion)) {
    throw new Error(`Key version mismatch: envelope has v${parsed.keyVersion}`);
  }

  const aadBytes = utf8ToBytes(aad);
  return xchacha20poly1305Decrypt(subkey, parsed.nonce, parsed.ciphertext, aadBytes);
}
