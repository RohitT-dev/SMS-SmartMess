import React, { useState } from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FunctionsHttpError } from '@supabase/supabase-js';
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
import { logAction } from '../../../src/lib/activityLog';
import { userErrorMessage } from '../../../src/lib/userError';
import { useAuthStore } from '../../../src/state/authStore';

export default function AdminUsersScreen() {
  const colors = useThemeStore((s) => s.colors);
  const { userRole } = useSessionStore();
  const queryClient = useQueryClient();

  const isAdmin = userRole === 'admin';
  const { width } = useWindowDimensions();
  const useCards = width < 960;
  const myId = useAuthStore((st) => st.session?.user?.id);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<null | {
    kind: 'promote' | 'demote' | 'deactivate';
    profile: any;
  }>(null);
  const [runningAction, setRunningAction] = useState(false);

  const shortId = (id: string) => `#${id.slice(-6).toUpperCase()}`;

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
  const {
    data: profiles,
    isLoading: profilesLoading,
    error: profilesError,
  } = useQuery({
    queryKey: ['admin_profiles'],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('*').order('created_at');
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin,
  });

  const allAvailablePermissions = [
    { key: 'create_booking', label: 'Create Booking' },
    { key: 'enter_guest_details', label: 'Enter / Backfill Guest Details' },
    { key: 'reveal_guest_pii', label: 'Reveal Guest PII & Blind Search' },
    { key: 'cancel_booking', label: 'Cancel Booking' },
    { key: 'approve_eviction', label: 'Approve Eviction & Displacement' },
    { key: 'view_reports', label: 'View Reports & Statistics' },
    { key: 'deny_request', label: 'Deny Low-Priority Requests' },
    { key: 'manage_rooms', label: 'Manage Rooms (add rooms, mark closures)' },
  ];

  const handleInvite = async () => {
    const email = inviteEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setInviteError('Enter a valid email address.');
      return;
    }
    setInviting(true);
    setInviteError(null);
    try {
      const { data, error } = await supabase.functions.invoke('invite-user', {
        body: {
          email,
          role: inviteRole,
          permissions:
            inviteRole === 'admin'
              ? allAvailablePermissions.map((p) => p.key)
              : ['create_booking', 'enter_guest_details', 'view_reports', 'deny_request'],
        },
      });
      if (error) {
        // A non-2xx reply surfaces as FunctionsHttpError with a generic message; the function's
        // own { error } body is on error.context (the fetch Response).
        if (error instanceof FunctionsHttpError) {
          const body = await (error.context as Response).json().catch(() => null);
          if (body && typeof body.error === 'string') throw new Error(body.error);
        }
        throw error;
      }
      logAction('users.invite', {
        entity: 'profiles',
        entityId: (data as any)?.userId ?? null,
        meta: { role: inviteRole },
      });
      setShowInviteDialog(false);
      setInviteEmail('');
      queryClient.invalidateQueries({ queryKey: ['admin_profiles'] });
    } catch (err: any) {
      setInviteError(userErrorMessage(err, 'Failed to invite user'));
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
        p_permissions: permList,
      });
      if (error) throw error;
      logAction('users.permissions_update', {
        entity: 'profiles',
        entityId: editingProfile.id,
        meta: { permissions: permList },
      });
      setEditingProfile(null);
      queryClient.invalidateQueries({ queryKey: ['admin_profiles'] });
    } catch (err: any) {
      setActionError(userErrorMessage(err, 'Failed to update permissions.'));
      setEditingProfile(null);
    } finally {
      setSavingPerms(false);
    }
  };

  const runPendingAction = async () => {
    if (!pendingAction) return;
    const { kind, profile } = pendingAction;
    setRunningAction(true);
    setActionError(null);
    try {
      const { error } =
        kind === 'deactivate'
          ? await supabase.rpc('deactivate_user', { p_user_id: profile.id })
          : await supabase.rpc('set_user_role', {
              p_user_id: profile.id,
              p_role: kind === 'promote' ? 'admin' : 'clerk',
            });
      if (error) throw error;
      logAction(kind === 'deactivate' ? 'users.deactivate' : 'users.role_update', {
        entity: 'profiles',
        entityId: profile.id,
        meta: kind === 'deactivate' ? {} : { role: kind === 'promote' ? 'admin' : 'clerk' },
      });
      setPendingAction(null);
      queryClient.invalidateQueries({ queryKey: ['admin_profiles'] });
    } catch (err: unknown) {
      setPendingAction(null);
      setActionError(userErrorMessage(err, 'That change could not be saved.'));
    } finally {
      setRunningAction(false);
    }
  };

  const renderActions = (p: any) => {
    if (!p.is_active) return <Text style={[styles.permText, { color: colors.muted }]}>No actions</Text>;
    return (
      <View style={{ flexDirection: 'row', gap: spacing.xs, flexWrap: 'wrap' }}>
        {p.role !== 'admin' && (
          <Button
            label="Edit Permissions"
            variant="secondary"
            onPress={() => {
              setEditingProfile(p);
              setPermList(p.permissions || []);
            }}
          />
        )}
        <Button
          label={p.role === 'admin' ? 'Demote to Clerk' : 'Promote to Admin'}
          variant="secondary"
          onPress={() => setPendingAction({ kind: p.role === 'admin' ? 'demote' : 'promote', profile: p })}
        />
        <Button
          label="Deactivate"
          variant="destructive"
          onPress={() => setPendingAction({ kind: 'deactivate', profile: p })}
        />
      </View>
    );
  };

  const pendingCopy = () => {
    if (!pendingAction) return { title: '', message: '', label: '' };
    const who = `${shortId(pendingAction.profile.id)}${pendingAction.profile.id === myId ? ' (you)' : ''}`;
    switch (pendingAction.kind) {
      case 'promote':
        return {
          title: 'Promote to Administrator?',
          message: `${who} will be able to manage staff, rooms, access codes and view the audit trail. Keep the number of administrators small.`,
          label: 'Promote to Admin',
        };
      case 'demote':
        return {
          title: 'Demote to Clerk?',
          message: `${who} will lose all administrator capabilities${pendingAction.profile.id === myId ? ', including this screen' : ''}.`,
          label: 'Demote to Clerk',
        };
      default:
        return {
          title: 'Deactivate this account?',
          message: `${who} will be signed out and can no longer use the system. This cannot be undone from this screen.`,
          label: 'Deactivate',
        };
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
      <View style={styles.container}>
        <Card>
          <View style={styles.topRow}>
            <View style={{ flex: 1, minWidth: 220 }}>
              <Text style={[styles.title, { color: colors.navy }]}>Staff and credentials</Text>
              <Text style={[styles.subtitle, { color: colors.muted }]}>
                Invitation only. There must always be at least one active Administrator.
              </Text>
            </View>
            <Button
              label="+ Invite Team Member"
              variant="primary"
              onPress={() => setShowInviteDialog(true)}
            />
          </View>
        </Card>

        {profilesError && (
          <Banner
            type="error"
            message={(profilesError as any).message || 'Failed to load staff list'}
            style={{ marginTop: spacing.md }}
          />
        )}

        {actionError && <Banner type="error" message={actionError} style={{ marginTop: spacing.md }} />}

        {useCards ? (
          <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
            {profilesLoading && (
              <Text style={[styles.permText, { color: colors.muted }]}>Loading staff…</Text>
            )}
            {(profiles || []).map((p: any) => (
              <Card key={p.id}>
                <View style={styles.topRow}>
                  <Text style={[styles.title, { color: colors.navy }]}>
                    Staff {shortId(p.id)}
                    {p.id === myId ? ' (you)' : ''}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: spacing.xs }}>
                    <Badge
                      label={p.role.toUpperCase()}
                      variant={p.role === 'admin' ? 'warning' : 'default'}
                    />
                    <Badge
                      label={p.is_active ? 'ACTIVE' : 'DEACTIVATED'}
                      variant={p.is_active ? 'success' : 'error'}
                    />
                  </View>
                </View>
                <Text style={[styles.permText, { color: colors.muted, marginVertical: spacing.sm }]}>
                  {p.role === 'admin'
                    ? 'Full administrative capabilities'
                    : (p.permissions || []).length
                      ? (p.permissions as string[]).map((k) => k.replace(/_/g, ' ')).join(' · ')
                      : 'No permissions granted'}
                </Text>
                {renderActions(p)}
              </Card>
            ))}
          </View>
        ) : (
        <Card style={{ marginTop: spacing.md }}>
          <Table
            loading={profilesLoading}
            columns={[
              {
                key: 'id',
                header: 'User ID',
                width: 140,
                render: (p: any) => (
                  <Text style={[styles.monoText, { color: colors.text }]}>
                    {shortId(p.id)}
                    {p.id === myId ? ' (you)' : ''}
                  </Text>
                ),
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
                ),
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
                ),
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
                ),
              },
              {
                key: 'actions',
                header: 'Actions',
                width: 200,
                render: (p: any) => renderActions(p),
              },
            ]}
            data={profiles || []}
            keyExtractor={(p) => p.id}
          />
        </Card>
        )}

        <Dialog
          visible={!!pendingAction}
          title={pendingCopy().title}
          message={pendingCopy().message}
          confirmLabel={pendingCopy().label}
          confirmVariant={pendingAction?.kind === 'deactivate' ? 'destructive' : 'primary'}
          onConfirm={runPendingAction}
          onCancel={() => setPendingAction(null)}
          loading={runningAction}
        />

        {/* Invite Dialog */}
        <Dialog
          visible={showInviteDialog}
          title="Invite New Staff Member"
          message="Sends an invitation email. The new member sets a password from the link, then signs in with the current access code."
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
              { label: 'Admin (System Administrator)', value: 'admin' },
            ]}
          />

          {inviteError && (
            <Banner type="error" message={inviteError} style={{ marginTop: spacing.sm }} />
          )}
        </Dialog>

        {/* Edit Permissions Dialog */}
        <Dialog
          visible={!!editingProfile}
          title={`Edit Permissions: Staff ${editingProfile ? shortId(editingProfile.id) : ''}`}
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
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
  },
  subtitle: {
    fontSize: typography.sm,
    marginTop: 2,
  },
  monoText: {
    fontFamily: 'monospace',
    fontSize: typography.xs,
  },
  permText: {
    fontSize: typography.xs,
  },
});
