import { hkdfSha256, argon2idKdf, DEFAULT_ARGON2ID_PARAMS } from './primitives.ts';
import type { Argon2idParams } from './primitives.ts';
import { getRandomBytes, utf8ToBytes } from './utils.ts';

export type SubkeyLabel = 'pii' | 'room-name' | 'reason' | 'blind-index';

export const SUBKEY_LABELS: Record<string, SubkeyLabel> = {
  PII: 'pii',
  ROOM_NAME: 'room-name',
  REASON: 'reason',
  BLIND_INDEX: 'blind-index'
};

/**
 * Derives a specific 256-bit subkey from the team master key using HKDF-SHA256.
 * The team key must never be used directly for encryption.
 */
export function deriveSubkey(teamKey: Uint8Array, label: SubkeyLabel): Uint8Array {
  if (teamKey.length !== 32) {
    throw new Error('Team key must be 32 bytes (256 bits)');
  }
  const salt = utf8ToBytes('sms-team-key-salt-v1');
  const info = utf8ToBytes(`sms:subkey:${label}`);
  return hkdfSha256(teamKey, salt, info, 32);
}

export interface DerivedSubkeys {
  pii: Uint8Array;
  roomName: Uint8Array;
  reason: Uint8Array;
  blindIndex: Uint8Array;
}

export function deriveAllSubkeys(teamKey: Uint8Array): DerivedSubkeys {
  return {
    pii: deriveSubkey(teamKey, 'pii'),
    roomName: deriveSubkey(teamKey, 'room-name'),
    reason: deriveSubkey(teamKey, 'reason'),
    blindIndex: deriveSubkey(teamKey, 'blind-index')
  };
}

/**
 * Derives a 256-bit key from a user passphrase using Argon2id.
 */
export function deriveUserPassphraseKey(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS
): Uint8Array {
  if (passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters');
  }
  return argon2idKdf(passphrase, salt, params, 32);
}

export function generateSalt(length = 16): Uint8Array {
  return getRandomBytes(length);
}
