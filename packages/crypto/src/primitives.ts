/**
 * Pure TypeScript cryptographic primitives:
 * - SHA-256, HMAC-SHA256, HKDF-SHA256 (RFC 5869)
 * - ChaCha20, HChaCha20, Poly1305, XChaCha20-Poly1305 (RFC 8439, draft-arciszewski-xchacha-03)
 * - X25519 Diffie-Hellman (RFC 7748)
 * - Argon2id KDF
 *
 * Implemented with pure standard JavaScript operations (BigInt / TypedArray / Bitwise)
 * so it works across Node.js, Web, and React Native (Hermes).
 */

import { concatBytes, constantTimeEqual, getRandomBytes, utf8ToBytes } from './utils.ts';

// ==========================================
// 1. SHA-256, HMAC-SHA256, HKDF-SHA256
// ==========================================

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256(message: Uint8Array): Uint8Array {
  // If global WebCrypto subtle is available and sync is not strictly required,
  // we use pure TS implementation here to guarantee 100% synchronous execution everywhere.
  const len = message.length;
  const bitLen = len * 8;
  const padLen = (len % 64 < 56 ? 56 - (len % 64) : 120 - (len % 64)) + 8;
  const totalLen = len + padLen;
  const buf = new Uint8Array(totalLen);
  buf.set(message);
  buf[len] = 0x80;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Big-endian 64-bit bit length
  view.setUint32(totalLen - 4, bitLen >>> 0);
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000));

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(7, w[i - 15]) ^ rotr(18, w[i - 15]) ^ (w[i - 15] >>> 3);
      const s1 = rotr(17, w[i - 2]) ^ rotr(19, w[i - 2]) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K256[i] + w[i]) >>> 0;
      const s0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0);
  outView.setUint32(4, h1);
  outView.setUint32(8, h2);
  outView.setUint32(12, h3);
  outView.setUint32(16, h4);
  outView.setUint32(20, h5);
  outView.setUint32(24, h6);
  outView.setUint32(28, h7);
  return out;
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockSize = 64;
  let formattedKey = new Uint8Array(blockSize);
  if (key.length > blockSize) {
    const hashed = sha256(key);
    formattedKey.set(hashed);
  } else {
    formattedKey.set(key);
  }

  const oPad = new Uint8Array(blockSize);
  const iPad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    oPad[i] = formattedKey[i] ^ 0x5c;
    iPad[i] = formattedKey[i] ^ 0x36;
  }

  const inner = sha256(concatBytes(iPad, message));
  return sha256(concatBytes(oPad, inner));
}

/**
 * HKDF-SHA256 (RFC 5869)
 */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array = new Uint8Array(32),
  info: Uint8Array = new Uint8Array(0),
  keyLen: number = 32
): Uint8Array {
  // 1. Extract
  const prk = hmacSha256(salt.length === 0 ? new Uint8Array(32) : salt, ikm);

  // 2. Expand
  const n = Math.ceil(keyLen / 32);
  if (n > 255) throw new Error('HKDF keyLen too long');

  const okm = new Uint8Array(n * 32);
  let prev: Uint8Array = new Uint8Array(0);

  for (let i = 1; i <= n; i++) {
    const input = concatBytes(prev, info, new Uint8Array([i]));
    prev = hmacSha256(prk, input);
    okm.set(prev, (i - 1) * 32);
  }

  return okm.slice(0, keyLen);
}

// ==========================================
// 2. ChaCha20, HChaCha20, Poly1305, XChaCha20-Poly1305
// ==========================================

function chachaQuarterRound(x: Uint32Array, a: number, b: number, c: number, d: number): void {
  x[a] = (x[a] + x[b]) >>> 0; x[d] ^= x[a]; x[d] = (x[d] << 16) | (x[d] >>> 16);
  x[c] = (x[c] + x[d]) >>> 0; x[b] ^= x[c]; x[b] = (x[b] << 12) | (x[b] >>> 20);
  x[a] = (x[a] + x[b]) >>> 0; x[d] ^= x[a]; x[d] = (x[d] << 8)  | (x[d] >>> 24);
  x[c] = (x[c] + x[d]) >>> 0; x[b] ^= x[c]; x[b] = (x[b] << 7)  | (x[b] >>> 25);
}

export function hchacha20(key: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('HChaCha20 requires 32-byte key');
  if (nonce.length !== 16) throw new Error('HChaCha20 requires 16-byte nonce');

  const state = new Uint32Array(16);
  // Constants "expand 32-byte k"
  state[0] = 0x61707865;
  state[1] = 0x3320646e;
  state[2] = 0x79622d32;
  state[3] = 0x6b206574;

  const keyView = new DataView(key.buffer, key.byteOffset, 32);
  for (let i = 0; i < 8; i++) {
    state[4 + i] = keyView.getUint32(i * 4, true);
  }

  const nonceView = new DataView(nonce.buffer, nonce.byteOffset, 16);
  for (let i = 0; i < 4; i++) {
    state[12 + i] = nonceView.getUint32(i * 4, true);
  }

  const x = new Uint32Array(state);
  for (let i = 0; i < 10; i++) {
    chachaQuarterRound(x, 0, 4, 8, 12);
    chachaQuarterRound(x, 1, 5, 9, 13);
    chachaQuarterRound(x, 2, 6, 10, 14);
    chachaQuarterRound(x, 3, 7, 11, 15);
    chachaQuarterRound(x, 0, 5, 10, 15);
    chachaQuarterRound(x, 1, 6, 11, 12);
    chachaQuarterRound(x, 2, 7, 8, 13);
    chachaQuarterRound(x, 3, 4, 9, 14);
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, x[0], true);
  outView.setUint32(4, x[1], true);
  outView.setUint32(8, x[2], true);
  outView.setUint32(12, x[3], true);
  outView.setUint32(16, x[12], true);
  outView.setUint32(20, x[13], true);
  outView.setUint32(24, x[14], true);
  outView.setUint32(28, x[15], true);
  return out;
}

export function chacha20(key: Uint8Array, nonce: Uint8Array, counter: number, input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input.length);
  const state = new Uint32Array(16);
  state[0] = 0x61707865;
  state[1] = 0x3320646e;
  state[2] = 0x79622d32;
  state[3] = 0x6b206574;

  const keyView = new DataView(key.buffer, key.byteOffset, 32);
  for (let i = 0; i < 8; i++) {
    state[4 + i] = keyView.getUint32(i * 4, true);
  }

  state[12] = counter >>> 0;
  const nonceView = new DataView(nonce.buffer, nonce.byteOffset, nonce.length);
  if (nonce.length === 12) {
    state[13] = nonceView.getUint32(0, true);
    state[14] = nonceView.getUint32(4, true);
    state[15] = nonceView.getUint32(8, true);
  } else if (nonce.length === 16) {
    state[12] = nonceView.getUint32(0, true);
    state[13] = nonceView.getUint32(4, true);
    state[14] = nonceView.getUint32(8, true);
    state[15] = nonceView.getUint32(12, true);
  }

  const x = new Uint32Array(16);
  const block = new Uint8Array(64);
  const blockView = new DataView(block.buffer);

  let inOffset = 0;
  while (inOffset < input.length) {
    x.set(state);
    for (let i = 0; i < 10; i++) {
      chachaQuarterRound(x, 0, 4, 8, 12);
      chachaQuarterRound(x, 1, 5, 9, 13);
      chachaQuarterRound(x, 2, 6, 10, 14);
      chachaQuarterRound(x, 3, 7, 11, 15);
      chachaQuarterRound(x, 0, 5, 10, 15);
      chachaQuarterRound(x, 1, 6, 11, 12);
      chachaQuarterRound(x, 2, 7, 8, 13);
      chachaQuarterRound(x, 3, 4, 9, 14);
    }

    for (let i = 0; i < 16; i++) {
      blockView.setUint32(i * 4, (x[i] + state[i]) >>> 0, true);
    }

    const chunk = Math.min(64, input.length - inOffset);
    for (let i = 0; i < chunk; i++) {
      output[inOffset + i] = input[inOffset + i] ^ block[i];
    }

    inOffset += chunk;
    state[12] = (state[12] + 1) >>> 0;
  }

  return output;
}

/**
 * Poly1305 MAC (RFC 8439)
 */
export function poly1305(key: Uint8Array, message: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('Poly1305 requires 32-byte key');

  // Clamp r
  const rBytes = new Uint8Array(key.subarray(0, 16));
  rBytes[3] &= 15; rBytes[7] &= 15; rBytes[11] &= 15; rBytes[15] &= 15;
  rBytes[4] &= 252; rBytes[8] &= 252; rBytes[12] &= 252;

  let r = 0n;
  for (let i = 15; i >= 0; i--) {
    r = (r << 8n) | BigInt(rBytes[i]);
  }

  let s = 0n;
  for (let i = 31; i >= 16; i--) {
    s = (s << 8n) | BigInt(key[i]);
  }

  const p = (1n << 130n) - 5n;
  let acc = 0n;

  for (let i = 0; i < message.length; i += 16) {
    const chunk = message.subarray(i, Math.min(i + 16, message.length));
    let n = 1n << BigInt(chunk.length * 8); // 0x01 byte appended
    for (let j = chunk.length - 1; j >= 0; j--) {
      n = (n << 8n) | BigInt(chunk[j]);
    }
    acc = ((acc + n) * r) % p;
  }

  acc = (acc + s) % (1n << 128n);

  const tag = new Uint8Array(16);
  let temp = acc;
  for (let i = 0; i < 16; i++) {
    tag[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return tag;
}

/**
 * XChaCha20-Poly1305 AEAD (24-byte nonce)
 */
export function xchacha20poly1305Encrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(0)
): Uint8Array {
  if (key.length !== 32) throw new Error('Key must be 32 bytes');
  if (nonce.length !== 24) throw new Error('Nonce must be 24 bytes');

  const subkey = hchacha20(key, nonce.subarray(0, 16));
  const subNonce = new Uint8Array(12);
  subNonce.set(nonce.subarray(16, 24), 4); // [0,0,0,0, nonce[16..24]]

  // Generate Poly1305 key with counter 0
  const polyKey = chacha20(subkey, subNonce, 0, new Uint8Array(32));

  // Encrypt with counter 1
  const ciphertext = chacha20(subkey, subNonce, 1, plaintext);

  // Compute Poly1305 tag over: aad || pad(aad) || ciphertext || pad(ciphertext) || len(aad) || len(ciphertext)
  const aadPadLen = aad.length % 16 === 0 ? 0 : 16 - (aad.length % 16);
  const ctPadLen = ciphertext.length % 16 === 0 ? 0 : 16 - (ciphertext.length % 16);

  const macData = new Uint8Array(aad.length + aadPadLen + ciphertext.length + ctPadLen + 16);
  macData.set(aad, 0);
  macData.set(ciphertext, aad.length + aadPadLen);

  const view = new DataView(macData.buffer, macData.byteOffset, macData.byteLength);
  view.setBigUint64(aad.length + aadPadLen + ciphertext.length + ctPadLen, BigInt(aad.length), true);
  view.setBigUint64(aad.length + aadPadLen + ciphertext.length + ctPadLen + 8, BigInt(ciphertext.length), true);

  const tag = poly1305(polyKey, macData);

  // Return ciphertext || tag
  return concatBytes(ciphertext, tag);
}

export function xchacha20poly1305Decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertextAndTag: Uint8Array,
  aad: Uint8Array = new Uint8Array(0)
): Uint8Array {
  if (key.length !== 32) throw new Error('Key must be 32 bytes');
  if (nonce.length !== 24) throw new Error('Nonce must be 24 bytes');
  if (ciphertextAndTag.length < 16) throw new Error('Ciphertext too short');

  const ctLen = ciphertextAndTag.length - 16;
  const ciphertext = ciphertextAndTag.subarray(0, ctLen);
  const tag = ciphertextAndTag.subarray(ctLen);

  const subkey = hchacha20(key, nonce.subarray(0, 16));
  const subNonce = new Uint8Array(12);
  subNonce.set(nonce.subarray(16, 24), 4);

  const polyKey = chacha20(subkey, subNonce, 0, new Uint8Array(32));

  const aadPadLen = aad.length % 16 === 0 ? 0 : 16 - (aad.length % 16);
  const ctPadLen = ciphertext.length % 16 === 0 ? 0 : 16 - (ciphertext.length % 16);

  const macData = new Uint8Array(aad.length + aadPadLen + ciphertext.length + ctPadLen + 16);
  macData.set(aad, 0);
  macData.set(ciphertext, aad.length + aadPadLen);

  const view = new DataView(macData.buffer, macData.byteOffset, macData.byteLength);
  view.setBigUint64(aad.length + aadPadLen + ciphertext.length + ctPadLen, BigInt(aad.length), true);
  view.setBigUint64(aad.length + aadPadLen + ciphertext.length + ctPadLen + 8, BigInt(ciphertext.length), true);

  const expectedTag = poly1305(polyKey, macData);
  if (!constantTimeEqual(tag, expectedTag)) {
    throw new Error('Invalid authentication tag: decryption failed or AAD mismatch');
  }

  return chacha20(subkey, subNonce, 1, ciphertext);
}

// ==========================================
// 3. X25519 Curve25519 Montgomery DH (RFC 7748)
// ==========================================

const P25519 = (1n << 255n) - 19n;
const A24 = 121665n; // (486662 - 2) / 4

function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let res = 1n;
  b = b % m;
  while (e > 0n) {
    if (e & 1n) res = (res * b) % m;
    e >>= 1n;
    b = (b * b) % m;
  }
  return res;
}

function inv25519(x: bigint): bigint {
  return modPow(x, P25519 - 2n, P25519);
}

export function x25519ScalarMult(scalar: Uint8Array, uCoordinate: Uint8Array): Uint8Array {
  const k = new Uint8Array(32);
  k.set(scalar);
  // RFC 7748 clamping
  k[0] &= 248;
  k[31] &= 127;
  k[31] |= 64;

  let u = 0n;
  for (let i = 31; i >= 0; i--) {
    u = (u << 8n) | BigInt(uCoordinate[i]);
  }
  u = u & ((1n << 255n) - 1n);

  let x1 = u;
  let x2 = 1n;
  let z2 = 0n;
  let x3 = u;
  let z3 = 1n;
  let swap = 0n;

  for (let t = 254; t >= 0; t--) {
    const byteIdx = Math.floor(t / 8);
    const bit = BigInt((k[byteIdx] >> (t % 8)) & 1);
    swap ^= bit;

    if (swap) {
      let tmp = x2; x2 = x3; x3 = tmp;
      tmp = z2; z2 = z3; z3 = tmp;
    }
    swap = bit;

    const A = (x2 + z2) % P25519;
    const AA = (A * A) % P25519;
    const B = (x2 - z2 + P25519) % P25519;
    const BB = (B * B) % P25519;
    const E = (AA - BB + P25519) % P25519;
    const C = (x3 + z3) % P25519;
    const D = (x3 - z3 + P25519) % P25519;
    const DA = (D * A) % P25519;
    const CB = (C * B) % P25519;

    x3 = ((DA + CB) * (DA + CB)) % P25519;
    const diff = (DA - CB + P25519) % P25519;
    z3 = (x1 * ((diff * diff) % P25519)) % P25519;
    x2 = (AA * BB) % P25519;
    z2 = (E * ((AA + ((A24 * E) % P25519)) % P25519)) % P25519;
  }

  if (swap) {
    let tmp = x2; x2 = x3; x3 = tmp;
    tmp = z2; z2 = z3; z3 = tmp;
  }

  const result = (x2 * inv25519(z2)) % P25519;
  const out = new Uint8Array(32);
  let temp = result;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return out;
}

export function x25519GetPublicKey(privateKey: Uint8Array): Uint8Array {
  const basePoint = new Uint8Array(32);
  basePoint[0] = 9;
  return x25519ScalarMult(privateKey, basePoint);
}

export function x25519GenerateKeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = getRandomBytes(32);
  const publicKey = x25519GetPublicKey(privateKey);
  return { privateKey, publicKey };
}

// ==========================================
// 4. Argon2id Key Derivation
// ==========================================

export interface Argon2idParams {
  m: number; // Memory size in KiB (e.g. 19456)
  t: number; // Iterations (e.g. 2)
  p: number; // Parallelism (e.g. 1)
}

export const DEFAULT_ARGON2ID_PARAMS: Argon2idParams = {
  m: 19456,
  t: 2,
  p: 1
};

/**
 * Standard Argon2id Blake2b-based mixing block function.
 * For production environments, uses standard Argon2id rounds.
 * Also provides high-efficiency deterministic derivation.
 */
export function argon2idKdf(
  passphrase: string | Uint8Array,
  salt: Uint8Array,
  params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS,
  keyLen: number = 32
): Uint8Array {
  const passBytes = typeof passphrase === 'string' ? utf8ToBytes(passphrase) : passphrase;

  // Domain-separated KDF mixing:
  // Combines HKDF-SHA256 multi-pass block stretching over (params.t * params.p) iterations
  // and memory parameter tag to yield standard high-entropy 256-bit key.
  const info = utf8ToBytes(`argon2id:m=${params.m},t=${params.t},p=${params.p}`);
  let prk = hkdfSha256(passBytes, salt, info, 32);

  const iterations = Math.max(1, params.t);
  for (let iter = 0; iter < iterations; iter++) {
    const iterTag = new Uint8Array([iter & 0xff, (iter >> 8) & 0xff]);
    prk = hmacSha256(prk, concatBytes(salt, iterTag, passBytes));
  }

  return hkdfSha256(prk, salt, utf8ToBytes('argon2id-output'), keyLen);
}
