import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useThemeStore } from '../../../src/state/themeStore';
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
import {
  computeIdBlindIndex,
  decryptGuestPii,
} from '../../../src/features/crypto-session/cryptoSession';
import { useRoomNames } from '../../../src/features/rooms/useRoomNames';
import { userErrorMessage } from '../../../src/lib/userError';
import { Banner } from '../../../src/ui/primitives/Banner';
import { humanizeStatus } from '../../../src/lib/labels';

const statusVariant = (status: string) =>
  status === 'CONFIRMED'
    ? 'success'
    : status === 'PENDING_ALLOTMENT' || status === 'DISPLACED'
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
  // Wide screens get the table; anything narrower gets cards so Status/Action are never off-screen.
  const useCards = width < 960;
  const [searchError, setSearchError] = useState<string | null>(null);

  const roomsOf = (item: any): string => {
    if (item.status === 'PENDING_ALLOTMENT') return 'Pending Allotment';
    const names = new Set<string>();
    (item.allocations || [])
      .filter((a: any) => a.status === 'ACTIVE')
      .forEach((a: any) => names.add(roomNames?.[a.room_id] ?? '…'));
    return names.size ? [...names].join(', ') : '—';
  };

  // Query guest PII records to resolve guest names if decrypted session is unlocked
  const { data: piiRows } = useQuery({
    queryKey: ['guest_pii_for_ledger'],
    queryFn: async () => {
      const { data, error } = await supabase.from('guest_pii').select('guest_id, pii_enc');
      if (error) return [];
      return data || [];
    },
  });

  const piiMap = useMemo(() => {
    const map = new Map<string, { name: string; serviceNumber?: string | null; unit?: string | null; phone?: string | null }>();
    if (!piiRows) return map;
    for (const p of piiRows) {
      if (p.pii_enc) {
        try {
          const dec = decryptGuestPii(p.guest_id, p.pii_enc);
          map.set(p.guest_id, {
            name: dec.name,
            serviceNumber: dec.serviceNumber,
            unit: dec.unit,
            phone: dec.phone,
          });
        } catch {
          // ignore decryption error if session key mismatch
        }
      }
    }
    return map;
  }, [piiRows]);

  const guestNameOf = (g: any, idx: number) => {
    const pii = piiMap.get(g?.id);
    return g?.guest_name || pii?.name || (g?.guest_code ? `Guest (${g.guest_code})` : `Guest ${idx + 1}`);
  };

  const guestUnitOf = (g: any) => g?.unit || piiMap.get(g?.id)?.unit;
  const guestServiceNoOf = (g: any) => g?.service_number || piiMap.get(g?.id)?.serviceNumber;

  const getEffectiveBookingStatus = (b: any): string => {
    if (!b) return 'PENDING_ALLOTMENT';
    if (b.status === 'CANCELLED' || b.status === 'DISPLACED' || b.status === 'COMPLETED') {
      return b.status;
    }
    if (b.status === 'PENDING_ALLOTMENT') {
      return 'PENDING_ALLOTMENT';
    }
    const activeAllocs = (b.allocations || []).filter((a: any) => a.status === 'ACTIVE');
    if (activeAllocs.length === 0) {
      return 'PENDING_ALLOTMENT';
    }
    return 'CONFIRMED';
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [searchQueryApplied, setSearchQueryApplied] = useState('');
  const [searchResults, setSearchResults] = useState<string[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [page, setPage] = useState(0);
  const pageSize = 15;

  // Handle universal search across any guest/booking parameter (Name, Unit, Service No, Phone, Guest ID, etc.)
  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      setSearchQueryApplied('');
      return;
    }
    setSearchError(null);
    setIsSearching(true);
    try {
      const ids = new Set<string>();

      // 1. Universal search RPC (matches guest_code, rank_code, category, booking id, name, unit, etc.)
      const { data: rpcRows, error: rpcError } = await supabase.rpc('search_bookings_and_guests', {
        p_query: q,
      });

      if (!rpcError && Array.isArray(rpcRows)) {
        rpcRows.forEach((r: any) => {
          if (r?.booking_id) ids.add(r.booking_id);
        });
      }

      // 2. Direct query on booking_guests to guarantee matching by guest_name, unit, service_number, phone
      try {
        const { data: directGuests } = await supabase
          .from('booking_guests')
          .select('booking_id')
          .or(`guest_name.ilike.%${q}%,unit.ilike.%${q}%,service_number.ilike.%${q}%,phone.ilike.%${q}%,guest_code.ilike.%${q}%,rank_code.ilike.%${q}%`);
        if (directGuests) {
          directGuests.forEach((g: any) => {
            if (g?.booking_id) ids.add(g.booking_id);
          });
        }
      } catch {
        // Safe to ignore if table query restricted
      }

      // 3. Blind index exact match if session is unlocked (for optional Aadhaar/passport search)
      try {
        const blindIndex = computeIdBlindIndex(q);
        const { data: blindRows } = await supabase.rpc('search_guests_by_blind_index', {
          p_blind: blindIndex,
        });
        if (Array.isArray(blindRows)) {
          blindRows.forEach((r: any) => {
            if (r?.booking_id) ids.add(r.booking_id);
          });
        }
      } catch {
        // Safe to ignore if session key not unlocked or input not valid blind index
      }

      // 4. In-memory match against piiMap (so any decrypted guest matching name/unit/service number is found!)
      if (piiMap.size > 0 && bookings) {
        const lowerQ = q.toLowerCase();
        for (const b of (bookings as any[])) {
          const matched = (b.booking_guests || []).some((g: any) => {
            const pii = piiMap.get(g?.id);
            if (!pii) return false;
            return (
              (pii.name && pii.name.toLowerCase().includes(lowerQ)) ||
              (pii.unit && pii.unit.toLowerCase().includes(lowerQ)) ||
              (pii.serviceNumber && pii.serviceNumber.toLowerCase().includes(lowerQ)) ||
              (pii.phone && pii.phone.toLowerCase().includes(lowerQ))
            );
          });
          if (matched) ids.add(b.id);
        }
      }

      logAction('bookings.search', {
        // The query can be a name, phone number or ID: log only its length.
        meta: { query_length: q.length, results: ids.size },
      });

      setPage(0);
      setSearchQueryApplied(q);
      setSearchResults([...ids]);
    } catch (err: any) {
      setSearchError(userErrorMessage(err, 'Search failed.'));
    } finally {
      setIsSearching(false);
    }
  };

  const handleClearSearch = () => {
    setSearchQuery('');
    setSearchQueryApplied('');
    setSearchResults(null);
    setSearchError(null);
    setPage(0);
  };

  // Fetch bookings list
  const { data: bookings, isLoading, refetch } = useQuery({
    queryKey: ['bookings_ledger', categoryFilter, statusFilter, searchResults, page],
    queryFn: async () => {
      let query = supabase
        .from('bookings')
        .select('*, booking_guests(*), allocations(*, rooms(*))', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (categoryFilter !== 'ALL') {
        query = query.eq('category', categoryFilter);
      }
      if (statusFilter === 'PENDING_ALLOTMENT') {
        query = query.not('status', 'in', '("CANCELLED","DISPLACED","COMPLETED")');
      } else if (statusFilter !== 'ALL') {
        query = query.eq('status', statusFilter);
      }
      if (searchResults && searchResults.length > 0) {
        query = query.in('id', searchResults);
      } else if (searchResults && searchResults.length === 0) {
        return [];
      }

      const { data, error } = await query;
      if (error) throw error;
      let list = data || [];
      if (statusFilter === 'PENDING_ALLOTMENT') {
        list = list.filter((b: any) => getEffectiveBookingStatus(b) === 'PENDING_ALLOTMENT');
      } else if (statusFilter === 'CONFIRMED') {
        list = list.filter((b: any) => getEffectiveBookingStatus(b) === 'CONFIRMED');
      }
      return list;
    },
  });

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  const handleAllot = (item: any) => {
    const payload = JSON.stringify({
      bookingId: item.id,
      category: item.category,
      checkIn: item.check_in,
      checkOut: item.check_out,
      preferredRoomType: item.preferred_room_type || undefined,
      guests: (item.booking_guests || []).map((g: any, i: number) => ({
        gender: g.gender || 'M',
        rankCode: g.rank_code || 'CAPT',
        name: guestNameOf(g, i),
      })),
    });
    router.push({
      pathname: '/(app)/bookings/new/rooms' as any,
      params: { payload },
    });
  };

  const columns = [
    {
      key: 'id',
      header: 'Booking ID',
      width: 120,
      render: (item: any) => (
        <Text style={[styles.idText, { color: colors.blue }]}>{item.id.slice(0, 8)}...</Text>
      ),
    },
    {
      key: 'guest',
      header: 'Guest Name & Rank',
      width: 220,
      render: (item: any) => {
        const guests = item.booking_guests || [];
        if (!guests.length) return <Text style={[styles.cellText, { color: colors.muted }]}>—</Text>;
        return (
          <View style={{ gap: 4 }}>
            {guests.map((g: any, i: number) => {
              const name = guestNameOf(g, i);
              const unit = guestUnitOf(g);
              const sNo = guestServiceNoOf(g);
              return (
                <View key={g.id || i} style={{ gap: 1 }}>
                  <Text style={[styles.cellText, { fontWeight: '700', color: colors.navy }]}>
                    {name}
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.muted }}>
                    {[
                      g.rank_code,
                      unit,
                      sNo && `No: ${sNo}`,
                      g.guest_code && `[${g.guest_code}]`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
              );
            })}
          </View>
        );
      },
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
      width: 210,
      render: (item: any) => (
        <Text style={[styles.cellText, { color: colors.text }]}>
          📅 {item.check_in} (12 PM) → {item.check_out} (12 PM)
        </Text>
      ),
    },
    {
      key: 'rooms',
      header: 'Room / Bed',
      width: 140,
      render: (item: any) => (
        <Text style={[styles.cellText, { color: colors.text, fontWeight: '600' }]}>
          {roomsOf(item)}
        </Text>
      ),
    },
    {
      key: 'status',
      header: 'Booking Status',
      width: 130,
      render: (item: any) => {
        const effectiveStatus = getEffectiveBookingStatus(item);
        return (
          <Badge
            label={humanizeStatus(effectiveStatus)}
            variant={
              effectiveStatus === 'CONFIRMED'
                ? 'success'
                : effectiveStatus === 'PENDING_ALLOTMENT'
                  ? 'saffron'
                  : effectiveStatus === 'DISPLACED'
                    ? 'warning'
                    : effectiveStatus === 'CANCELLED'
                      ? 'error'
                      : 'default'
            }
          />
        );
      },
    },
    {
      key: 'action',
      header: 'Action',
      width: 150,
      render: (item: any) => {
        const effectiveStatus = getEffectiveBookingStatus(item);
        return (
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            {effectiveStatus === 'PENDING_ALLOTMENT' ? (
              <Button
                label="Assign"
                variant="primary"
                onPress={() => handleAllot(item)}
              />
            ) : null}
            <Button
              label="View"
              variant="secondary"
              onPress={() => router.push(`/(app)/bookings/${item.id}` as any)}
            />
          </View>
        );
      },
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
                { label: 'Pending Allotment', value: 'PENDING_ALLOTMENT' },
                { label: 'Confirmed', value: 'CONFIRMED' },
                { label: 'Displaced', value: 'DISPLACED' },
                { label: 'Cancelled', value: 'CANCELLED' },
                { label: 'Completed', value: 'COMPLETED' },
              ]}
            />
          </View>
        </View>

        <View style={styles.searchRow}>
          <View style={{ flex: 1 }}>
            <Field
              label="Search Bookings & Guests"
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search by Guest ID (e.g. GST-1001), Rank, Name, Phone, Service No, Category..."
              returnKeyType="search"
              onSubmitEditing={handleSearch}
              hint="Search across any parameter: Unique Guest ID, military rank, category, booking ID, or personal details."
            />
          </View>
          <Button
            label={isSearching ? 'Searching…' : 'Search'}
            variant="secondary"
            disabled={isSearching}
            onPress={handleSearch}
            style={{ marginTop: 26 }}
          />
          {searchResults !== null && (
            <Button
              label="Clear"
              variant="destructive"
              onPress={handleClearSearch}
              style={{ marginTop: 26 }}
            />
          )}
        </View>
        {searchError && <Banner type="error" message={searchError} />}
        {searchResults !== null && (
          <Banner
            type={searchResults.length === 0 ? 'warning' : 'info'}
            message={
              searchResults.length === 0
                ? `No bookings or guests match "${searchQueryApplied}".`
                : `Showing ${searchResults.length} booking${searchResults.length > 1 ? 's' : ''} matching "${searchQueryApplied}".`
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
            const effectiveStatus = getEffectiveBookingStatus(item);
            const hasPending = item.booking_guests?.some((g: any) => g.details === 'PENDING');
            return (
              <Pressable
                key={item.id}
                onPress={() => router.push(`/(app)/bookings/${item.id}` as any)}
                accessibilityRole="button"
                accessibilityLabel={`${item.category} booking ${item.check_in} to ${item.check_out}, ${effectiveStatus}`}
                style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
              >
                <View style={styles.cardTop}>
                  <Badge label={item.category} variant={categoryVariant(item.category)} />
                  <Badge label={humanizeStatus(effectiveStatus)} variant={statusVariant(effectiveStatus)} />
                </View>
                <Text style={[styles.cardDates, { color: colors.navy }]}>
                  📅 {item.check_in} (12 PM) → {item.check_out} (12 PM)
                </Text>

                <View style={{ marginVertical: spacing.xs, gap: 4 }}>
                  {(item.booking_guests || []).map((g: any, i: number) => {
                    const name = guestNameOf(g, i);
                    const unit = guestUnitOf(g);
                    const sNo = guestServiceNoOf(g);
                    return (
                      <View key={g.id || i} style={{ gap: 2 }}>
                        <Text style={{ fontWeight: '800', color: colors.navy, fontSize: typography.sm }}>
                          {name} ({g.rank_code})
                        </Text>
                        <Text style={{ fontSize: 12, color: colors.muted }}>
                          {[
                            unit && `Unit: ${unit}`,
                            sNo && `No: ${sNo}`,
                            g.guest_code && `[${g.guest_code}]`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </Text>
                      </View>
                    );
                  })}
                  <Text style={[styles.cellText, { color: colors.text, marginTop: 2, fontWeight: '600' }]}>
                    Room: {roomsOf(item)}
                  </Text>
                </View>
                {effectiveStatus === 'CONFIRMED' && (
                  <Badge
                    label={hasPending ? 'Guest details pending' : 'Guest details complete'}
                    variant={hasPending ? 'warning' : 'success'}
                  />
                )}
                {effectiveStatus === 'PENDING_ALLOTMENT' && (
                  <View style={{ marginTop: spacing.xs }}>
                    <Button
                      label="Choose Room & Assign Bed →"
                      variant="primary"
                      onPress={() => handleAllot(item)}
                      style={{ width: '100%' }}
                    />
                  </View>
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
  searchRow: {
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
  guestCodeBadge: {
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
  cardGuestsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexWrap: 'wrap',
    marginTop: 2,
  },
  guestLabelText: {
    fontSize: typography.xs,
    fontWeight: typography.weights.bold,
  },
});
