import { bytesToHex, utf8ToBytes } from './utils.ts';
import { hmacSha256 } from './primitives.ts';

/**
 * Normalizes an ID number for blind index calculation.
 * Strips whitespace, dashes, and converts to uppercase.
 */
export function normalizeIdNumber(id: string): string {
  return id.trim().toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Computes a deterministic blind index for exact-match searching on encrypted ID numbers.
 * Formula: HMAC-SHA256(blindKey, normalize(idNumber))
 *
 * NOTE / SECURITY CONSIDERATION:
 * The blind index allows exact-match search without leaking the plaintext ID,
 * but it leaks equality (frequency analysis is theoretically possible on identical IDs).
 */
export function computeBlindIndex(blindKey: Uint8Array, idNumber: string): string {
  if (blindKey.length !== 32) {
    throw new Error('Blind index key must be 32 bytes');
  }
  const normalized = normalizeIdNumber(idNumber);
  const mac = hmacSha256(blindKey, utf8ToBytes(normalized));
  return bytesToHex(mac);
}
