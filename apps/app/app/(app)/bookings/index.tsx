import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useThemeStore } from '../../../src/state/themeStore';
import { useSessionStore } from '../../../src/state/sessionStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Card } from '../../../src/ui/primitives/Card';
import { Table } from '../../../src/ui/primitives/Table';
import { Field } from '../../../src/ui/primitives/Field';
import { Select } from '../../../src/ui/primitives/Select';
import { Badge } from '../../../src/ui/primitives/Badge';
import { Button } from '../../../src/ui/primitives/Button';
import { spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';
import { computeIdBlindIndex, decryptRoomName } from '../../../src/features/crypto-session/cryptoSession';

export default function BookingsLedgerScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const { userRole, userPermissions } = useSessionStore();

  const canSearchBlind = userRole === 'admin' || userPermissions.includes('reveal_guest_pii');

  const [searchQuery, setSearchQuery] = useState('');
  const [blindSearchId, setBlindSearchId] = useState('');
  const [blindResults, setBlindResults] = useState<string[] | null>(null);
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [page, setPage] = useState(0);
  const pageSize = 15;

  // Handle blind index search
  const handleBlindSearch = async () => {
    if (!blindSearchId.trim()) {
      setBlindResults(null);
      return;
    }
    const blindIndex = computeIdBlindIndex(blindSearchId.trim());
    const { data: bookingIds, error } = await supabase.rpc('search_guests_by_blind_index', {
      p_blind: blindIndex
    });
    if (error) {
      alert('Blind search failed: ' + error.message);
      return;
    }
    setBlindResults(bookingIds || []);
  };

  // Fetch bookings list
  const { data: bookings, isLoading } = useQuery({
    queryKey: ['bookings_ledger', categoryFilter, statusFilter, blindResults, page],
    queryFn: async () => {
      let query = supabase
        .from('bookings')
        .select('*, booking_guests(*), allocations(*, rooms(*))', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (categoryFilter !== 'ALL') {
        query = query.eq('category', categoryFilter);
      }
      if (statusFilter !== 'ALL') {
        query = query.eq('status', statusFilter);
      }
      if (blindResults && blindResults.length > 0) {
        query = query.in('id', blindResults);
      } else if (blindResults && blindResults.length === 0) {
        return [];
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    }
  });

  const columns = [
    {
      key: 'id',
      header: 'Booking ID',
      width: 140,
      render: (item: any) => (
        <Text style={[styles.idText, { color: colors.blue }]}>
          {item.id.slice(0, 8)}...
        </Text>
      )
    },
    {
      key: 'category',
      header: 'Category',
      width: 90,
      render: (item: any) => (
        <Badge
          label={item.category}
          variant={
            item.category === 'MSA'
              ? 'success'
              : item.category === 'PI'
              ? 'warning'
              : 'default'
          }
        />
      )
    },
    {
      key: 'dates',
      header: 'Stay Window',
      width: 180,
      render: (item: any) => (
        <Text style={[styles.cellText, { color: colors.text }]}>
          {item.check_in} → {item.check_out}
        </Text>
      )
    },
    {
      key: 'party_size',
      header: 'Party',
      width: 70,
      render: (item: any) => (
        <Text style={[styles.cellText, { color: colors.text }]}>
          {item.party_size} pers.
        </Text>
      )
    },
    {
      key: 'details',
      header: 'Details Status',
      width: 130,
      render: (item: any) => {
        const hasPending = item.booking_guests?.some(
          (g: any) => g.details === 'PENDING'
        );
        return (
          <Badge
            label={hasPending ? 'Details pending' : 'Complete'}
            variant={hasPending ? 'warning' : 'success'}
          />
        );
      }
    },
    {
      key: 'status',
      header: 'Booking Status',
      width: 120,
      render: (item: any) => (
        <Badge
          label={item.status}
          variant={
            item.status === 'CONFIRMED'
              ? 'success'
              : item.status === 'DISPLACED'
              ? 'warning'
              : item.status === 'CANCELLED'
              ? 'error'
              : 'default'
          }
        />
      )
    },
    {
      key: 'action',
      header: 'Action',
      width: 100,
      render: (item: any) => (
        <Button
          label="View"
          variant="secondary"
          onPress={() => router.push(`/(app)/bookings/${item.id}` as any)}
        />
      )
    }
  ];

  return (
    <Screen title="Bookings & Ledger" showBack={false}>
      <Card style={{ marginBottom: spacing.md }}>
        <View style={styles.filterRow}>
          <View style={{ flex: 1 }}>
            <Select
              label="Filter Category"
              value={categoryFilter}
              onChange={setCategoryFilter}
              options={[
                { label: 'All Categories', value: 'ALL' },
                { label: 'MSA - BA MSA', value: 'MSA' },
                { label: 'PI - Posted In', value: 'PI' },
                { label: 'LEAVE - On Leave', value: 'LEAVE' },
                { label: 'TD - Displacement', value: 'TD' }
              ]}
            />
          </View>

          <View style={{ flex: 1 }}>
            <Select
              label="Filter Status"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { label: 'All Statuses', value: 'ALL' },
                { label: 'CONFIRMED', value: 'CONFIRMED' },
                { label: 'DISPLACED', value: 'DISPLACED' },
                { label: 'CANCELLED', value: 'CANCELLED' },
                { label: 'COMPLETED', value: 'COMPLETED' }
              ]}
            />
          </View>
        </View>

        {canSearchBlind && (
          <View style={styles.blindSearchRow}>
            <View style={{ flex: 1 }}>
              <Field
                label="Search by Guest ID / Service No (Exact Blind Index Search)"
                value={blindSearchId}
                onChangeText={setBlindSearchId}
                placeholder="Enter exact ID or Service No"
              />
            </View>
            <Button
              label="Blind Search"
              variant="secondary"
              onPress={handleBlindSearch}
              style={{ marginTop: 22 }}
            />
            {blindResults && (
              <Button
                label="Clear"
                variant="destructive"
                onPress={() => {
                  setBlindSearchId('');
                  setBlindResults(null);
                }}
                style={{ marginTop: 22 }}
              />
            )}
          </View>
        )}
      </Card>

      <Table
        columns={columns}
        data={bookings || []}
        keyExtractor={(item) => item.id}
        emptyText={isLoading ? 'Loading records...' : 'No bookings found.'}
      />

      <View style={styles.paginationRow}>
        <Button
          label="← Previous Page"
          variant="secondary"
          disabled={page === 0}
          onPress={() => setPage(page - 1)}
        />
        <Text style={[styles.pageIndicator, { color: colors.muted }]}>
          Page {page + 1}
        </Text>
        <Button
          label="Next Page →"
          variant="secondary"
          disabled={(bookings?.length || 0) < pageSize}
          onPress={() => setPage(page + 1)}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  filterRow: {
    flexDirection: 'row',
    gap: spacing.md
  },
  blindSearchRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    marginTop: spacing.sm
  },
  idText: {
    fontSize: typography.xs,
    fontFamily: 'monospace',
    fontWeight: typography.weights.bold
  },
  cellText: {
    fontSize: typography.sm
  },
  paginationRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.md
  },
  pageIndicator: {
    fontSize: typography.sm
  }
});
