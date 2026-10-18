/**
 * Byte, string, and randomness utilities for cryptographic operations.
 * Pure TypeScript, zero external dependencies, compatible with Hermes, Web, and Node.
 */

let customRandomBytesProvider: ((length: number) => Uint8Array) | null = null;

export function setRandomBytesProvider(provider: ((length: number) => Uint8Array) | null): void {
  customRandomBytesProvider = provider;
}

export function getRandomBytes(length: number): Uint8Array {
  if (customRandomBytesProvider) {
    return customRandomBytesProvider(length);
  }

  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
    return bytes;
  }
  if (typeof globalThis !== 'undefined' && typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }

  // Safe Node.js fallback without eval("require('crypto')") which breaks Hermes
  try {
    const nodeRequire =
      typeof require === 'function'
        ? require
        : typeof globalThis !== 'undefined' && typeof (globalThis as any).require === 'function'
          ? (globalThis as any).require
          : null;
    if (nodeRequire) {
      const nodeCrypto = nodeRequire('crypto');
      if (nodeCrypto && typeof nodeCrypto.randomBytes === 'function') {
        const buf = nodeCrypto.randomBytes(length);
        bytes.set(buf);
        return bytes;
      }
    }
  } catch {
    // Non-Node or restricted environment
  }

  // Fallback for headless/dev runtimes
  for (let i = 0; i < length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

export function utf8ToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Base64URL encoding (RFC 4648 §5, no padding)
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = typeof btoa !== 'undefined' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(base64url: string): Uint8Array {
  let b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) {
    b64 += '=';
  }
  const binary = typeof atob !== 'undefined' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const arr of arrays) {
    totalLen += arr.length;
  }
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Constant-time byte array equality comparison to prevent timing attacks.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Zeroes the memory of a Uint8Array in place.
 */
export function wipeBytes(arr: Uint8Array | null | undefined): void {
  if (!arr) return;
  arr.fill(0);
}
