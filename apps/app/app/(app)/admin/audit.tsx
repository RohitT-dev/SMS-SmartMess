import React, { useState } from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useThemeStore } from '../../../src/state/themeStore';
import { useSessionStore } from '../../../src/state/sessionStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Card } from '../../../src/ui/primitives/Card';
import { Table } from '../../../src/ui/primitives/Table';
import { Button } from '../../../src/ui/primitives/Button';
import { Banner } from '../../../src/ui/primitives/Banner';
import { spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';
import { logAction } from '../../../src/lib/activityLog';
import { Segmented } from '../../../src/ui/primitives/Segmented';
import { Badge } from '../../../src/ui/primitives/Badge';
import { describeAuditAction, NOISE_ACTIONS } from '../../../src/lib/auditLabels';
import { userErrorMessage } from '../../../src/lib/userError';
import { useAuthStore } from '../../../src/state/authStore';

export default function AdminAuditScreen() {
  const colors = useThemeStore((s) => s.colors);
  const { userRole } = useSessionStore();

  const isAdmin = userRole === 'admin';
  const { width } = useWindowDimensions();
  const useCards = width < 960;
  const myId = useAuthStore((st) => st.session?.user?.id);
  const [filter, setFilter] = useState<'changes' | 'all'>('changes');
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [verifying, setVerifying] = useState(false);
  const [chainStatus, setChainStatus] = useState<{
    ok: boolean;
    first_bad_id: number | null;
  } | null>(null);

  // Fetch audit log entries
  const { data: auditLogs, isLoading } = useQuery({
    queryKey: ['admin_audit_logs', filter],
    queryFn: async () => {
      let query = supabase.from('audit_log').select('*');
      // Navigation and sign-in noise would otherwise push real changes out of the 100-row window.
      if (filter === 'changes') for (const a of NOISE_ACTIONS) query = query.neq('action', a);
      const { data, error } = await query.order('id', { ascending: false }).limit(100);
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin,
  });

  const handleVerifyChain = async () => {
    setVerifying(true);
    setChainStatus(null);
    setVerifyError(null);
    try {
      const { data, error } = await supabase.rpc('verify_audit_chain');
      if (error) throw error;
      logAction('audit.verify_chain', { meta: { ok: data?.[0]?.ok ?? true } });
      if (data && data.length > 0) {
        setChainStatus({
          ok: data[0].ok,
          first_bad_id: data[0].first_bad_id,
        });
      } else {
        setChainStatus({ ok: true, first_bad_id: null });
      }
    } catch (err: any) {
      setVerifyError(userErrorMessage(err, 'Could not verify the audit chain.'));
    } finally {
      setVerifying(false);
    }
  };

  if (!isAdmin) {
    return (
      <Screen title="Audit Trail" showBack={true}>
        <Banner
          type="error"
          message="Unauthorized: Only Administrator may inspect cryptographic audit logs."
        />
      </Screen>
    );
  }

  return (
    <Screen title="Cryptographic Audit Trail" showBack={false}>
      <View style={styles.container}>
        <Card>
          <View style={styles.topRow}>
            <View style={{ flex: 1, minWidth: 240 }}>
              <Text style={[styles.title, { color: colors.navy }]}>
                IMMUTABLE AUDIT LOG & HASH CHAIN
              </Text>
              <Text style={[styles.subtitle, { color: colors.muted }]}>
                Every state modification appends a SHA-256 chained entry. UPDATE and DELETE are
                blocked by triggers.
              </Text>
            </View>
            <Button
              label="Verify Hash Chain Integrity"
              variant="primary"
              onPress={handleVerifyChain}
              loading={verifying}
            />
          </View>

          {verifyError && <Banner type="error" message={verifyError} style={{ marginTop: spacing.md }} />}

          {chainStatus && (
            <Banner
              type={chainStatus.ok ? 'success' : 'error'}
              message={
                chainStatus.ok
                  ? 'Audit Chain Verified: All hashes match. No tampering or altered log rows detected.'
                  : `Integrity Alert! Hash mismatch detected starting at record ID #${chainStatus.first_bad_id}. Database records have been tampered with!`
              }
              style={{ marginTop: spacing.md }}
            />
          )}
        </Card>

        <Card style={{ marginTop: spacing.md }}>
          <Segmented
            value={filter}
            onChange={(v) => setFilter(v as 'changes' | 'all')}
            options={[
              { label: 'Changes only', value: 'changes' },
              { label: 'All activity', value: 'all' },
            ]}
          />
        </Card>

        {useCards ? (
          <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
            {(auditLogs || []).length === 0 && (
              <Text style={[styles.subtitle, { color: colors.muted }]}>
                {isLoading ? 'Loading audit records…' : 'No audit records found.'}
              </Text>
            )}
            {(auditLogs || []).map((row: any) => (
              <Card key={row.id}>
                <View style={styles.topRow}>
                  <Text style={[styles.title, { color: colors.navy }]}>
                    {describeAuditAction(row.action)}
                  </Text>
                  <Badge label={`#${row.id}`} variant="default" />
                </View>
                <Text style={[styles.subtitle, { color: colors.muted }]}>
                  {new Date(row.at).toLocaleString()} • {row.actor ? (row.actor === myId ? 'you' : `staff #${String(row.actor).slice(-6).toUpperCase()}`) : 'system'}
                </Text>
                {row.meta && Object.keys(row.meta).length > 0 ? (
                  <Text style={[styles.metaJson, { color: colors.text, marginTop: spacing.xs }]}>
                    {JSON.stringify(row.meta)}
                  </Text>
                ) : null}
              </Card>
            ))}
          </View>
        ) : (
        <Card style={{ marginTop: spacing.md }}>
          <Table
            columns={[
              { key: 'id', header: 'Seq ID', width: 70 },
              {
                key: 'at',
                header: 'Timestamp',
                width: 170,
                render: (row: any) => (
                  <Text style={{ fontSize: typography.xs }}>
                    {new Date(row.at).toLocaleString()}
                  </Text>
                ),
              },
              {
                key: 'action',
                header: 'Action',
                width: 190,
                render: (row: any) => (
                  <Text style={{ fontSize: typography.sm }}>{describeAuditAction(row.action)}</Text>
                ),
              },
              {
                key: 'actor',
                header: 'By',
                width: 110,
                render: (row: any) => (
                  <Text style={[styles.monoText, { color: colors.muted }]}>
                    {row.actor ? (row.actor === myId ? 'you' : `#${String(row.actor).slice(-6).toUpperCase()}`) : 'system'}
                  </Text>
                ),
              },
              { key: 'entity', header: 'Entity', width: 120 },
              {
                key: 'entity_id',
                header: 'Entity UUID',
                width: 140,
                render: (row: any) => (
                  <Text style={[styles.monoText, { color: colors.muted }]}>
                    {row.entity_id ? `${row.entity_id.slice(0, 8)}...` : 'N/A'}
                  </Text>
                ),
              },
              {
                key: 'meta',
                header: 'Metadata (Non-PII)',
                flex: 1,
                render: (row: any) => (
                  <Text style={[styles.metaJson, { color: colors.text }]}>
                    {JSON.stringify(row.meta || {})}
                  </Text>
                ),
              },
            ]}
            data={auditLogs || []}
            keyExtractor={(row) => String(row.id)}
            emptyText={isLoading ? 'Loading audit records...' : 'No audit records found.'}
          />
        </Card>
        )}
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
  metaJson: {
    fontSize: typography.xs,
    fontFamily: 'monospace',
  },
});
