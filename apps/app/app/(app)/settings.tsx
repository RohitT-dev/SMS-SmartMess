import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useThemeStore } from '../../src/state/themeStore';
import { useSessionStore } from '../../src/state/sessionStore';
import { Screen } from '../../src/ui/primitives/Screen';
import { Card } from '../../src/ui/primitives/Card';
import { Button } from '../../src/ui/primitives/Button';
import { Select } from '../../src/ui/primitives/Select';
import { Badge } from '../../src/ui/primitives/Badge';
import { Table } from '../../src/ui/primitives/Table';
import { spacing, typography } from '../../src/ui/tokens';
import { supabase } from '../../src/lib/supabase';
import { logAction } from '../../src/lib/activityLog';
import { fetchAccessStatus, signOut } from '../../src/features/auth/authFlow';

export default function SettingsScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);

  const { autoLockMinutes, setAutoLockMinutes, lockSession, userRole, userPermissions } =
    useSessionStore();

  const { data: mfaRequired } = useQuery({
    queryKey: ['mfa_required'],
    queryFn: async () => (await fetchAccessStatus()).require_mfa
  });

  // Fetch active devices
  const { data: devices, refetch: refetchDevices } = useQuery({
    queryKey: ['user_devices'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('devices')
        .select('*')
        .order('last_seen_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const handleRevokeDevice = async (deviceId: string) => {
    try {
      const { error } = await supabase.rpc('revoke_device', { p_device_id: deviceId });
      if (error) throw error;
      logAction('devices.revoke', { entity: 'devices', entityId: deviceId });
      refetchDevices();
    } catch (err: any) {
      alert('Failed to revoke device: ' + err.message);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    router.replace('/(auth)/sign-in');
  };

  return (
    <Screen title="Account & Device Settings" showBack={false}>
      <View style={styles.container}>
        {/* Profile Card */}
        <Card>
          <View style={styles.topRow}>
            <View>
              <Text style={[styles.title, { color: colors.navy }]}>Security profile</Text>
              <Text style={[styles.subtitle, { color: colors.muted }]}>
                Hardware security and cryptographic session parameters.
              </Text>
            </View>
            <Badge
              label={userRole.toUpperCase()}
              variant={userRole === 'admin' ? 'warning' : 'default'}
            />
          </View>

          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          <Text style={[styles.label, { color: colors.muted }]}>Active Permissions</Text>
          <Text style={[styles.permList, { color: colors.text }]}>
            {userRole === 'admin'
              ? 'Administrator (All Capabilities Implicit)'
              : userPermissions.join(', ')}
          </Text>

          <View style={{ marginTop: spacing.md }}>
            <Badge
              label={mfaRequired ? 'TOTP MFA REQUIRED' : 'PASSWORD SIGN-IN (MFA OFF)'}
              variant={mfaRequired ? 'success' : 'warning'}
            />
          </View>
        </Card>

        {/* Security & Preferences */}
        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.title, { color: colors.navy }]}>Security and app preferences</Text>

          <View style={{ marginTop: spacing.sm }}>
            <Select
              label="Interface Theme"
              value={themeMode}
              onChange={(val) => {
                setThemeMode(val as any);
                logAction('settings.theme_change', { meta: { mode: val } });
              }}
              options={[
                { label: 'Light Mode (Service Theme)', value: 'light' },
                { label: 'Dark Mode (Low Light)', value: 'dark' },
              ]}
            />
          </View>

          <View style={{ marginTop: spacing.sm }}>
            <Select
              label="Inactivity Auto-Lock Timeout"
              value={String(autoLockMinutes)}
              onChange={(val) => {
                setAutoLockMinutes(Number(val));
                logAction('settings.autolock_change', { meta: { minutes: Number(val) } });
              }}
              options={[
                { label: '1 Minute (High Security)', value: '1' },
                { label: '2 Minutes (Default Standard)', value: '2' },
                { label: '5 Minutes', value: '5' },
                { label: '10 Minutes', value: '10' },
                { label: '15 Minutes (Maximum)', value: '15' },
              ]}
            />
          </View>

          <View style={styles.actionButtons}>
            <Button
              label="Lock Session Immediately"
              variant="secondary"
              onPress={() => {
                logAction('session.lock', { meta: { trigger: 'settings' } });
                lockSession();
                router.replace('/(auth)/unlock');
              }}
            />

            <Button label="Sign Out & Lock Device" variant="destructive" onPress={handleSignOut} />
          </View>
        </Card>

        {/* Active Devices */}
        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.title, { color: colors.navy }]}>Authorized devices</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Active sessions authenticated to this user account.
          </Text>

          <Table
            columns={[
              { key: 'label', header: 'Device Model / Browser', flex: 1 },
              {
                key: 'last_seen_at',
                header: 'Last Seen',
                width: 170,
                render: (d: any) => (
                  <Text style={{ fontSize: typography.xs }}>
                    {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : 'N/A'}
                  </Text>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                width: 100,
                render: (d: any) => (
                  <Badge
                    label={d.revoked_at ? 'REVOKED' : 'ACTIVE'}
                    variant={d.revoked_at ? 'error' : 'success'}
                  />
                ),
              },
              {
                key: 'action',
                header: 'Action',
                width: 110,
                render: (d: any) =>
                  !d.revoked_at && (
                    <Button
                      label="Revoke"
                      variant="destructive"
                      onPress={() => handleRevokeDevice(d.id)}
                    />
                  ),
              },
            ]}
            data={devices || []}
            keyExtractor={(d) => d.id}
            emptyText="No registered devices."
          />
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
  },
  subtitle: {
    fontSize: typography.sm,
    marginTop: 2,
  },
  divider: {
    height: 1,
    marginVertical: spacing.md,
  },
  label: {
    fontSize: typography.xs,
    fontWeight: typography.weights.medium,
  },
  permList: {
    fontSize: typography.sm,
    marginTop: 2,
  },
  actionButtons: {
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
});
