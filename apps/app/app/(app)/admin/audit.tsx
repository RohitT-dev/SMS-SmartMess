import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useThemeStore } from '../../../src/state/themeStore';
import { useSessionStore } from '../../../src/state/sessionStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Card } from '../../../src/ui/primitives/Card';
import { Table } from '../../../src/ui/primitives/Table';
import { Button } from '../../../src/ui/primitives/Button';
import { Badge } from '../../../src/ui/primitives/Badge';
import { Banner } from '../../../src/ui/primitives/Banner';
import { spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';

export default function AdminAuditScreen() {
  const colors = useThemeStore((s) => s.colors);
  const { userRole } = useSessionStore();

  const isAdmin = userRole === 'admin';

  const [verifying, setVerifying] = useState(false);
  const [chainStatus, setChainStatus] = useState<{
    ok: boolean;
    first_bad_id: number | null;
  } | null>(null);

  // Fetch audit log entries
  const { data: auditLogs, isLoading, refetch } = useQuery({
    queryKey: ['admin_audit_logs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_log')
        .select('*')
        .order('id', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin
  });

  const handleVerifyChain = async () => {
    setVerifying(true);
    setChainStatus(null);
    try {
      const { data, error } = await supabase.rpc('verify_audit_chain');
      if (error) throw error;
      if (data && data.length > 0) {
        setChainStatus({
          ok: data[0].ok,
          first_bad_id: data[0].first_bad_id
        });
      } else {
        setChainStatus({ ok: true, first_bad_id: null });
      }
    } catch (err: any) {
      alert('Audit verification RPC error: ' + err.message);
    } finally {
      setVerifying(false);
    }
  };

  if (!isAdmin) {
    return (
      <Screen title="Audit Trail" showBack={true}>
        <Banner type="error" message="Unauthorized: Only Administrator may inspect cryptographic audit logs." />
      </Screen>
    );
  }

  return (
    <Screen title="Cryptographic Audit Trail" showBack={false}>
      <ScrollView contentContainerStyle={styles.container}>
        <Card>
          <View style={styles.topRow}>
            <View>
              <Text style={[styles.title, { color: colors.navy }]}>IMMUTABLE AUDIT LOG & HASH CHAIN</Text>
              <Text style={[styles.subtitle, { color: colors.muted }]}>
                Every state modification appends a SHA-256 chained entry. UPDATE and DELETE are blocked by triggers.
              </Text>
            </View>
            <Button
              label="Verify Hash Chain Integrity"
              variant="primary"
              onPress={handleVerifyChain}
              loading={verifying}
            />
          </View>

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
                )
              },
              { key: 'action', header: 'Action', width: 140 },
              { key: 'entity', header: 'Entity', width: 120 },
              {
                key: 'entity_id',
                header: 'Entity UUID',
                width: 140,
                render: (row: any) => (
                  <Text style={[styles.monoText, { color: colors.muted }]}>
                    {row.entity_id ? `${row.entity_id.slice(0, 8)}...` : 'N/A'}
                  </Text>
                )
              },
              {
                key: 'meta',
                header: 'Metadata (Non-PII)',
                flex: 1,
                render: (row: any) => (
                  <Text style={[styles.metaJson, { color: colors.text }]}>
                    {JSON.stringify(row.meta || {})}
                  </Text>
                )
              }
            ]}
            data={auditLogs || []}
            keyExtractor={(row) => String(row.id)}
            emptyText={isLoading ? 'Loading audit records...' : 'No audit records found.'}
          />
        </Card>
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
  metaJson: {
    fontSize: typography.xs,
    fontFamily: 'monospace'
  }
});
