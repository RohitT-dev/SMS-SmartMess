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
  /** Primary key value used to locate/update the row. */
  id: string;
  ciphertext: string;
  /**
   * Id bound into the AAD as `<table>.<column>.<aadId>`. Defaults to `id`.
   * Needed for tables (e.g. `evictions`) where the AAD id is not the row's
   * own primary key — see `reencrypt_batch` in the rotation migration.
   */
  aadId?: string;
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

export interface ReencryptFailure {
  id: string;
  error: string;
}

export interface ReencryptBatchResult {
  succeeded: ReencryptedRowResult[];
  failed: ReencryptFailure[];
}

/**
 * Re-encrypts a batch of rows under the new subkey and new key version.
 * Verifies that the row was encrypted under the oldVersion.
 *
 * A row that fails to decrypt (wrong AAD, corrupt ciphertext, etc.) is
 * reported in `failed` rather than aborting the whole batch — rotation must
 * still finish for every other row even if one legacy row is unrecoverable.
 */
export function reencryptBatch({
  rows,
  oldSubkey,
  newSubkey,
  oldVersion,
  newVersion,
  table,
  column
}: ReencryptBatchParams): ReencryptBatchResult {
  const succeeded: ReencryptedRowResult[] = [];
  const failed: ReencryptFailure[] = [];

  for (const row of rows) {
    const aad = `${table}.${column}.${row.aadId ?? row.id}`;
    try {
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

      succeeded.push({ id: row.id, newCiphertext });
    } catch (err) {
      failed.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { succeeded, failed };
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
