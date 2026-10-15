import {
  base64UrlToBytes,
  bytesToBase64Url,
  getRandomBytes,
  utf8ToBytes
} from './utils.ts';
import {
  argon2idKdf,
  DEFAULT_ARGON2ID_PARAMS,
  xchacha20poly1305Decrypt,
  xchacha20poly1305Encrypt
} from './primitives.ts';
import type { Argon2idParams } from './primitives.ts';

// Crockford Base32 alphabet (no I, L, O, U)
const CROCKFORD_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Normalizes a recovery code by trimming, uppercasing, and removing dashes/whitespace.
 * Also maps common substitution mistakes (O->0, I->1, L->1).
 */
export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[O]/g, '0')
    .replace(/[IL]/g, '1');
}

/**
 * Generates a 160-bit (20-byte) random recovery code formatted as 8 groups of 4 characters:
 * e.g. "7QK2-M9XA-44PD-B82R-XN91-T4CY-38EJ-W5KP"
 */
export function generateRecoveryCode(): string {
  const bytes = getRandomBytes(20); // 160 bits
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += bytes[i].toString(2).padStart(8, '0');
  }

  // 160 bits / 5 bits per Crockford char = 32 chars
  let chars = '';
  for (let i = 0; i < 32; i++) {
    const chunk = binary.substring(i * 5, (i + 1) * 5);
    const index = parseInt(chunk, 2);
    chars += CROCKFORD_CHARS[index];
  }

  const groups: string[] = [];
  for (let i = 0; i < 32; i += 4) {
    groups.push(chars.substring(i, i + 4));
  }
  return groups.join('-');
}

/**
 * Wraps a team key using a key derived from the recovery code via Argon2id.
 */
export function wrapTeamKeyWithRecoveryCode(
  teamKey: Uint8Array,
  recoveryCode: string,
  salt: Uint8Array,
  params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS
): string {
  if (teamKey.length !== 32) throw new Error('Team key must be 32 bytes');

  const normalized = normalizeRecoveryCode(recoveryCode);
  if (normalized.length !== 32) {
    throw new Error('Invalid recovery code length');
  }

  const recoveryDerivedKey = argon2idKdf(normalized, salt, params, 32);
  const nonce = getRandomBytes(24);
  const aad = utf8ToBytes('team_key_versions.recovery_wrap');
  const ctWithTag = xchacha20poly1305Encrypt(recoveryDerivedKey, nonce, teamKey, aad);

  return `v1.${bytesToBase64Url(nonce)}.${bytesToBase64Url(ctWithTag)}`;
}

/**
 * Unwraps the team key using the recovery code.
 */
export function unwrapTeamKeyWithRecoveryCode(
  wrapped: string,
  recoveryCode: string,
  salt: Uint8Array,
  params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS
): Uint8Array {
  const parts = wrapped.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('Invalid recovery wrap format');
  }

  const normalized = normalizeRecoveryCode(recoveryCode);
  const recoveryDerivedKey = argon2idKdf(normalized, salt, params, 32);
  const nonce = base64UrlToBytes(parts[1]);
  const ctWithTag = base64UrlToBytes(parts[2]);
  const aad = utf8ToBytes('team_key_versions.recovery_wrap');

  return xchacha20poly1305Decrypt(recoveryDerivedKey, nonce, ctWithTag, aad);
}

/**
 * Tests a recovery code against the wrapped team key without changing state.
 * Returns true if the recovery code successfully decrypts the team key.
 */
export function verifyRecoveryCode(
  wrapped: string,
  recoveryCode: string,
  salt: Uint8Array,
  params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS
): boolean {
  try {
    const teamKey = unwrapTeamKeyWithRecoveryCode(wrapped, recoveryCode, salt, params);
    return teamKey.length === 32;
  } catch {
    return false;
  }
}
