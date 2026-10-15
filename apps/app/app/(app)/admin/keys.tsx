import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useThemeStore } from '../../../src/state/themeStore';
import { useSessionStore } from '../../../src/state/sessionStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Card } from '../../../src/ui/primitives/Card';
import { Button } from '../../../src/ui/primitives/Button';
import { Field } from '../../../src/ui/primitives/Field';
import { Badge } from '../../../src/ui/primitives/Badge';
import { Banner } from '../../../src/ui/primitives/Banner';
import { Dialog } from '../../../src/ui/primitives/Dialog';
import { spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';
import {
  sealTeamKey,
  verifyRecoveryCode,
  generateRecoveryCode,
  wrapTeamKeyWithRecoveryCode,
  beginRotation,
  reencryptBatch,
  hexToBytes,
  bytesToHex,
  getRandomBytes
} from '@sms/crypto';
import {
  getActiveTeamKey,
  getActiveKeyVersion,
  getSubkey
} from '../../../src/features/crypto-session/cryptoSession';

export default function AdminKeysScreen() {
  const colors = useThemeStore((s) => s.colors);
  const { userRole } = useSessionStore();
  const queryClient = useQueryClient();

  const isAdmin = userRole === 'admin';

  // Test recovery code state
  const [testCodeInput, setTestCodeInput] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testingCode, setTestingCode] = useState(false);

  // Key rotation state
  const [showRotateDialog, setShowRotateDialog] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotationProgress, setRotationProgress] = useState<string | null>(null);
  const [rotationError, setRotationError] = useState<string | null>(null);

  // Pending users waiting for team key access
  const { data: pendingUsers, isLoading: loadingPending } = useQuery({
    queryKey: ['pending_key_grants'],
    queryFn: async () => {
      const currentVersion = getActiveKeyVersion();
      const { data: keys, error } = await supabase
        .from('user_keys')
        .select('user_id, public_key, profiles(role, is_active)')
        .eq('key_version', currentVersion);
      if (error) throw error;

      const { data: wraps } = await supabase
        .from('user_key_wraps')
        .select('user_id')
        .eq('key_version', currentVersion);

      const wrappedUserIds = new Set((wraps || []).map((w: any) => w.user_id));

      return (keys || [])
        .filter((k: any) => !wrappedUserIds.has(k.user_id) && k.profiles?.is_active)
        .map((k: any) => ({
          userId: k.user_id,
          publicKey: k.public_key,
          role: k.profiles?.role || 'clerk'
        }));
    },
    enabled: isAdmin
  });

  // Action: Grant access to pending user
  const handleGrantAccess = async (user: { userId: string; publicKey: string }) => {
    try {
      const teamKey = getActiveTeamKey();
      const version = getActiveKeyVersion();
      const recipientPubKey = hexToBytes(user.publicKey);
      const sealed = sealTeamKey(teamKey, recipientPubKey);

      const { error } = await supabase.rpc('grant_key_access', {
        p_user_id: user.userId,
        p_version: version,
        p_sealed: sealed
      });

      if (error) throw error;
      alert(`Granted team key access to user ${user.userId.slice(0, 8)}`);
      queryClient.invalidateQueries({ queryKey: ['pending_key_grants'] });
    } catch (err: any) {
      alert('Failed to grant access: ' + err.message);
    }
  };

  // Action: Test recovery code (non-destructive)
  const handleTestRecoveryCode = async () => {
    if (!testCodeInput.trim()) return;
    setTestingCode(true);
    setTestResult(null);
    try {
      // Fetch active recovery wrap from DB
      const currentVer = getActiveKeyVersion();
      const { data: verRow, error } = await supabase
        .from('team_key_versions')
        .select('recovery_wrap, recovery_kdf_salt, recovery_kdf_params')
        .eq('version', currentVer)
        .single();
      if (error) throw error;

      const isValid = verifyRecoveryCode(
        verRow.recovery_wrap,
        testCodeInput.trim(),
        hexToBytes(verRow.recovery_kdf_salt),
        verRow.recovery_kdf_params
      );

      if (isValid) {
        setTestResult({
          ok: true,
          message: 'Recovery code verified successfully! It correctly unwraps the active team key.'
        });
      } else {
        setTestResult({
          ok: false,
          message: 'Invalid recovery code. Verification failed.'
        });
      }
    } catch (err: any) {
      setTestResult({
        ok: false,
        message: err.message || 'Recovery code verification error'
      });
    } finally {
      setTestingCode(false);
    }
  };

  // Action: Full Key Rotation
  const handleExecuteKeyRotation = async () => {
    setRotating(true);
    setRotationError(null);
    setRotationProgress('Phase 1/4: Initializing new team key version...');

    try {
      const currentVer = getActiveKeyVersion();
      const rotation = beginRotation(currentVer);

      setRotationProgress('Phase 2/4: Generating recovery code for new key version...');
      const recoveryCode = generateRecoveryCode();
      const recoverySalt = getRandomBytes(16);
      const recoveryParams = { m: 19456, t: 2, p: 1 };
      const recoveryWrap = wrapTeamKeyWithRecoveryCode(
        rotation.newTeamKey,
        recoveryCode,
        recoverySalt,
        recoveryParams
      );

      // Register new version with backend
      const { error: beginErr } = await supabase.rpc('begin_rotation', {
        p_new_version: rotation.newVersion,
        p_recovery_wrap: recoveryWrap,
        p_recovery_salt: bytesToHex(recoverySalt),
        p_recovery_params: recoveryParams
      });
      if (beginErr) throw beginErr;

      // Re-encrypt rooms
      setRotationProgress('Phase 3/4: Re-encrypting room names...');
      const { data: roomRows } = await supabase.from('rooms').select('id, name_enc');
      if (roomRows && roomRows.length > 0) {
        const reencryptedRooms = reencryptBatch({
          rows: roomRows.map((r: any) => ({ id: r.id, ciphertext: r.name_enc })),
          oldSubkey: getSubkey('room-name'),
          newSubkey: rotation.newSubkeys.roomName,
          oldVersion: currentVer,
          newVersion: rotation.newVersion,
          table: 'rooms',
          column: 'name_enc'
        });

        const { error: batchErr } = await supabase.rpc('reencrypt_batch', {
          p_table: 'rooms',
          p_rows: reencryptedRooms.map((r) => ({ id: r.id, new_enc: r.newCiphertext }))
        });
        if (batchErr) throw batchErr;
      }

      // Finish rotation
      setRotationProgress('Phase 4/4: Activating new key version...');
      const { error: finishErr } = await supabase.rpc('finish_rotation', {
        p_new_version: rotation.newVersion
      });
      if (finishErr) throw finishErr;

      setShowRotateDialog(false);
      alert(
        `Key rotation complete! Active version is now v${rotation.newVersion}. Please store your new emergency recovery code:\n\n${recoveryCode}`
      );
    } catch (err: any) {
      setRotationError(err.message || 'Key rotation failed');
    } finally {
      setRotating(false);
      setRotationProgress(null);
    }
  };

  if (!isAdmin) {
    return (
      <Screen title="Key Management" showBack={true}>
        <Banner type="error" message="Unauthorized: Only Administrator may inspect cryptographic keys." />
      </Screen>
    );
  }

  return (
    <Screen title="Cryptographic Key Management" showBack={false}>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Pending Access Card */}
        <Card>
          <Text style={[styles.title, { color: colors.navy }]}>
            PENDING KEY ACCESS GRANTS ({pendingUsers?.length || 0})
          </Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            When a new clerk signs up, their device generates an X25519 key pair. The Admin's device must seal the team key to their public key.
          </Text>

          {loadingPending ? (
            <Text style={{ fontStyle: 'italic', marginVertical: spacing.sm }}>
              Checking pending users...
            </Text>
          ) : pendingUsers?.length === 0 ? (
            <Text style={{ fontStyle: 'italic', marginVertical: spacing.sm, color: colors.muted }}>
              All active staff members currently have sealed key access.
            </Text>
          ) : (
            pendingUsers?.map((u) => (
              <View key={u.userId} style={[styles.pendingRow, { borderColor: colors.border }]}>
                <View>
                  <Text style={[styles.userTitle, { color: colors.text }]}>
                    User ID: {u.userId.slice(0, 8)}... ({u.role.toUpperCase()})
                  </Text>
                  <Text style={[styles.pubKeyText, { color: colors.muted }]}>
                    Public Key: {u.publicKey.slice(0, 24)}...
                  </Text>
                </View>
                <Button
                  label="Grant Team Key Access"
                  variant="primary"
                  onPress={() => handleGrantAccess(u)}
                />
              </View>
            ))
          )}
        </Card>

        {/* Test Recovery Code */}
        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.title, { color: colors.navy }]}>TEST RECOVERY CODE (NON-DESTRUCTIVE)</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Verify that your stored 160-bit recovery code successfully unwraps the active team key without modifying any database records.
          </Text>

          <Field
            label="Enter Stored Recovery Code"
            value={testCodeInput}
            onChangeText={setTestCodeInput}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            autoCapitalize="characters"
          />

          <Button
            label="Verify Recovery Code"
            variant="secondary"
            loading={testingCode}
            onPress={handleTestRecoveryCode}
          />

          {testResult && (
            <Banner
              type={testResult.ok ? 'success' : 'error'}
              message={testResult.message}
              style={{ marginTop: spacing.sm }}
            />
          )}
        </Card>

        {/* Key Rotation */}
        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.title, { color: colors.navy }]}>TEAM KEY ROTATION</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Active Key Version: v{getActiveKeyVersion()}. Rotation generates a new random 256-bit team key, re-encrypts all database records in batches with resume capability, re-seals for active users, and flips the active version.
          </Text>

          <Button
            label="Begin Key Rotation"
            variant="destructive"
            onPress={() => setShowRotateDialog(true)}
            style={{ marginTop: spacing.sm }}
          />
        </Card>

        {/* Rotate Dialog */}
        <Dialog
          visible={showRotateDialog}
          title="Rotate Team Key"
          message="This operation will generate a new team key version, re-encrypt all ciphertext rows, and require updating the emergency recovery code."
          confirmLabel="Execute Batch Rotation"
          confirmVariant="destructive"
          onConfirm={handleExecuteKeyRotation}
          onCancel={() => setShowRotateDialog(false)}
          loading={rotating}
        >
          {rotationProgress && (
            <Text style={{ fontSize: typography.sm, fontWeight: 'bold', color: colors.navy }}>
              {rotationProgress}
            </Text>
          )}

          {rotationError && (
            <Banner
              type="error"
              message={rotationError}
              style={{ marginTop: spacing.sm }}
            />
          )}
        </Dialog>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.md
  },
  title: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold
  },
  subtitle: {
    fontSize: typography.sm,
    marginTop: 2,
    marginBottom: spacing.sm
  },
  pendingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderTopWidth: 1
  },
  userTitle: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold
  },
  pubKeyText: {
    fontSize: typography.xs,
    fontFamily: 'monospace'
  }
});
