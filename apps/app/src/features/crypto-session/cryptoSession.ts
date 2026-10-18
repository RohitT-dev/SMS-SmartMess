import '../../lib/cryptoPolyfill';
import {
  argon2idKdf,
  deriveAllSubkeys,
  getSessionKey,
  setSessionKey,
  unwrapPrivateKey,
  wrapPrivateKey,
  decryptEnvelope,
  encryptEnvelope,
  getRandomBytes,
  hexToBytes,
  bytesToHex,
  computeBlindIndex,
} from '@sms/crypto';
import type { GuestPii } from '@sms/core';
import { supabase } from '../../lib/supabase';
import { useSessionStore } from '../../state/sessionStore';

const KDF_PARAMS = { m: 19456, t: 2, p: 1 };

export const ACCESS_CODE_PATTERN = /^[0-9]{6,12}$/;

const ACCESS_CODE_ERRORS: Record<string, string> = {
  ERR_INVALID_CODE: 'Incorrect access code.',
  ERR_CODE_EXPIRED: 'This access code has expired. Ask an Administrator for the new code.',
  ERR_TOO_MANY_ATTEMPTS: 'Too many wrong codes. Try again in 15 minutes.',
  ERR_NO_ACCESS_CODE: 'No access code has been set yet. Ask an Administrator.',
  ERR_ACCOUNT_INACTIVE: 'Your account is not active. Contact an Administrator.',
  ERR_MFA_REQUIRED: 'Two-factor authentication is required. Sign in again.',
};

export interface WrappedTeamKey {
  wrap: string;
  saltHex: string;
  params: typeof KDF_PARAMS;
}

function deriveCodeKey(code: string, salt: Uint8Array, params: object = KDF_PARAMS): Uint8Array {
  return argon2idKdf(code, salt, params as typeof KDF_PARAMS, 32);
}

/** Wraps a team key under an access code (Argon2id + XChaCha20-Poly1305). */
export function wrapTeamKeyForCode(teamKey: Uint8Array, code: string): WrappedTeamKey {
  const salt = getRandomBytes(16);
  return {
    wrap: wrapPrivateKey(teamKey, deriveCodeKey(code, salt)),
    saltHex: bytesToHex(salt),
    params: KDF_PARAMS,
  };
}

function assertCodeFormat(code: string) {
  if (!ACCESS_CODE_PATTERN.test(code)) {
    throw new Error('Access code must be 6 to 12 digits.');
  }
}

/**
 * Checks the access code with the server (which marks this session as signed in)
 * and loads the team key it unlocks into memory.
 */
export async function unlockWithAccessCode(code: string): Promise<void> {
  const trimmed = code.trim();
  assertCodeFormat(trimmed);

  const { data, error } = await supabase.rpc('verify_access_code', { p_code: trimmed });
  if (error) throw error;
  if (!data?.ok) {
    const base = ACCESS_CODE_ERRORS[data?.error] || 'Access code could not be verified.';
    const left = data?.error === 'ERR_INVALID_CODE' && typeof data.attempts_left === 'number';
    throw new Error(left ? `${base} ${data.attempts_left} attempt(s) left.` : base);
  }

  const teamKey = unwrapPrivateKey(
    data.team_key_wrap,
    deriveCodeKey(trimmed, hexToBytes(data.kdf_salt), data.kdf_params),
  );
  setSessionKey(teamKey, data.team_key_version);
  useSessionStore.getState().setUnlocked(true);
}

/** First run: the first Administrator creates the team key and the first access code. */
export async function initializeWithAccessCode(
  code: string,
  validUntil: string | null,
): Promise<void> {
  const trimmed = code.trim();
  assertCodeFormat(trimmed);

  const teamKey = getRandomBytes(32);
  const wrapped = wrapTeamKeyForCode(teamKey, trimmed);
  const { error } = await supabase.rpc('bootstrap_access', {
    p_code: trimmed,
    p_team_key_wrap: wrapped.wrap,
    p_kdf_salt: wrapped.saltHex,
    p_kdf_params: wrapped.params,
    p_valid_until: validUntil,
  });
  if (error) throw new Error(`Setup failed: ${error.message}`);

  setSessionKey(teamKey, 1);
  useSessionStore.getState().setUnlocked(true);
}

/** Admin: sets the access code for the next period. Other users must enter it again. */
export async function changeAccessCode(code: string, validUntil: string | null): Promise<number> {
  const trimmed = code.trim();
  assertCodeFormat(trimmed);

  const wrapped = wrapTeamKeyForCode(getActiveTeamKey(), trimmed);
  const { data, error } = await supabase.rpc('set_access_code', {
    p_code: trimmed,
    p_team_key_wrap: wrapped.wrap,
    p_kdf_salt: wrapped.saltHex,
    p_kdf_params: wrapped.params,
    p_valid_until: validUntil,
  });
  if (error) throw error;
  return data as number;
}

/**
 * Decrypts a room's name from ciphertext envelope.
 */
export function decryptRoomName(roomId: string, nameEnc: string): string {
  const session = getSessionKey();
  if (!session) return 'Locked';

  try {
    const subkeys = deriveAllSubkeys(session.teamKey);
    const aad = `rooms.name_enc.${roomId}`;
    return decryptEnvelope({
      envelope: nameEnc,
      subkey: subkeys.roomName,
      aad,
      allowedKeyVersions: [session.version],
    });
  } catch {
    return 'Decryption Error';
  }
}

/**
 * Decrypts guest PII blob.
 */
export function decryptGuestPii(guestId: string, piiEnc: string): GuestPii {
  const session = getSessionKey();
  if (!session) throw new Error('Session is locked');

  const subkeys = deriveAllSubkeys(session.teamKey);
  const aad = `guest_pii.pii_enc.${guestId}`;
  const decryptedJson = decryptEnvelope({
    envelope: piiEnc,
    subkey: subkeys.pii,
    aad,
    allowedKeyVersions: [session.version],
  });

  return JSON.parse(decryptedJson) as GuestPii;
}

/**
 * Encrypts guest PII blob for storage.
 */
export function encryptGuestPii(guestId: string, pii: GuestPii): string {
  const session = getSessionKey();
  if (!session) throw new Error('Session is locked');

  const subkeys = deriveAllSubkeys(session.teamKey);
  const aad = `guest_pii.pii_enc.${guestId}`;
  return encryptEnvelope({
    plaintext: JSON.stringify(pii),
    subkey: subkeys.pii,
    keyVersion: session.version,
    aad,
  });
}

/**
 * Encrypts a room's name for storage.
 */
export function encryptRoomName(roomId: string, name: string): string {
  const session = getSessionKey();
  if (!session) throw new Error('Session is locked');

  const subkeys = deriveAllSubkeys(session.teamKey);
  const aad = `rooms.name_enc.${roomId}`;
  return encryptEnvelope({
    plaintext: name,
    subkey: subkeys.roomName,
    keyVersion: session.version,
    aad,
  });
}

/**
 * Encrypts reasons (denials, cancellations, closures, evictions).
 */
export function encryptReason(table: string, column: string, id: string, reason: string): string {
  const session = getSessionKey();
  if (!session) throw new Error('Session is locked');

  const subkeys = deriveAllSubkeys(session.teamKey);
  const aad = `${table}.${column}.${id}`;
  return encryptEnvelope({
    plaintext: reason,
    subkey: subkeys.reason,
    keyVersion: session.version,
    aad,
  });
}

/**
 * Decrypts a reason ciphertext (closures, denials, cancellations). Returns null when locked or unreadable.
 */
export function decryptReason(
  table: string,
  column: string,
  id: string,
  envelope: string | null | undefined,
): string | null {
  const session = getSessionKey();
  if (!session || !envelope) return null;
  try {
    return decryptEnvelope({
      envelope,
      subkey: deriveAllSubkeys(session.teamKey).reason,
      aad: `${table}.${column}.${id}`,
      allowedKeyVersions: [session.version],
    });
  } catch {
    return null;
  }
}

/**
 * Computes deterministic blind index for exact ID search.
 */
export function computeIdBlindIndex(idNumber: string): string {
  const session = getSessionKey();
  if (!session) throw new Error('Session is locked');

  const subkeys = deriveAllSubkeys(session.teamKey);
  return computeBlindIndex(subkeys.blindIndex, idNumber);
}

export function getActiveTeamKey(): Uint8Array {
  const session = getSessionKey();
  if (!session) throw new Error('Session is locked');
  return session.teamKey;
}

export function getActiveKeyVersion(): number {
  const session = getSessionKey();
  return session?.version || 1;
}

export function getSubkey(label: 'pii' | 'room-name' | 'reason' | 'blind-index'): Uint8Array {
  const session = getSessionKey();
  if (!session) throw new Error('Session is locked');
  const subkeys = deriveAllSubkeys(session.teamKey);
  if (label === 'room-name') return subkeys.roomName;
  if (label === 'reason') return subkeys.reason;
  if (label === 'blind-index') return subkeys.blindIndex;
  return subkeys.pii;
}
