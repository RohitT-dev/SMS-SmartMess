import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useThemeStore } from '../../../src/state/themeStore';
import { useSessionStore } from '../../../src/state/sessionStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Card } from '../../../src/ui/primitives/Card';
import { Button } from '../../../src/ui/primitives/Button';
import { Field } from '../../../src/ui/primitives/Field';
import { Banner } from '../../../src/ui/primitives/Banner';
import { Dialog } from '../../../src/ui/primitives/Dialog';
import { spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';
import { logAction } from '../../../src/lib/activityLog';
import { beginRotation, reencryptBatch, setSessionKey } from '@sms/crypto';
import {
  ACCESS_CODE_PATTERN,
  changeAccessCode,
  getActiveKeyVersion,
  getSubkey,
  wrapTeamKeyForCode,
} from '../../../src/features/crypto-session/cryptoSession';
import { parseValidUntil } from '../../../src/features/auth/accessCode';

const ROTATION_PAGE_SIZE = 200;

interface PageRow {
  pk: string;
  ciphertext: string;
  aadId?: string;
}

/** Keyset-paginates rows still on `currentVer` for a plain RLS-selectable table. */
async function fetchReasonPage(
  table: string,
  column: string,
  pkColumn: string,
  currentVer: number,
  after: string | null,
  limit: number,
): Promise<PageRow[]> {
  let query = supabase
    .from(table)
    .select(`${pkColumn}, ${column}`)
    .eq('key_version', currentVer)
    .not(column, 'is', null)
    .order(pkColumn, { ascending: true })
    .limit(limit);
  if (after) query = query.gt(pkColumn, after);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((r: any) => ({ pk: r[pkColumn], ciphertext: r[column] }));
}

/**
 * Pages through a table's ciphertext column, re-encrypting and persisting
 * each page under the new key version. Rows that fail to decrypt are
 * reported in `failed` rather than aborting the rotation (see
 * `reencryptBatch` in @sms/crypto).
 */
async function reencryptTable({
  table,
  column,
  oldSubkey,
  newSubkey,
  currentVer,
  newVersion,
  fetchPage,
}: {
  table: string;
  column: string;
  oldSubkey: Uint8Array;
  newSubkey: Uint8Array;
  currentVer: number;
  newVersion: number;
  fetchPage: (after: string | null, limit: number) => Promise<PageRow[]>;
}): Promise<{ succeeded: number; failed: Array<{ id: string; error: string }> }> {
  let after: string | null = null;
  let succeeded = 0;
  const failed: Array<{ id: string; error: string }> = [];

  while (true) {
    const page = await fetchPage(after, ROTATION_PAGE_SIZE);
    if (page.length === 0) break;

    const result = reencryptBatch({
      rows: page.map((r) => ({ id: r.pk, ciphertext: r.ciphertext, aadId: r.aadId })),
      oldSubkey,
      newSubkey,
      oldVersion: currentVer,
      newVersion,
      table,
      column,
    });

    if (result.succeeded.length > 0) {
      const { error } = await supabase.rpc('reencrypt_batch', {
        p_table: table,
        p_column: column,
        p_rows: result.succeeded.map((r) => ({ id: r.id, new_enc: r.newCiphertext })),
      });
      if (error) throw error;
    }

    succeeded += result.succeeded.length;
    failed.push(...result.failed);

    after = page[page.length - 1].pk;
    if (page.length < ROTATION_PAGE_SIZE) break;
  }

  return { succeeded, failed };
}

export default function AdminAccessCodeScreen() {
  const colors = useThemeStore((s) => s.colors);
  const { userRole } = useSessionStore();
  const queryClient = useQueryClient();

  const isAdmin = userRole === 'admin';

  // Set new access code
  const [newCode, setNewCode] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [savingCode, setSavingCode] = useState(false);
  const [codeResult, setCodeResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Key rotation
  const [showRotateDialog, setShowRotateDialog] = useState(false);
  const [rotationCode, setRotationCode] = useState('');
  const [rotating, setRotating] = useState(false);
  const [rotationProgress, setRotationProgress] = useState<string | null>(null);
  const [rotationError, setRotationError] = useState<string | null>(null);

  const { data: codeInfo } = useQuery({
    queryKey: ['access_code_info'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('access_code_info');
      if (error) throw error;
      return data as { version: number; valid_until: string | null; created_at: string } | null;
    },
    enabled: isAdmin,
  });

  const handleSetCode = async () => {
    setCodeResult(null);
    if (!ACCESS_CODE_PATTERN.test(newCode)) {
      setCodeResult({ ok: false, message: 'Access code must be 6 to 12 digits.' });
      return;
    }
    if (newCode !== confirmCode) {
      setCodeResult({ ok: false, message: 'Codes do not match.' });
      return;
    }
    try {
      setSavingCode(true);
      const version = await changeAccessCode(newCode, parseValidUntil(validUntil));
      logAction('access_code.changed', {
        meta: { code_version: version, has_expiry: !!validUntil },
      });
      setNewCode('');
      setConfirmCode('');
      setValidUntil('');
      setCodeResult({
        ok: true,
        message:
          'New access code is active. Everyone else must enter it the next time they unlock.',
      });
      queryClient.invalidateQueries({ queryKey: ['access_code_info'] });
    } catch (err: any) {
      logAction('access_code.change_failed');
      setCodeResult({ ok: false, message: err.message || 'Could not save the access code.' });
    } finally {
      setSavingCode(false);
    }
  };

  // Rotation: new random team key, re-encrypt every ciphertext column, then
  // activate it wrapped under the access code entered in the dialog.
  const handleExecuteKeyRotation = async () => {
    if (!ACCESS_CODE_PATTERN.test(rotationCode)) {
      setRotationError('Enter the access code (6 to 12 digits) to wrap the new key with.');
      return;
    }
    const code = rotationCode;
    setRotating(true);
    setRotationError(null);
    setRotationProgress('Phase 1/3: Creating new team key version...');

    try {
      const currentVer = getActiveKeyVersion();
      const rotation = beginRotation(currentVer);
      const wrapped = wrapTeamKeyForCode(rotation.newTeamKey, code);

      const { error: beginErr } = await supabase.rpc('begin_rotation', {
        p_new_version: rotation.newVersion,
        p_recovery_wrap: wrapped.wrap,
        p_recovery_salt: wrapped.saltHex,
        p_recovery_params: wrapped.params,
      });
      if (beginErr) throw beginErr;

      // Re-encrypt every ciphertext column, in pages, under the new subkeys.
      // A row that fails to decrypt (e.g. a legacy eviction row whose AAD id
      // was never persisted — see migration 0010) is skipped, not fatal: it
      // is reported to the admin and left on the old key version rather than
      // aborting the whole rotation.
      const rotationFailures: Array<{ table: string; id: string; error: string }> = [];

      setRotationProgress('Phase 2/3: Re-encrypting room names...');
      const roomsResult = await reencryptTable({
        table: 'rooms',
        column: 'name_enc',
        oldSubkey: getSubkey('room-name'),
        newSubkey: rotation.newSubkeys.roomName,
        currentVer,
        newVersion: rotation.newVersion,
        fetchPage: (after, limit) =>
          fetchReasonPage('rooms', 'name_enc', 'id', currentVer, after, limit),
      });
      rotationFailures.push(...roomsResult.failed.map((f) => ({ table: 'rooms', ...f })));

      setRotationProgress('Phase 2/3: Re-encrypting guest PII and reasons...');

      const guestPiiResult = await reencryptTable({
        table: 'guest_pii',
        column: 'pii_enc',
        oldSubkey: getSubkey('pii'),
        newSubkey: rotation.newSubkeys.pii,
        currentVer,
        newVersion: rotation.newVersion,
        fetchPage: async (after, limit) => {
          const { data, error } = await supabase.rpc('admin_page_guest_pii', {
            p_key_version: currentVer,
            p_after_guest_id: after,
            p_limit: limit,
          });
          if (error) throw error;
          return (data || []).map((r: any) => ({ pk: r.guest_id, ciphertext: r.pii_enc }));
        },
      });
      rotationFailures.push(...guestPiiResult.failed.map((f) => ({ table: 'guest_pii', ...f })));

      const bookingsResult = await reencryptTable({
        table: 'bookings',
        column: 'cancel_reason_enc',
        oldSubkey: getSubkey('reason'),
        newSubkey: rotation.newSubkeys.reason,
        currentVer,
        newVersion: rotation.newVersion,
        fetchPage: (after, limit) =>
          fetchReasonPage('bookings', 'cancel_reason_enc', 'id', currentVer, after, limit),
      });
      rotationFailures.push(...bookingsResult.failed.map((f) => ({ table: 'bookings', ...f })));

      const denialsResult = await reencryptTable({
        table: 'denials',
        column: 'reason_enc',
        oldSubkey: getSubkey('reason'),
        newSubkey: rotation.newSubkeys.reason,
        currentVer,
        newVersion: rotation.newVersion,
        fetchPage: (after, limit) =>
          fetchReasonPage('denials', 'reason_enc', 'id', currentVer, after, limit),
      });
      rotationFailures.push(...denialsResult.failed.map((f) => ({ table: 'denials', ...f })));

      const evictionsResult = await reencryptTable({
        table: 'evictions',
        column: 'reason_enc',
        oldSubkey: getSubkey('reason'),
        newSubkey: rotation.newSubkeys.reason,
        currentVer,
        newVersion: rotation.newVersion,
        fetchPage: async (after, limit) => {
          let query = supabase
            .from('evictions')
            .select('id, reason_enc, reason_aad_id')
            .eq('key_version', currentVer)
            .order('id', { ascending: true })
            .limit(limit);
          if (after) query = query.gt('id', after);
          const { data, error } = await query;
          if (error) throw error;
          return (data || []).map((r: any) => ({
            pk: r.id,
            ciphertext: r.reason_enc,
            aadId: r.reason_aad_id,
          }));
        },
      });
      rotationFailures.push(...evictionsResult.failed.map((f) => ({ table: 'evictions', ...f })));

      const closuresResult = await reencryptTable({
        table: 'room_closures',
        column: 'reason_enc',
        oldSubkey: getSubkey('reason'),
        newSubkey: rotation.newSubkeys.reason,
        currentVer,
        newVersion: rotation.newVersion,
        fetchPage: (after, limit) =>
          fetchReasonPage('room_closures', 'reason_enc', 'id', currentVer, after, limit),
      });
      rotationFailures.push(
        ...closuresResult.failed.map((f) => ({ table: 'room_closures', ...f })),
      );

      if (rotationFailures.length > 0) {
        logAction('keys.rotation_unrecoverable_rows', {
          meta: {
            new_version: rotation.newVersion,
            count: rotationFailures.length,
            tables: Array.from(new Set(rotationFailures.map((f) => f.table))),
          },
        });
      }

      setRotationProgress('Phase 3/3: Activating new key version...');
      const { error: finishErr } = await supabase.rpc('finish_rotation_with_code', {
        p_new_version: rotation.newVersion,
        p_code: code,
      });
      if (finishErr) throw finishErr;

      // Continue this session on the new key.
      setSessionKey(rotation.newTeamKey, rotation.newVersion);
      logAction('keys.rotation_completed', { meta: { new_version: rotation.newVersion } });
      queryClient.invalidateQueries();

      setShowRotateDialog(false);
      setRotationCode('');
      const unrecoverableNote =
        rotationFailures.length > 0
          ? `\n\nWARNING: ${rotationFailures.length} row(s) in [${Array.from(new Set(rotationFailures.map((f) => f.table))).join(', ')}] could not be re-encrypted and remain on the old key version — see activity log "keys.rotation_unrecoverable_rows".`
          : '';
      alert(
        `Key rotation complete. Active key version is now v${rotation.newVersion}. Staff must enter the access code again.${unrecoverableNote}`,
      );
    } catch (err: any) {
      logAction('keys.rotation_failed');
      setRotationError(err.message || 'Key rotation failed');
    } finally {
      setRotating(false);
      setRotationProgress(null);
    }
  };

  if (!isAdmin) {
    return (
      <Screen title="Access Code" showBack={true}>
        <Banner
          type="error"
          message="Unauthorized: only an Administrator can manage the access code."
        />
      </Screen>
    );
  }

  const validUntilText = codeInfo?.valid_until
    ? new Date(codeInfo.valid_until).toLocaleString()
    : 'No expiry';

  return (
    <Screen title="Access Code" showBack={false}>
      <View style={styles.container}>
        <Card>
          <Text style={[styles.title, { color: colors.navy }]}>Current access code</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Staff enter this code after their email and password. The code itself is never stored or
            shown, only its version and expiry.
          </Text>
          <Text style={[styles.infoLine, { color: colors.text }]}>
            Version: {codeInfo ? `#${codeInfo.version}` : '—'}
          </Text>
          <Text style={[styles.infoLine, { color: colors.text }]}>
            Valid until: {validUntilText}
          </Text>
        </Card>

        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.title, { color: colors.navy }]}>Set a new access code</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Takes effect immediately. Everyone else is asked for the new code the next time they
            unlock. Use 8 or more digits.
          </Text>

          {codeResult ? (
            <Banner type={codeResult.ok ? 'success' : 'error'} message={codeResult.message} />
          ) : null}

          <Field
            label="New Access Code"
            value={newCode}
            onChangeText={(t) => setNewCode(t.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            secureTextEntry={true}
            maxLength={12}
            placeholder="6–12 digits"
          />
          <Field
            label="Confirm New Code"
            value={confirmCode}
            onChangeText={(t) => setConfirmCode(t.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            secureTextEntry={true}
            maxLength={12}
            placeholder="Re-type code"
          />
          <Field
            label="Valid Until (optional)"
            value={validUntil}
            onChangeText={setValidUntil}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="YYYY-MM-DD — leave blank for no expiry"
            hint="The code stops working for staff at the end of this day. Admins can still use it to set the next one."
          />
          <Button label="Save New Code" onPress={handleSetCode} loading={savingCode} />
        </Card>

        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.title, { color: colors.navy }]}>Team key rotation</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Active key version: v{getActiveKeyVersion()}. Generates a new encryption key and
            re-encrypts every room name, guest record and reason with it. Changing the code alone
            does not require this.
          </Text>

          <Button
            label="Begin Key Rotation"
            variant="destructive"
            onPress={() => setShowRotateDialog(true)}
            style={{ marginTop: spacing.sm }}
          />
        </Card>

        <Dialog
          visible={showRotateDialog}
          title="Rotate Team Key"
          message="Re-encrypts all data under a new key. Enter the access code staff will use afterwards (the current code, or a new one)."
          confirmLabel="Execute Rotation"
          confirmVariant="destructive"
          onConfirm={handleExecuteKeyRotation}
          onCancel={() => {
            setShowRotateDialog(false);
            setRotationCode('');
            setRotationError(null);
          }}
          loading={rotating}
        >
          <Field
            label="Access Code"
            value={rotationCode}
            onChangeText={(t) => setRotationCode(t.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            secureTextEntry={true}
            maxLength={12}
            placeholder="6–12 digits"
          />
          {rotationProgress && (
            <Text style={{ fontSize: typography.sm, fontWeight: 'bold', color: colors.navy }}>
              {rotationProgress}
            </Text>
          )}
          {rotationError && (
            <Banner type="error" message={rotationError} style={{ marginTop: spacing.sm }} />
          )}
        </Dialog>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  title: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
  },
  subtitle: {
    fontSize: typography.sm,
    marginTop: 2,
    marginBottom: spacing.sm,
  },
  infoLine: {
    fontSize: typography.sm,
    marginTop: spacing.xs,
  },
});
