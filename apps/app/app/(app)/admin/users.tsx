import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useThemeStore } from '../../../src/state/themeStore';
import { useSessionStore } from '../../../src/state/sessionStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Card } from '../../../src/ui/primitives/Card';
import { Table } from '../../../src/ui/primitives/Table';
import { Button } from '../../../src/ui/primitives/Button';
import { Field } from '../../../src/ui/primitives/Field';
import { Select } from '../../../src/ui/primitives/Select';
import { Badge } from '../../../src/ui/primitives/Badge';
import { Dialog } from '../../../src/ui/primitives/Dialog';
import { Banner } from '../../../src/ui/primitives/Banner';
import { spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';

export default function AdminUsersScreen() {
  const colors = useThemeStore((s) => s.colors);
  const { userRole } = useSessionStore();
  const queryClient = useQueryClient();

  const isAdmin = userRole === 'admin';

  // Invite state
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'clerk'>('clerk');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Edit Permissions Dialog
  const [editingProfile, setEditingProfile] = useState<any | null>(null);
  const [permList, setPermList] = useState<string[]>([]);
  const [savingPerms, setSavingPerms] = useState(false);

  // Fetch profiles
  const { data: profiles, isLoading } = useQuery({
    queryKey: ['admin_profiles'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at');
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin
  });

  const allAvailablePermissions = [
    { key: 'create_booking', label: 'Create Booking' },
    { key: 'enter_guest_details', label: 'Enter / Backfill Guest Details' },
    { key: 'reveal_guest_pii', label: 'Reveal Guest PII & Blind Search' },
    { key: 'cancel_booking', label: 'Cancel Booking' },
    { key: 'approve_eviction', label: 'Approve Eviction & Displacement' },
    { key: 'view_reports', label: 'View Reports & Statistics' },
    { key: 'deny_request', label: 'Deny Low-Priority Requests' }
  ];

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteError(null);
    try {
      const { data, error } = await supabase.functions.invoke('invite-user', {
        body: {
          email: inviteEmail.trim(),
          role: inviteRole,
          permissions:
            inviteRole === 'admin'
              ? allAvailablePermissions.map((p) => p.key)
              : ['create_booking', 'enter_guest_details', 'view_reports', 'deny_request']
        }
      });
      if (error) throw error;
      setShowInviteDialog(false);
      setInviteEmail('');
      queryClient.invalidateQueries({ queryKey: ['admin_profiles'] });
    } catch (err: any) {
      setInviteError(err.message || 'Failed to invite user');
    } finally {
      setInviting(false);
    }
  };

  const handleSavePermissions = async () => {
    if (!editingProfile) return;
    setSavingPerms(true);
    try {
      const { error } = await supabase.rpc('set_user_permissions', {
        p_user_id: editingProfile.id,
        p_permissions: permList
      });
      if (error) throw error;
      setEditingProfile(null);
      queryClient.invalidateQueries({ queryKey: ['admin_profiles'] });
    } catch (err: any) {
      alert('Failed to update permissions: ' + err.message);
    } finally {
      setSavingPerms(false);
    }
  };

  const handleDeactivate = async (profileId: string) => {
    try {
      const { error } = await supabase.rpc('deactivate_user', {
        p_user_id: profileId
      });
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['admin_profiles'] });
    } catch (err: any) {
      alert(err.message || 'Cannot deactivate user');
    }
  };

  if (!isAdmin) {
    return (
      <Screen title="Staff Management" showBack={true}>
        <Banner type="error" message="Unauthorized: Admin access required." />
      </Screen>
    );
  }

  return (
    <Screen title="Staff & User Management" showBack={false}>
      <ScrollView contentContainerStyle={styles.container}>
        <Card>
          <View style={styles.topRow}>
            <View>
              <Text style={[styles.title, { color: colors.navy }]}>STAFF & CREDENTIALS</Text>
              <Text style={[styles.subtitle, { color: colors.muted }]}>
                Only 1 active Admin by default. Signups are disabled; invitation only.
              </Text>
            </View>
            <Button
              label="+ Invite Team Member"
              variant="primary"
              onPress={() => setShowInviteDialog(true)}
            />
          </View>
        </Card>

        <Card style={{ marginTop: spacing.md }}>
          <Table
            columns={[
              {
                key: 'id',
                header: 'User ID',
                width: 140,
                render: (p: any) => (
                  <Text style={[styles.monoText, { color: colors.text }]}>
                    {p.id.slice(0, 8)}...
                  </Text>
                )
              },
              {
                key: 'role',
                header: 'Role',
                width: 100,
                render: (p: any) => (
                  <Badge
                    label={p.role.toUpperCase()}
                    variant={p.role === 'admin' ? 'warning' : 'default'}
                  />
                )
              },
              {
                key: 'status',
                header: 'Status',
                width: 110,
                render: (p: any) => (
                  <Badge
                    label={p.is_active ? 'ACTIVE' : 'DEACTIVATED'}
                    variant={p.is_active ? 'success' : 'error'}
                  />
                )
              },
              {
                key: 'permissions',
                header: 'Grantable Permissions',
                flex: 1,
                render: (p: any) => (
                  <Text style={[styles.permText, { color: colors.muted }]}>
                    {p.role === 'admin'
                      ? 'Full Administrative Capabilities'
                      : (p.permissions || []).join(', ')}
                  </Text>
                )
              },
              {
                key: 'actions',
                header: 'Actions',
                width: 200,
                render: (p: any) => (
                  <View style={{ flexDirection: 'row', gap: spacing.xs }}>
                    {p.role !== 'admin' && (
                      <Button
                        label="Edit Perms"
                        variant="secondary"
                        onPress={() => {
                          setEditingProfile(p);
                          setPermList(p.permissions || []);
                        }}
                      />
                    )}
                    {p.is_active && (
                      <Button
                        label="Deactivate"
                        variant="destructive"
                        onPress={() => handleDeactivate(p.id)}
                      />
                    )}
                  </View>
                )
              }
            ]}
            data={profiles || []}
            keyExtractor={(p) => p.id}
          />
        </Card>

        {/* Invite Dialog */}
        <Dialog
          visible={showInviteDialog}
          title="Invite New Staff Member"
          message="Sends an official Supabase invitation email. Password minimum 12 characters and mandatory TOTP MFA will be enforced on first login."
          confirmLabel="Send Official Invite"
          confirmVariant="primary"
          onConfirm={handleInvite}
          onCancel={() => setShowInviteDialog(false)}
          loading={inviting}
        >
          <Field
            label="Staff Email Address"
            value={inviteEmail}
            onChangeText={setInviteEmail}
            placeholder="officer@mil.gov.in"
            keyboardType="email-address"
          />

          <Select
            label="Assigned Role"
            value={inviteRole}
            onChange={(val) => setInviteRole(val as any)}
            options={[
              { label: 'Clerk (Standard Restricted Access)', value: 'clerk' },
              { label: 'Admin (System Administrator)', value: 'admin' }
            ]}
          />

          {inviteError && (
            <Banner
              type="error"
              message={inviteError}
              style={{ marginTop: spacing.sm }}
            />
          )}
        </Dialog>

        {/* Edit Permissions Dialog */}
        <Dialog
          visible={!!editingProfile}
          title={`Edit Permissions: ${editingProfile?.id?.slice(0, 8)}`}
          message="Toggle specific operational capabilities for this clerk account."
          confirmLabel="Save Permissions"
          confirmVariant="primary"
          onConfirm={handleSavePermissions}
          onCancel={() => setEditingProfile(null)}
          loading={savingPerms}
        >
          {allAvailablePermissions.map((perm) => {
            const has = permList.includes(perm.key);
            return (
              <Button
                key={perm.key}
                label={`${has ? '✓ ' : '○ '} ${perm.label}`}
                variant={has ? 'primary' : 'secondary'}
                onPress={() => {
                  if (has) setPermList(permList.filter((k) => k !== perm.key));
                  else setPermList([...permList, perm.key]);
                }}
                style={{ marginBottom: spacing.xs }}
              />
            );
          })}
        </Dialog>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.md
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  title: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold
  },
  subtitle: {
    fontSize: typography.sm,
    marginTop: 2
  },
  monoText: {
    fontFamily: 'monospace',
    fontSize: typography.xs
  },
  permText: {
    fontSize: typography.xs
  }
});
