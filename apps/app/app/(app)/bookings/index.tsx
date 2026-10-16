import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
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
import { logAction } from '../../../src/lib/activityLog';
import { computeIdBlindIndex } from '../../../src/features/crypto-session/cryptoSession';
import { useRoomNames } from '../../../src/features/rooms/useRoomNames';
import { userErrorMessage } from '../../../src/lib/userError';
import { Banner } from '../../../src/ui/primitives/Banner';
import { humanizeStatus } from '../../../src/lib/labels';

const statusVariant = (status: string) =>
  status === 'CONFIRMED'
    ? 'success'
    : status === 'DISPLACED'
      ? 'warning'
      : status === 'CANCELLED'
        ? 'error'
        : 'default';

const categoryVariant = (category: string) =>
  category === 'MFA' ? 'success' : category === 'PI' ? 'warning' : 'default';

export default function BookingsLedgerScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const { width } = useWindowDimensions();
  const { data: roomNames } = useRoomNames();
  const { userRole, userPermissions } = useSessionStore();
  // Wide screens get the table; anything narrower gets cards so Status/Action are never off-screen.
  const useCards = width < 960;
  const [searchError, setSearchError] = useState<string | null>(null);

  const roomsOf = (item: any): string => {
    const names = new Set<string>();
    (item.allocations || [])
      .filter((a: any) => a.status === 'ACTIVE')
      .forEach((a: any) => names.add(roomNames?.[a.room_id] ?? '…'));
    return names.size ? [...names].join(', ') : '—';
  };

  const canSearchBlind = userRole === 'admin' || userPermissions.includes('reveal_guest_pii');

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
    setSearchError(null);
    const blindIndex = computeIdBlindIndex(blindSearchId.trim());
    const { data: rows, error } = await supabase.rpc('search_guests_by_blind_index', {
      p_blind: blindIndex,
    });
    logAction('bookings.blind_search', {
      meta: { ok: !error, results: (rows as any[] | null)?.length ?? 0 },
    });
    if (error) {
      setSearchError(userErrorMessage(error, 'Search failed.'));
      return;
    }
    // The RPC returns [{ booking_id }], the ledger query filters on plain ids.
    setPage(0);
    setBlindResults(((rows || []) as Array<{ booking_id: string }>).map((r) => r.booking_id));
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
    },
  });

  const columns = [
    {
      key: 'id',
      header: 'Booking ID',
      width: 140,
      render: (item: any) => (
        <Text style={[styles.idText, { color: colors.blue }]}>{item.id.slice(0, 8)}...</Text>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      width: 90,
      render: (item: any) => (
        <Badge
          label={item.category}
          variant={categoryVariant(item.category)}
        />
      ),
    },
    {
      key: 'dates',
      header: 'Stay Window',
      width: 250,
      render: (item: any) => (
        <Text style={[styles.cellText, { color: colors.text }]}>
          {item.check_in} → {item.check_out}
        </Text>
      ),
    },
    {
      key: 'party_size',
      header: 'Party',
      width: 70,
      render: (item: any) => (
        <Text style={[styles.cellText, { color: colors.text }]}>{item.party_size} pers.</Text>
      ),
    },
    {
      key: 'rooms',
      header: 'Rooms',
      width: 120,
      render: (item: any) => (
        <Text style={[styles.cellText, { color: colors.text }]}>{roomsOf(item)}</Text>
      ),
    },
    {
      key: 'details',
      header: 'Details Status',
      width: 130,
      render: (item: any) => {
        const hasPending = item.booking_guests?.some((g: any) => g.details === 'PENDING');
        return (
          <Badge
            label={hasPending ? 'Details pending' : 'Complete'}
            variant={hasPending ? 'warning' : 'success'}
          />
        );
      },
    },
    {
      key: 'status',
      header: 'Booking Status',
      width: 120,
      render: (item: any) => (
        <Badge
          label={humanizeStatus(item.status)}
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
      ),
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
      ),
    },
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
                { label: 'MFA - BA MFA', value: 'MFA' },
                { label: 'PI - Posted In', value: 'PI' },
                { label: 'LEAVE - On Leave', value: 'LEAVE' },
                { label: 'TD - Displacement', value: 'TD' },
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
                { label: 'Confirmed', value: 'CONFIRMED' },
                { label: 'Displaced', value: 'DISPLACED' },
                { label: 'Cancelled', value: 'CANCELLED' },
                { label: 'Completed', value: 'COMPLETED' },
              ]}
            />
          </View>
        </View>

        {canSearchBlind && (
          <View style={styles.blindSearchRow}>
            <View style={{ flex: 1 }}>
              <Field
                label="Find a booking by guest ID number (exact match)"
                value={blindSearchId}
                onChangeText={setBlindSearchId}
                placeholder="Enter the full ID / Aadhaar / passport number"
                returnKeyType="search"
                onSubmitEditing={handleBlindSearch}
                hint="Names and phone numbers are encrypted and can't be searched."
              />
            </View>
            <Button
              label="Search"
              variant="secondary"
              onPress={handleBlindSearch}
              style={{ marginTop: 26 }}
            />
            {blindResults && (
              <Button
                label="Clear"
                variant="destructive"
                onPress={() => {
                  setBlindSearchId('');
                  setBlindResults(null);
                }}
                style={{ marginTop: 26 }}
              />
            )}
          </View>
        )}
        {searchError && <Banner type="error" message={searchError} />}
        {blindResults && (
          <Banner
            type="info"
            message={
              blindResults.length === 0
                ? 'No booking has a guest with that ID number.'
                : `Showing ${blindResults.length} booking${blindResults.length > 1 ? 's' : ''} for that ID number.`
            }
          />
        )}
      </Card>

      {useCards ? (
        <View style={{ gap: spacing.sm }}>
          {(bookings || []).length === 0 && (
            <Text style={[styles.cellText, { color: colors.muted, textAlign: 'center', padding: spacing.lg }]}>
              {isLoading ? 'Loading records…' : 'No bookings found.'}
            </Text>
          )}
          {(bookings || []).map((item: any) => {
            const hasPending = item.booking_guests?.some((g: any) => g.details === 'PENDING');
            return (
              <Pressable
                key={item.id}
                onPress={() => router.push(`/(app)/bookings/${item.id}` as any)}
                accessibilityRole="button"
                accessibilityLabel={`${item.category} booking ${item.check_in} to ${item.check_out}, ${item.status}`}
                style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
              >
                <View style={styles.cardTop}>
                  <Badge label={item.category} variant={categoryVariant(item.category)} />
                  <Badge label={humanizeStatus(item.status)} variant={statusVariant(item.status)} />
                </View>
                <Text style={[styles.cardDates, { color: colors.navy }]}>
                  {item.check_in} → {item.check_out}
                </Text>
                <Text style={[styles.cellText, { color: colors.text }]}>
                  {item.party_size} {item.party_size === 1 ? 'person' : 'people'} • Rooms: {roomsOf(item)}
                </Text>
                {item.status === 'CONFIRMED' && (
                  <Badge
                    label={hasPending ? 'Guest details pending' : 'Guest details complete'}
                    variant={hasPending ? 'warning' : 'success'}
                  />
                )}
              </Pressable>
            );
          })}
        </View>
      ) : (
        <Table
          columns={columns}
          data={bookings || []}
          keyExtractor={(item) => item.id}
          emptyText={isLoading ? 'Loading records...' : 'No bookings found.'}
        />
      )}

      <View style={styles.paginationRow}>
        <Button
          label="← Previous Page"
          variant="secondary"
          disabled={page === 0}
          onPress={() => setPage(page - 1)}
        />
        <Text style={[styles.pageIndicator, { color: colors.muted }]}>Page {page + 1}</Text>
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
    gap: spacing.md,
  },
  blindSearchRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    marginTop: spacing.sm,
  },
  idText: {
    fontSize: typography.xs,
    fontFamily: 'monospace',
    fontWeight: typography.weights.bold,
  },
  cellText: {
    fontSize: typography.sm,
  },
  paginationRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.md,
  },
  pageIndicator: {
    fontSize: typography.sm,
  },
  card: {
    borderWidth: 1,
    borderRadius: 4,
    padding: spacing.md,
    gap: spacing.xs,
    alignItems: 'flex-start',
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  cardDates: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
  },
});
