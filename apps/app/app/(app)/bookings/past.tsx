import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useThemeStore } from '../../../src/state/themeStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Card } from '../../../src/ui/primitives/Card';
import { Button } from '../../../src/ui/primitives/Button';
import { Badge } from '../../../src/ui/primitives/Badge';
import { Select } from '../../../src/ui/primitives/Select';
import { EmptyState } from '../../../src/ui/primitives/EmptyState';
import { layout, spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';
import { localDateString } from '../../../src/lib/dates';
import { useRoomNames } from '../../../src/features/rooms/useRoomNames';
import {
  guestName,
  guestPhone,
  guestRankOrRelation,
  guestServiceNumber,
  guestUnit,
} from '../../../src/features/bookings/guestDisplay';
import { filterBookings } from '../../../src/features/bookings/searchBookings';
import type { PastBookingGuestItem, PastBookingPdfItem } from '../../../src/features/reports/pastBookingsHtml';
import { STAY_STATUS_LABELS, stayStatus } from '../../../src/features/reports/guestReport';
import type { Category } from '@sms/core';

interface RawBookingRow {
  id: string;
  category: Category;
  status: string;
  check_in: string;
  check_out: string;
  party_size: number;
  created_at: string;
  booking_guests?: Array<{
    id: string;
    seq: number;
    gender: string;
    rank_code: string | null;
    relation?: string | null;
    guest_code?: string;
    guest_name?: string | null;
    unit?: string | null;
    service_number?: string | null;
    phone?: string | null;
  }>;
  allocations?: Array<{
    id: string;
    room_id: string;
    bed_slot: number;
    status: string;
  }>;
}

/** One person on a past booking: full rank (or relation), plain unit, service number, phone. */
interface PastGuestLine extends PastBookingGuestItem {
  name: string;
  rank: string;
  unit: string;
  serviceNumber: string;
  phone: string;
}

/** A register row: the PDF row, with every guest of the party present. */
type PastBookingItem = Omit<PastBookingPdfItem, 'guests'> & { guests: PastGuestLine[] };

export default function PastBookingsScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const today = localDateString();

  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');

  const { data: roomNames } = useRoomNames();

  // Query past bookings: check_out <= today OR status IN ('COMPLETED', 'CANCELLED')
  const { data: rawBookings, isLoading, refetch } = useQuery({
    queryKey: ['past_bookings_list', today],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('bookings')
        .select('*, booking_guests(*), allocations(*)')
        .or(`check_out.lte.${today},status.in.(COMPLETED,CANCELLED)`)
        .order('check_out', { ascending: false });

      if (error) throw error;
      return (data || []) as RawBookingRow[];
    },
  });

  // Every row, with the first guest's name, full rank and unit for the register and the PDF.
  const items: PastBookingItem[] = useMemo(() => {
    if (!rawBookings) return [];
    return rawBookings.map((b) => {
      const ordered = [...(b.booking_guests ?? [])].sort((x, y) => x.seq - y.seq);
      const guests: PastGuestLine[] = ordered.map((g, i) => ({
        name: guestName(g, null, i),
        rank: guestRankOrRelation(g),
        unit: guestUnit(g),
        serviceNumber: guestServiceNumber(g),
        phone: guestPhone(g),
      }));
      const first = guests[0];

      // Calculate stay duration
      const nights = Math.max(
        1,
        Math.round((Date.parse(b.check_out) - Date.parse(b.check_in)) / 86400000)
      );

      // Rooms string
      const roomStrs = (b.allocations || [])
        .filter((al) => al.status === 'ACTIVE' || al.status === 'RELEASED')
        .map((al) => {
          const rName = roomNames?.[al.room_id] || `Room ${al.room_id.slice(0, 4)}`;
          return `${rName} (Bed ${al.bed_slot})`;
        });
      const uniqueRooms = Array.from(new Set(roomStrs)).join(', ');

      return {
        id: b.id,
        category: b.category,
        checkIn: b.check_in,
        checkOut: b.check_out,
        nights,
        partySize: b.party_size,
        status: b.status,
        guestName: first?.name ?? 'Guest',
        guestRank: first?.rank ?? '',
        serviceNumber: first?.serviceNumber || null,
        unit: first?.unit || null,
        rooms: uniqueRooms || 'None',
        guests,
      };
    });
  }, [rawBookings, roomNames]);

  // Search: name, full rank, unit, service number, phone, guest ID, booking ID, category, status,
  // dates (2026-10-18, 18/10/2026, 18 Oct), party size and room names, across the whole party.
  const filteredItems = useMemo(() => {
    if (!rawBookings) return [];
    const hits = new Set(
      filterBookings(
        rawBookings,
        { text: searchQuery, category: categoryFilter },
        { roomNames, allocationStatuses: ['ACTIVE', 'RELEASED'] },
      ).map((b) => b.id),
    );
    return items.filter((item) => hits.has(item.id));
  }, [rawBookings, items, searchQuery, categoryFilter, roomNames]);

  // Printing goes through the guest report, which has its own filters (room type, category,
  // unit, dates, status); it opens on completed stays, in the category chosen here.
  const openGuestReport = () => {
    const category = categoryFilter === 'ALL' ? '' : `&category=${categoryFilter}`;
    router.push(`/(app)/reports/guests?preset=past${category}` as any);
  };

  return (
    <Screen title="Past Bookings" showBack={true}>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        {/* Top Header Card */}
        <Card style={styles.topCard}>
          <View style={styles.topHeaderRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: colors.navy }]}>Past Stays Register</Text>
              <Text style={[styles.subtitle, { color: colors.muted }]}>
                Archived history of completed stays and past mess visits
              </Text>
            </View>
            <Button label="📄 Print guest report" variant="primary" onPress={openGuestReport} />
          </View>

          {/* Stats Row */}
          <View style={styles.statsGrid}>
            <View style={[styles.statBox, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
              <Text style={[styles.statLabel, { color: colors.muted }]}>PAST BOOKINGS</Text>
              <Text style={[styles.statVal, { color: colors.navy }]}>{items.length}</Text>
            </View>
            <View style={[styles.statBox, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
              <Text style={[styles.statLabel, { color: colors.muted }]}>FILTERED</Text>
              <Text style={[styles.statVal, { color: colors.saffron }]}>{filteredItems.length}</Text>
            </View>
            <View style={[styles.statBox, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
              <Text style={[styles.statLabel, { color: colors.muted }]}>TOTAL NIGHTS</Text>
              <Text style={[styles.statVal, { color: colors.navy }]}>
                {filteredItems.reduce((acc, x) => acc + x.nights, 0)}
              </Text>
            </View>
          </View>

          {/* Search & Category Filter */}
          <View style={styles.filterRow}>
            <View style={{ flex: 2, minWidth: 200 }}>
              <Text style={[styles.filterLabel, { color: colors.muted }]}>Search Records</Text>
              <TextInput
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Name, rank, unit, service no, phone, room, date..."
                placeholderTextColor={colors.muted}
                style={[
                  styles.searchInput,
                  {
                    backgroundColor: colors.surface,
                    borderColor: colors.borderStrong,
                    color: colors.text,
                  },
                ]}
              />
            </View>

            <View style={{ flex: 1, minWidth: 140 }}>
              <Select
                label="Category"
                value={categoryFilter}
                onChange={setCategoryFilter}
                options={[
                  { label: 'All Categories', value: 'ALL' },
                  { label: 'MFA', value: 'MFA' },
                  { label: 'PI', value: 'PI' },
                  { label: 'LEAVE', value: 'LEAVE' },
                  { label: 'TD', value: 'TD' },
                ]}
              />
            </View>
          </View>
        </Card>

        {/* List of Past Bookings */}
        {isLoading ? (
          <View style={{ padding: spacing.xl, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={colors.navy} />
            <Text style={{ marginTop: spacing.sm, color: colors.muted }}>Loading past bookings...</Text>
          </View>
        ) : filteredItems.length === 0 ? (
          <EmptyState
            title="No Past Bookings Found"
            description={
              searchQuery || categoryFilter !== 'ALL'
                ? 'Try clearing your search or category filter.'
                : 'Completed bookings will appear here once guests depart.'
            }
          />
        ) : (
          <View style={styles.list}>
            {filteredItems.map((item) => (
              <Pressable
                key={item.id}
                onPress={() => router.push(`/(app)/bookings/${item.id}` as any)}
                style={({ pressed }) => [
                  styles.bookingCard,
                  {
                    backgroundColor: pressed ? colors.surfaceAlt : colors.surface,
                    borderColor: colors.border,
                  },
                ]}
              >
                <View style={styles.cardHeader}>
                  <View style={styles.cardHeaderLeft}>
                    <Text style={[styles.bookingId, { color: colors.navy }]}>
                      #{item.id.slice(0, 8)}
                    </Text>
                    <Badge label={item.category} variant={item.category === 'MFA' ? 'navy' : 'neutral'} />
                    {/* Nothing marks a booking COMPLETED, so an ended CONFIRMED stay shows as Completed. */}
                    <Badge
                      label={STAY_STATUS_LABELS[stayStatus(item.status, item.checkIn, item.checkOut, today)]}
                      variant={item.status === 'CONFIRMED' || item.status === 'COMPLETED' ? 'green' : 'neutral'}
                    />
                  </View>
                  <Text style={[styles.nightsBadge, { color: colors.muted }]}>
                    {item.nights} night{item.nights === 1 ? '' : 's'}
                  </Text>
                </View>

                <View style={styles.cardBody}>
                  {item.guests.map((g, i) => (
                    <View key={i} style={i > 0 ? { marginTop: spacing.xs } : undefined}>
                      <Text style={[styles.guestName, { color: colors.text }]}>
                        {g.name}
                        {g.rank ? <Text style={{ fontWeight: '600', color: colors.muted }}> · {g.rank}</Text> : null}
                      </Text>
                      {g.unit || g.serviceNumber || g.phone ? (
                        <Text style={[styles.guestMeta, { color: colors.muted }]}>
                          {[g.unit && `Unit: ${g.unit}`, g.serviceNumber && `No: ${g.serviceNumber}`, g.phone && `Ph: ${g.phone}`]
                            .filter(Boolean)
                            .join(' · ')}
                        </Text>
                      ) : null}
                    </View>
                  ))}

                  <View style={styles.detailsRow}>
                    <View style={styles.detailCol}>
                      <Text style={[styles.detailLabel, { color: colors.muted }]}>STAY PERIOD</Text>
                      <Text style={[styles.detailValue, { color: colors.text }]}>
                        {item.checkIn} → {item.checkOut}
                      </Text>
                    </View>
                    <View style={styles.detailCol}>
                      <Text style={[styles.detailLabel, { color: colors.muted }]}>ROOMS ALLOTTED</Text>
                      <Text style={[styles.detailValue, { color: colors.text }]}>
                        {item.rooms}
                      </Text>
                    </View>
                  </View>
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.md,
    gap: spacing.md,
  },
  topCard: {
    padding: spacing.md,
  },
  topHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
    flexWrap: 'wrap',
    marginBottom: spacing.md,
  },
  title: {
    fontSize: typography.lg,
    fontWeight: '800',
  },
  subtitle: {
    fontSize: typography.xs,
    marginTop: 2,
  },
  statsGrid: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  statBox: {
    flex: 1,
    padding: spacing.sm,
    borderRadius: layout.borderRadius,
    borderWidth: 1,
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  statVal: {
    fontSize: typography.md,
    fontWeight: '800',
    marginTop: 2,
  },
  filterRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    flexWrap: 'wrap',
    alignItems: 'flex-end',
  },
  filterLabel: {
    fontSize: typography.xs,
    marginBottom: 4,
    fontWeight: '600',
  },
  searchInput: {
    height: layout.minTouchTarget,
    borderWidth: layout.borderWidth,
    borderRadius: layout.borderRadius,
    paddingHorizontal: spacing.sm,
    fontSize: typography.sm,
  },
  list: {
    gap: spacing.sm,
  },
  bookingCard: {
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    padding: spacing.md,
    gap: spacing.xs,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  bookingId: {
    fontSize: typography.sm,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginRight: spacing.xs,
  },
  nightsBadge: {
    fontSize: typography.xs,
    fontWeight: '600',
  },
  cardBody: {
    marginTop: spacing.xs,
  },
  guestName: {
    fontSize: typography.md,
    fontWeight: '700',
  },
  guestMeta: {
    fontSize: typography.xs,
    marginTop: 2,
  },
  detailsRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#DDE2E8',
  },
  detailCol: {
    flex: 1,
  },
  detailLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  detailValue: {
    fontSize: typography.xs,
    fontWeight: '600',
    marginTop: 2,
  },
});
