import { decryptEnvelope, encryptEnvelope } from './envelope.ts';
import { deriveAllSubkeys } from './kdf.ts';
import type { DerivedSubkeys } from './kdf.ts';
import { sealTeamKey } from './box.ts';
import { getRandomBytes } from './utils.ts';

export interface RotationState {
  oldVersion: number;
  newVersion: number;
  newTeamKey: Uint8Array;
  newSubkeys: DerivedSubkeys;
}

/**
 * Initializes a new rotation phase by creating a new random 256-bit team key
 * and incrementing the version number.
 */
export function beginRotation(currentVersion: number): RotationState {
  const newTeamKey = getRandomBytes(32);
  const newVersion = currentVersion + 1;
  const newSubkeys = deriveAllSubkeys(newTeamKey);

  return {
    oldVersion: currentVersion,
    newVersion,
    newTeamKey,
    newSubkeys
  };
}

export interface ReencryptRowItem {
  id: string;
  ciphertext: string;
}

export interface ReencryptBatchParams {
  rows: ReencryptRowItem[];
  oldSubkey: Uint8Array;
  newSubkey: Uint8Array;
  oldVersion: number;
  newVersion: number;
  table: string;
  column: string;
}

export interface ReencryptedRowResult {
  id: string;
  newCiphertext: string;
}

/**
 * Re-encrypts a batch of rows under the new subkey and new key version.
 * Verifies that the row was encrypted under the oldVersion.
 */
export function reencryptBatch({
  rows,
  oldSubkey,
  newSubkey,
  oldVersion,
  newVersion,
  table,
  column
}: ReencryptBatchParams): ReencryptedRowResult[] {
  return rows.map((row) => {
    const aad = `${table}.${column}.${row.id}`;
    const plaintext = decryptEnvelope({
      envelope: row.ciphertext,
      subkey: oldSubkey,
      aad,
      allowedKeyVersions: [oldVersion]
    });

    const newCiphertext = encryptEnvelope({
      plaintext,
      subkey: newSubkey,
      keyVersion: newVersion,
      aad
    });

    return {
      id: row.id,
      newCiphertext
    };
  });
}

export interface ActiveUserRecord {
  userId: string;
  publicKey: Uint8Array;
}

export interface ResealedUserWrap {
  userId: string;
  keyVersion: number;
  sealedTeamKey: string;
}

/**
 * Re-seals the new team key for all active users so they can unlock immediately upon rotation finish.
 */
export function resealForUsers(
  users: ActiveUserRecord[],
  newTeamKey: Uint8Array,
  newVersion: number
): ResealedUserWrap[] {
  return users.map((user) => ({
    userId: user.userId,
    keyVersion: newVersion,
    sealedTeamKey: sealTeamKey(newTeamKey, user.publicKey)
  }));
}
