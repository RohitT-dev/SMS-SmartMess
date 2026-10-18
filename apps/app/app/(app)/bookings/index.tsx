import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RANKS } from '@sms/core';
import { useThemeStore } from '../../../src/state/themeStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Card } from '../../../src/ui/primitives/Card';
import { Table } from '../../../src/ui/primitives/Table';
import { Field } from '../../../src/ui/primitives/Field';
import { Select } from '../../../src/ui/primitives/Select';
import { Badge } from '../../../src/ui/primitives/Badge';
import { Button } from '../../../src/ui/primitives/Button';
import { Checkbox } from '../../../src/ui/primitives/Checkbox';
import { DateRange } from '../../../src/ui/primitives/DateRange';
import { spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';
import { logAction } from '../../../src/lib/activityLog';
import { addDaysToDateString, isValidDateString, localDateString } from '../../../src/lib/dates';
import { computeIdBlindIndex } from '../../../src/features/crypto-session/cryptoSession';
import { useRoomNames } from '../../../src/features/rooms/useRoomNames';
import { fetchPendingAllotment } from '../../../src/features/bookings/pendingRequests';
import {
  guestDetailLine,
  guestName,
  guestPhone,
  guestRankedName,
  guestServiceNumber,
  guestUnit,
  realGuestName,
} from '../../../src/features/bookings/guestDisplay';
import {
  ALL,
  effectiveBookingStatus,
  filterBookings,
  type BookingFilters,
  type SearchableBooking,
} from '../../../src/features/bookings/searchBookings';
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

type LedgerBooking = SearchableBooking & Record<string, any>;

const PAGE_SIZE = 15;
const SEARCH_DEBOUNCE_MS = 300;
/** Searching and filtering load the bookings themselves (room names are encrypted, so rooms cannot be matched in SQL). */
const CORPUS_PAGE = 1000;
const CORPUS_MAX_PAGES = 3;
const LEDGER_SELECT = '*, booking_guests(*), allocations(*)';

async function fetchSearchCorpus(): Promise<LedgerBooking[]> {
  const rows: LedgerBooking[] = [];
  for (let page = 0; page < CORPUS_MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from('bookings')
      .select(LEDGER_SELECT)
      .order('created_at', { ascending: false })
      .range(page * CORPUS_PAGE, (page + 1) * CORPUS_PAGE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as LedgerBooking[]));
    if (!data || data.length < CORPUS_PAGE) break;
  }
  return rows;
}

/**
 * Booking ids the server matched: guest code, rank, booking id, status and dates (and personal
 * details for users allowed to reveal them), plus an exact ID-number match through the blind
 * index. Best effort: the on-screen search already covers everything that is loaded.
 */
async function fetchServerHits(q: string): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const { data } = await supabase.rpc('search_bookings_and_guests', { p_query: q });
    if (Array.isArray(data)) data.forEach((r: any) => r?.booking_id && ids.add(r.booking_id));
  } catch {
    // The list still searches what is loaded.
  }
  if (q.replace(/\s/g, '').length >= 6) {
    try {
      const { data } = await supabase.rpc('search_guests_by_blind_index', { p_blind: computeIdBlindIndex(q) });
      if (Array.isArray(data)) data.forEach((r: any) => r?.booking_id && ids.add(r.booking_id));
    } catch {
      // Session locked, no permission to reveal ID numbers, or not an ID number.
    }
  }
  return [...ids];
}

export default function BookingsLedgerScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const colors = useThemeStore((s) => s.colors);
  const { width } = useWindowDimensions();
  const { data: roomNames } = useRoomNames();
  // Wide screens get the table; anything narrower gets cards so Status/Action are never off-screen.
  const useCards = width < 960;

  const roomsOf = (item: any): string => {
    if (item.status === 'PENDING_ALLOTMENT') return 'Pending Allotment';
    const names = new Set<string>();
    (item.allocations || [])
      .filter((a: any) => a.status === 'ACTIVE')
      .forEach((a: any) => names.add(roomNames?.[a.room_id] ?? '…'));
    return names.size ? [...names].join(', ') : '—';
  };

  const sortedGuests = (item: any): any[] =>
    [...(item.booking_guests || [])].sort((a: any, b: any) => (a.seq ?? 0) - (b.seq ?? 0));

  const getEffectiveBookingStatus = effectiveBookingStatus;

  const today = localDateString();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchQueryApplied, setSearchQueryApplied] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [rankFilter, setRankFilter] = useState(ALL);
  const [roomFilter, setRoomFilter] = useState(ALL);
  const [dateFilterOn, setDateFilterOn] = useState(false);
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(addDaysToDateString(today, 7));
  const [page, setPage] = useState(0);

  // Typing searches as you go; Enter or the Search button applies it immediately.
  useEffect(() => {
    const timer = setTimeout(() => setSearchQueryApplied(searchQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const dateRangeValid = isValidDateString(dateFrom) && isValidDateString(dateTo) && dateTo >= dateFrom;
  const dateFilterApplied = dateFilterOn && dateRangeValid;

  // Anything beyond category and status is matched on the loaded bookings; category and status
  // alone keep using the paged server query.
  const clientMode =
    Boolean(searchQueryApplied) || rankFilter !== ALL || roomFilter !== ALL || dateFilterApplied;
  const anyFilter =
    clientMode || Boolean(searchQuery.trim()) || categoryFilter !== 'ALL' || statusFilter !== 'ALL' || dateFilterOn;

  const filterKey = [searchQueryApplied, categoryFilter, statusFilter, rankFilter, roomFilter, dateFilterApplied ? `${dateFrom}|${dateTo}` : ''].join('~');
  useEffect(() => {
    setPage(0);
  }, [filterKey]);

  useEffect(() => {
    if (searchQueryApplied) {
      // The query can be a name, phone number or ID: log only its length.
      logAction('bookings.search', { meta: { query_length: searchQueryApplied.length } });
    }
  }, [searchQueryApplied]);

  const handleSearch = () => setSearchQueryApplied(searchQuery.trim());

  const handleClearFilters = () => {
    setSearchQuery('');
    setSearchQueryApplied('');
    setCategoryFilter('ALL');
    setStatusFilter('ALL');
    setRankFilter(ALL);
    setRoomFilter(ALL);
    setDateFilterOn(false);
    setPage(0);
  };

  // Server-paged list: used while only category/status are chosen.
  const {
    data: listRows,
    isLoading: listLoading,
  } = useQuery({
    queryKey: ['bookings_ledger', 'list', categoryFilter, statusFilter, page],
    enabled: !clientMode,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<LedgerBooking[]> => {
      // "Pending allotment" includes confirmed bookings that hold no bed, which no single server
      // filter can express. Fetch that bounded set and page it here, so every page is full and
      // the Next button never hides rows.
      if (statusFilter === 'PENDING_ALLOTMENT') {
        // (fetchPendingAllotment adds the allocations itself.)
        let list = await fetchPendingAllotment<any>('*, booking_guests(*)');
        if (categoryFilter !== 'ALL') list = list.filter((b: any) => b.category === categoryFilter);
        return list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      }

      // CONFIRMED means "has an active bed": an inner join on ACTIVE allocations filters on the
      // server, so pagination counts only matching rows.
      const confirmedOnly = statusFilter === 'CONFIRMED';
      let query = supabase
        .from('bookings')
        .select(
          confirmedOnly
            ? '*, booking_guests(*), allocations!inner(*, rooms(*))'
            : '*, booking_guests(*), allocations(*, rooms(*))',
          { count: 'exact' },
        )
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      if (categoryFilter !== 'ALL') {
        query = query.eq('category', categoryFilter);
      }
      if (confirmedOnly) {
        query = query.eq('status', 'CONFIRMED').eq('allocations.status', 'ACTIVE');
      } else if (statusFilter !== 'ALL') {
        query = query.eq('status', statusFilter);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as LedgerBooking[];
    },
  });

  // Search / rank / room / date filters: the bookings are loaded once and matched here.
  const {
    data: corpus,
    isLoading: corpusLoading,
    error: corpusError,
  } = useQuery({
    queryKey: ['bookings_ledger', 'corpus'],
    enabled: clientMode,
    queryFn: fetchSearchCorpus,
  });

  const { data: serverHits } = useQuery({
    queryKey: ['bookings_ledger', 'server_hits', searchQueryApplied],
    enabled: Boolean(searchQueryApplied),
    queryFn: () => fetchServerHits(searchQueryApplied),
    staleTime: 30_000,
  });

  // Server matches older than the loaded window (only possible with a very long history).
  const missingHitIds = useMemo(() => {
    if (!corpus || !serverHits) return [];
    const have = new Set(corpus.map((b) => b.id));
    return serverHits.filter((id) => !have.has(id)).slice(0, 100);
  }, [corpus, serverHits]);

  const { data: olderHits } = useQuery({
    queryKey: ['bookings_ledger', 'older_hits', missingHitIds.join(',')],
    enabled: missingHitIds.length > 0,
    queryFn: async (): Promise<LedgerBooking[]> => {
      const { data, error } = await supabase.from('bookings').select(LEDGER_SELECT).in('id', missingHitIds);
      if (error) throw error;
      return (data ?? []) as LedgerBooking[];
    },
  });

  const filters: BookingFilters = useMemo(
    () => ({
      text: searchQueryApplied,
      category: categoryFilter,
      status: statusFilter,
      rank: rankFilter,
      roomId: roomFilter,
      dateFrom: dateFilterApplied ? dateFrom : undefined,
      dateTo: dateFilterApplied ? dateTo : undefined,
    }),
    [searchQueryApplied, categoryFilter, statusFilter, rankFilter, roomFilter, dateFilterApplied, dateFrom, dateTo],
  );

  const matches = useMemo<LedgerBooking[] | null>(() => {
    if (!clientMode || !corpus) return null;
    const pool = olderHits?.length
      ? [...corpus, ...olderHits].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
      : corpus;
    return filterBookings(pool, filters, {
      roomNames,
      serverHitIds: serverHits ? new Set(serverHits) : null,
    });
  }, [clientMode, corpus, olderHits, filters, roomNames, serverHits]);

  const bookings: LedgerBooking[] = clientMode
    ? (matches ?? []).slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    : (listRows ?? []);
  const isLoading = clientMode ? corpusLoading : listLoading;
  const hasNextPage = clientMode ? (page + 1) * PAGE_SIZE < (matches?.length ?? 0) : (listRows?.length ?? 0) >= PAGE_SIZE;
  const searchError = clientMode && corpusError ? userErrorMessage(corpusError, 'Search failed.') : null;

  const rankOptions = useMemo(
    () => [
      { label: 'All ranks', value: ALL },
      ...[...RANKS].reverse().map((r) => ({ label: r.label, value: r.code as string })),
      { label: 'Civilian companions', value: 'CIVILIAN' },
    ],
    [],
  );

  const roomOptions = useMemo(() => {
    const named = Object.entries(roomNames ?? {})
      .filter(([, name]) => name && name !== 'Locked' && name !== 'Decryption Error')
      .sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }))
      .map(([id, name]) => ({ label: name, value: id }));
    return [{ label: 'All rooms', value: ALL }, ...named];
  }, [roomNames]);

  useFocusEffect(
    useCallback(() => {
      queryClient.invalidateQueries({ queryKey: ['bookings_ledger'] });
    }, [queryClient]),
  );

  const handleAllot = (item: any) => {
    const payload = JSON.stringify({
      bookingId: item.id,
      category: item.category,
      checkIn: item.check_in,
      checkOut: item.check_out,
      preferredRoomType: item.preferred_room_type || undefined,
      guests: sortedGuests(item).map((g: any) => ({
        gender: g.gender || 'M',
        rankCode: g.rank_code ?? null,
        relation: g.relation ?? undefined,
        // Only real names travel on; the "Guest (GST-…)" stand-in must never be saved as a name.
        name: realGuestName(g.guest_name) || undefined,
        serviceNumber: guestServiceNumber(g) || undefined,
        unit: guestUnit(g) || undefined,
        phone: guestPhone(g) || undefined,
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
      header: 'Guest Name, Rank & Unit',
      width: 300,
      render: (item: any) => {
        const guests = sortedGuests(item);
        if (!guests.length) return <Text style={[styles.cellText, { color: colors.muted }]}>—</Text>;
        return (
          <View style={{ gap: 6 }}>
            {guests.map((g: any, i: number) => (
              <View key={g.id || i} style={{ gap: 1 }}>
                <Text style={[styles.cellText, { fontWeight: '700', color: colors.navy }]}>
                  {guestName(g, null, i)}
                </Text>
                <Text style={{ fontSize: 12, color: colors.muted }}>
                  {guestDetailLine(g, null, { includeCode: true })}
                </Text>
              </View>
            ))}
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

        <View style={styles.filterRow}>
          <View style={{ flex: 1 }}>
            <Select
              label="Filter Rank"
              value={rankFilter}
              onChange={setRankFilter}
              options={rankOptions}
              variant="dropdown"
            />
          </View>

          <View style={{ flex: 1 }}>
            <Select
              label="Filter Room"
              value={roomFilter}
              onChange={setRoomFilter}
              options={roomOptions}
              variant="dropdown"
            />
          </View>
        </View>

        <Checkbox
          label="Only stays on these dates"
          hint="Shows bookings whose stay overlaps the dates, including check-in and check-out days."
          checked={dateFilterOn}
          onChange={setDateFilterOn}
        />
        {dateFilterOn ? (
          <View style={{ marginTop: spacing.sm }}>
            <DateRange
              startDate={dateFrom}
              endDate={dateTo}
              onStartDateChange={setDateFrom}
              onEndDateChange={setDateTo}
              startLabel="Stay from"
              endLabel="Stay to"
              inclusive
              hideNights
            />
          </View>
        ) : null}

        <View style={styles.searchRow}>
          <View style={{ flex: 1 }}>
            <Field
              label="Search Bookings & Guests"
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Name, rank, unit, service no, phone, guest ID, room, date..."
              returnKeyType="search"
              onSubmitEditing={handleSearch}
              hint='Results update as you type. Try a name, "Flight Lieutenant", a unit, a service number, a phone number, GST-1053, a room name, "pending", "2026-10-18" or "3 guests".'
            />
          </View>
          <Button label="Search" variant="secondary" onPress={handleSearch} style={{ marginTop: 26 }} />
          {anyFilter ? (
            <Button label="Clear filters" variant="destructive" onPress={handleClearFilters} style={{ marginTop: 26 }} />
          ) : null}
        </View>
        {searchError && <Banner type="error" message={searchError} />}
        {clientMode && matches ? (
          <Banner
            type={matches.length === 0 ? 'warning' : 'info'}
            message={
              matches.length === 0
                ? searchQueryApplied
                  ? `No bookings match "${searchQueryApplied}" with the selected filters.`
                  : 'No bookings match the selected filters.'
                : `Showing ${page * PAGE_SIZE + 1}-${Math.min((page + 1) * PAGE_SIZE, matches.length)} of ${matches.length} booking${matches.length === 1 ? '' : 's'}${searchQueryApplied ? ` matching "${searchQueryApplied}"` : ''}.`
            }
          />
        ) : null}
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
                  {sortedGuests(item).map((g: any, i: number) => (
                    <View key={g.id || i} style={{ gap: 2 }}>
                      <Text style={{ fontWeight: '800', color: colors.navy, fontSize: typography.sm }}>
                        {guestRankedName(g, null, i)}
                      </Text>
                      <Text style={{ fontSize: 12, color: colors.muted }}>
                        {[
                          guestUnit(g) && `Unit: ${guestUnit(g)}`,
                          guestServiceNumber(g) && `No: ${guestServiceNumber(g)}`,
                          g.guest_code && `[${g.guest_code}]`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </View>
                  ))}
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
          disabled={!hasNextPage}
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
