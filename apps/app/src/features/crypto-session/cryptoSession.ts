import {
  deriveAllSubkeys,
  deriveUserPassphraseKey,
  generateUserKeyPair,
  getSessionKey,
  openSealedTeamKey,
  sealTeamKey,
  setSessionKey,
  unwrapPrivateKey,
  unwrapTeamKeyWithRecoveryCode,
  wrapPrivateKey,
  wrapTeamKeyWithRecoveryCode,
  decryptEnvelope,
  encryptEnvelope,
  generateRecoveryCode,
  getRandomBytes,
  hexToBytes,
  bytesToHex
} from '@sms/crypto';
import type { GuestPii } from '@sms/core';
import { supabase } from '../../lib/supabase';
import { useSessionStore } from '../../state/sessionStore';

export interface KeySetupResult {
  recoveryCode: string;
}

/**
 * Initializes the root team key on Admin's first run.
 * Creates master team key, user keypair, recovery wrap, and publishes keys.
 */
export async function initializeTeamKeySetup(passphrase: string): Promise<KeySetupResult> {
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // 1. Generate master team key & recovery code
  const teamKey = getRandomBytes(32);
  const recoveryCode = generateRecoveryCode();
  const recoverySalt = getRandomBytes(16);
  const recoveryWrap = wrapTeamKeyWithRecoveryCode(teamKey, recoveryCode, recoverySalt);

  // 2. Insert team_key_versions row
  const { error: teamKeyErr } = await supabase.from('team_key_versions').insert({
    version: 1,
    recovery_wrap: recoveryWrap,
    recovery_kdf_salt: bytesToHex(recoverySalt),
    recovery_kdf_params: { m: 19456, t: 2, p: 1 },
    is_active: true
  });
  if (teamKeyErr) throw new Error(`Failed to store master key: ${teamKeyErr.message}`);

  // 3. Generate user's X25519 keypair and wrap under passphrase
  const userKeypair = generateUserKeyPair();
  const userSalt = getRandomBytes(16);
  const userPassKey = deriveUserPassphraseKey(passphrase, userSalt);
  const encPrivKey = wrapPrivateKey(userKeypair.privateKey, userPassKey);

  await supabase.rpc('publish_user_key', {
    p_public_key: bytesToHex(userKeypair.publicKey),
    p_enc_private_key: encPrivKey,
    p_kdf_salt: bytesToHex(userSalt),
    p_kdf_params: { m: 19456, t: 2, p: 1 },
    p_key_version: 1
  });

  // 4. Seal team key to admin's own public key
  const sealed = sealTeamKey(teamKey, userKeypair.publicKey);
  await supabase.from('user_key_wraps').insert({
    user_id: user.id,
    key_version: 1,
    sealed_team_key: sealed
  });

  // 5. Load into in-memory module closure
  setSessionKey(teamKey, 1);
  useSessionStore.getState().setUnlocked(true);

  return { recoveryCode };
}

/**
 * Unlocks the session using the user's personal passphrase.
 */
export async function unlockWithPassphrase(passphrase: string): Promise<void> {
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) throw new Error('User not authenticated');

  // 1. Fetch user's encrypted keypair
  const { data: userKeyRow, error: keyErr } = await supabase
    .from('user_keys')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (keyErr || !userKeyRow) {
    throw new Error('User cryptographic key not found. First-time setup required.');
  }

  // 2. Derive passphrase key and unwrap private key
  const salt = hexToBytes(userKeyRow.kdf_salt);
  const passKey = deriveUserPassphraseKey(passphrase, salt, userKeyRow.kdf_params);
  const userPrivateKey = unwrapPrivateKey(userKeyRow.enc_private_key, passKey);

  // 3. Fetch active sealed team key
  const { data: wrapRow, error: wrapErr } = await supabase
    .from('user_key_wraps')
    .select('sealed_team_key, key_version')
    .eq('user_id', user.id)
    .order('key_version', { ascending: false })
    .limit(1)
    .single();

  if (wrapErr || !wrapRow) {
    throw new Error('WAITING_FOR_ADMIN_GRANT');
  }

  // 4. Open sealed team key
  const teamKey = openSealedTeamKey(wrapRow.sealed_team_key, userPrivateKey);

  // 5. Store in memory closure
  setSessionKey(teamKey, wrapRow.key_version);
  useSessionStore.getState().setUnlocked(true);
}

/**
 * Restores access using the 160-bit master recovery code.
 */
export async function recoverWithRecoveryCode(recoveryCode: string): Promise<void> {
  // Fetch active team key version
  const { data: versionRow, error } = await supabase
    .from('team_key_versions')
    .select('*')
    .eq('is_active', true)
    .single();

  if (error || !versionRow) {
    throw new Error('No active team key version found on server.');
  }

  const salt = hexToBytes(versionRow.recovery_kdf_salt);
  const teamKey = unwrapTeamKeyWithRecoveryCode(
    versionRow.recovery_wrap,
    recoveryCode,
    salt,
    versionRow.recovery_kdf_params
  );

  setSessionKey(teamKey, versionRow.version);
  useSessionStore.getState().setUnlocked(true);
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
      allowedKeyVersions: [session.version]
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
    allowedKeyVersions: [session.version]
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
    aad
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
    aad
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
    aad
  });
}

/**
 * Computes deterministic blind index for exact ID search.
 */
export function computeIdBlindIndex(idNumber: string): string {
  const session = getSessionKey();
  if (!session) throw new Error('Session is locked');

  const subkeys = deriveAllSubkeys(session.teamKey);
  const { computeBlindIndex } = require('@sms/crypto');
  return computeBlindIndex(idNumber, subkeys.blindIndex);
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
