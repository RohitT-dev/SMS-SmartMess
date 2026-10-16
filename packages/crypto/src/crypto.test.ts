import { describe, it } from 'vitest';
import assert from 'node:assert';

import {
  encryptEnvelope,
  decryptEnvelope,
  deriveSubkey,
  deriveAllSubkeys,
  deriveUserPassphraseKey,
  generateUserKeyPair,
  sealTeamKey,
  openSealedTeamKey,
  wrapPrivateKey,
  unwrapPrivateKey,
  generateRecoveryCode,
  wrapTeamKeyWithRecoveryCode,
  unwrapTeamKeyWithRecoveryCode,
  verifyRecoveryCode,
  computeBlindIndex,
  setSessionKey,
  getSessionKey,
  clearSessionKey,
  isSessionUnlocked,
  beginRotation,
  reencryptBatch,
  resealForUsers,
  getRandomBytes,
} from './index.ts';

describe('packages/crypto - Comprehensive Cryptographic Suite', () => {
  it('Round trip envelope encryption and decryption', () => {
    const teamKey = getRandomBytes(32);
    const subkeys = deriveAllSubkeys(teamKey);
    const plaintext = JSON.stringify({ name: 'Flight Lt Sharma', serviceNo: '12345-X' });
    const aad = 'guest_pii.pii_enc.550e8400-e29b-41d4-a716-446655440000';

    const envelope = encryptEnvelope({
      plaintext,
      subkey: subkeys.pii,
      keyVersion: 1,
      aad,
    });

    assert.ok(envelope.startsWith('v1.1.'));

    const decrypted = decryptEnvelope({
      envelope,
      subkey: subkeys.pii,
      aad,
      allowedKeyVersions: [1],
    });

    assert.strictEqual(decrypted, plaintext);
  });

  it('Fails decryption on AAD mismatch (ciphertext moved to another row/column)', () => {
    const teamKey = getRandomBytes(32);
    const subkey = deriveSubkey(teamKey, 'pii');
    const plaintext = 'Secret notes for booking';
    const aadRow1 = 'bookings.notes_enc.row-uuid-001';
    const aadRow2 = 'bookings.notes_enc.row-uuid-002'; // Moved to another row!

    const envelope = encryptEnvelope({
      plaintext,
      subkey,
      keyVersion: 1,
      aad: aadRow1,
    });

    assert.throws(() => {
      decryptEnvelope({
        envelope,
        subkey,
        aad: aadRow2,
        allowedKeyVersions: [1],
      });
    }, /tag|AAD/i);
  });

  it('Fails decryption on wrong key version', () => {
    const teamKey = getRandomBytes(32);
    const subkey = deriveSubkey(teamKey, 'pii');
    const aad = 'table.col.row-1';

    const envelope = encryptEnvelope({
      plaintext: 'test',
      subkey,
      keyVersion: 1,
      aad,
    });

    assert.throws(() => {
      decryptEnvelope({
        envelope,
        subkey,
        aad,
        allowedKeyVersions: [2], // Version 1 is not allowed
      });
    }, /Key version mismatch/i);
  });

  it('Fails decryption on wrong subkey / wrong passphrase', () => {
    const teamKey1 = getRandomBytes(32);
    const teamKey2 = getRandomBytes(32);
    const subkey1 = deriveSubkey(teamKey1, 'pii');
    const subkey2 = deriveSubkey(teamKey2, 'pii');
    const aad = 'table.col.row-1';

    const envelope = encryptEnvelope({
      plaintext: 'secure text',
      subkey: subkey1,
      keyVersion: 1,
      aad,
    });

    assert.throws(() => {
      decryptEnvelope({
        envelope,
        subkey: subkey2,
        aad,
      });
    });
  });

  it('Passphrase Argon2id key derivation and private key wrapping', () => {
    const salt = getRandomBytes(16);
    const passphrase = 'SuperSecretPassphrase123!';
    const userPassphraseKey = deriveUserPassphraseKey(passphrase, salt);

    const userKeypair = generateUserKeyPair();
    const wrapped = wrapPrivateKey(userKeypair.privateKey, userPassphraseKey);

    // Unwrapping with correct passphrase key succeeds
    const recoveredPrivKey = unwrapPrivateKey(wrapped, userPassphraseKey);
    assert.deepStrictEqual(recoveredPrivKey, userKeypair.privateKey);

    // Unwrapping with wrong passphrase fails
    const wrongKey = deriveUserPassphraseKey('WrongPassphrase999!', salt);
    assert.throws(() => {
      unwrapPrivateKey(wrapped, wrongKey);
    });
  });

  it('Sealed box: Admin seals team key to user public key, only intended user can open', () => {
    const teamKey = getRandomBytes(32);
    const clerk = generateUserKeyPair();
    const attacker = generateUserKeyPair();

    const sealedBlob = sealTeamKey(teamKey, clerk.publicKey);

    // Clerk opens with their private key
    const opened = openSealedTeamKey(sealedBlob, clerk.privateKey);
    assert.deepStrictEqual(opened, teamKey);

    // Attacker fails to open
    assert.throws(() => {
      openSealedTeamKey(sealedBlob, attacker.privateKey);
    });
  });

  it('Recovery code generation, formatting, wrapping, unwrapping, and non-destructive testing', () => {
    const teamKey = getRandomBytes(32);
    const recoveryCode = generateRecoveryCode();
    const salt = getRandomBytes(16);

    // Verify recovery code format (e.g. 8 groups of 4 Crockford Base32 characters)
    assert.match(recoveryCode, /^[0-9A-HJKMNP-Z]{4}(-[0-9A-HJKMNP-Z]{4}){7}$/);

    const recoveryWrap = wrapTeamKeyWithRecoveryCode(teamKey, recoveryCode, salt);

    // Test recovery code without side-effects (verifyRecoveryCode)
    assert.strictEqual(verifyRecoveryCode(recoveryWrap, recoveryCode, salt), true);
    assert.strictEqual(
      verifyRecoveryCode(recoveryWrap, 'WRON-GCOD-E000-0000-0000-0000-0000-0000', salt),
      false,
    );

    // Normalizing handles case and dashes
    const lowercaseCodeWithSpaces = recoveryCode.toLowerCase().replace(/-/g, ' ');
    const restored = unwrapTeamKeyWithRecoveryCode(recoveryWrap, lowercaseCodeWithSpaces, salt);
    assert.deepStrictEqual(restored, teamKey);
  });

  it('Blind index is deterministic, normalizes whitespace and dashes, exact match only', () => {
    const teamKey = getRandomBytes(32);
    const blindKey = deriveSubkey(teamKey, 'blind-index');

    const raw1 = '  AB-12345  ';
    const raw2 = 'ab12345';
    const raw3 = 'AB 12345';
    const different = 'AB 12346';

    const idx1 = computeBlindIndex(blindKey, raw1);
    const idx2 = computeBlindIndex(blindKey, raw2);
    const idx3 = computeBlindIndex(blindKey, raw3);
    const idxDiff = computeBlindIndex(blindKey, different);

    assert.strictEqual(idx1, idx2);
    assert.strictEqual(idx2, idx3);
    assert.notStrictEqual(idx1, idxDiff);
  });

  it('Session key closure: in memory only, wipes cleanly on lock', () => {
    const teamKey = getRandomBytes(32);
    setSessionKey(teamKey, 1);

    assert.strictEqual(isSessionUnlocked(), true);
    const session = getSessionKey();
    assert.ok(session !== null);
    assert.strictEqual(session.version, 1);
    assert.deepStrictEqual(session.teamKey, teamKey);

    // Lock session
    clearSessionKey();
    assert.strictEqual(isSessionUnlocked(), false);
    assert.strictEqual(getSessionKey(), null);
  });

  it('Key rotation: batches re-encrypt, old ciphertext still decrypts under old version until finish', () => {
    const v1TeamKey = getRandomBytes(32);
    const v1Subkeys = deriveAllSubkeys(v1TeamKey);

    const row1Aad = 'rooms.name_enc.room-101';
    const row2Aad = 'rooms.name_enc.room-102';

    const ct1 = encryptEnvelope({
      plaintext: 'Room 101',
      subkey: v1Subkeys.roomName,
      keyVersion: 1,
      aad: row1Aad,
    });

    const ct2 = encryptEnvelope({
      plaintext: 'Room 102',
      subkey: v1Subkeys.roomName,
      keyVersion: 1,
      aad: row2Aad,
    });

    // Begin rotation to v2
    const rotation = beginRotation(1);
    assert.strictEqual(rotation.newVersion, 2);

    // Re-encrypt batch
    const reencrypted = reencryptBatch({
      rows: [
        { id: 'room-101', ciphertext: ct1 },
        { id: 'room-102', ciphertext: ct2 },
      ],
      oldSubkey: v1Subkeys.roomName,
      newSubkey: rotation.newSubkeys.roomName,
      oldVersion: 1,
      newVersion: 2,
      table: 'rooms',
      column: 'name_enc',
    });

    assert.strictEqual(reencrypted.succeeded.length, 2);
    assert.strictEqual(reencrypted.failed.length, 0);
    assert.ok(reencrypted.succeeded[0].newCiphertext.startsWith('v1.2.'));

    // Check newly encrypted data decrypts with v2
    const dec1 = decryptEnvelope({
      envelope: reencrypted.succeeded[0].newCiphertext,
      subkey: rotation.newSubkeys.roomName,
      aad: row1Aad,
      allowedKeyVersions: [2],
    });
    assert.strictEqual(dec1, 'Room 101');

    // Reseal for active users
    const clerk = generateUserKeyPair();
    const sealedWraps = resealForUsers(
      [{ userId: 'clerk-uuid', publicKey: clerk.publicKey }],
      rotation.newTeamKey,
      2,
    );
    assert.strictEqual(sealedWraps.length, 1);
    assert.strictEqual(sealedWraps[0].keyVersion, 2);

    const unsealed = openSealedTeamKey(sealedWraps[0].sealedTeamKey, clerk.privateKey);
    assert.deepStrictEqual(unsealed, rotation.newTeamKey);
  });

  it('Key rotation: reencryptBatch uses aadId (not row id) for shared eviction reasons', () => {
    const v1TeamKey = getRandomBytes(32);
    const v1Subkeys = deriveAllSubkeys(v1TeamKey);

    // One eviction reason, shared ciphertext, bound into two rows (one per
    // evicted allocation) that each have a *different* primary key but the
    // *same* reason_aad_id.
    const reasonAadId = 'eviction-batch-aad-id';
    const sharedAad = `evictions.reason_enc.${reasonAadId}`;
    const sharedCiphertext = encryptEnvelope({
      plaintext: 'Medical emergency bed reassignment',
      subkey: v1Subkeys.reason,
      keyVersion: 1,
      aad: sharedAad,
    });

    const rotation = beginRotation(1);
    const result = reencryptBatch({
      rows: [
        { id: 'eviction-row-1', ciphertext: sharedCiphertext, aadId: reasonAadId },
        { id: 'eviction-row-2', ciphertext: sharedCiphertext, aadId: reasonAadId },
      ],
      oldSubkey: v1Subkeys.reason,
      newSubkey: rotation.newSubkeys.reason,
      oldVersion: 1,
      newVersion: 2,
      table: 'evictions',
      column: 'reason_enc',
    });

    assert.strictEqual(result.failed.length, 0);
    assert.strictEqual(result.succeeded.length, 2);
    assert.strictEqual(result.succeeded[0].id, 'eviction-row-1');
    assert.strictEqual(result.succeeded[1].id, 'eviction-row-2');

    const dec = decryptEnvelope({
      envelope: result.succeeded[0].newCiphertext,
      subkey: rotation.newSubkeys.reason,
      aad: sharedAad,
      allowedKeyVersions: [2],
    });
    assert.strictEqual(dec, 'Medical emergency bed reassignment');
  });

  it('Key rotation: reencryptBatch reports unrecoverable rows instead of aborting the batch', () => {
    const v1TeamKey = getRandomBytes(32);
    const v1Subkeys = deriveAllSubkeys(v1TeamKey);

    const goodAad = 'bookings.cancel_reason_enc.booking-good';
    const goodCiphertext = encryptEnvelope({
      plaintext: 'Guest requested cancellation',
      subkey: v1Subkeys.reason,
      keyVersion: 1,
      aad: goodAad,
    });

    // Encrypted with a different AAD than the one reencryptBatch will derive
    // from `id` — simulates a legacy row whose original AAD id was never
    // persisted (the pre-fix evictions bug).
    const mismatchedCiphertext = encryptEnvelope({
      plaintext: 'Unrecoverable legacy reason',
      subkey: v1Subkeys.reason,
      keyVersion: 1,
      aad: 'bookings.cancel_reason_enc.some-other-id',
    });

    const rotation = beginRotation(1);
    const result = reencryptBatch({
      rows: [
        { id: 'booking-good', ciphertext: goodCiphertext },
        { id: 'booking-bad', ciphertext: mismatchedCiphertext },
      ],
      oldSubkey: v1Subkeys.reason,
      newSubkey: rotation.newSubkeys.reason,
      oldVersion: 1,
      newVersion: 2,
      table: 'bookings',
      column: 'cancel_reason_enc',
    });

    assert.strictEqual(result.succeeded.length, 1);
    assert.strictEqual(result.succeeded[0].id, 'booking-good');
    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0].id, 'booking-bad');
    assert.ok(result.failed[0].error.length > 0);
  });
});
