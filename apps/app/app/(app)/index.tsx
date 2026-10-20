import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useThemeStore } from '../../src/state/themeStore';
import { Screen } from '../../src/ui/primitives/Screen';
import { Stat } from '../../src/ui/primitives/Stat';
import { Tile } from '../../src/ui/primitives/Tile';
import { Select } from '../../src/ui/primitives/Select';
import { Card } from '../../src/ui/primitives/Card';
import { Banner } from '../../src/ui/primitives/Banner';
import { Button } from '../../src/ui/primitives/Button';
import { Skeleton } from '../../src/ui/primitives/Skeleton';
import { EmptyState } from '../../src/ui/primitives/EmptyState';
import { spacing, typography } from '../../src/ui/tokens';
import { supabase } from '../../src/lib/supabase';
import { useRoomNames } from '../../src/features/rooms/useRoomNames';
import { RoomBedMap } from '../../src/features/rooms/RoomBedMap';
import { roomAvailability } from '../../src/features/rooms/bedLayout';
import { Segmented } from '../../src/ui/primitives/Segmented';
import { addDaysToDateString, localDateString } from '../../src/lib/dates';
import { rankLabel } from '../../src/features/bookings/guestDisplay';

interface TileOccupant {
  category: string;
  gender: string;
  rankCode: string | null;
}

/** "LEAVE · M/Flying Officer ×2" when both beds hold the same profile, otherwise one entry per guest. */
function summarizeOccupants(occupants: TileOccupant[] | undefined): string | undefined {
  if (!occupants?.length) return undefined;
  const counts = new Map<string, number>();
  for (const o of occupants) {
    const key = `${o.category} · ${o.gender}/${o.rankCode ? rankLabel(o.rankCode) : 'Civilian'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join('\n');
}

const GROUP_LABELS: Record<string, string> = {
  VIP: 'VIP rooms',
  SEMI_VIP: 'Semi VIP rooms',
  NORMAL: 'Normal rooms',
};

export default function DashboardScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const queryClient = useQueryClient();

  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  const todayStr = localDateString();
  const { data: roomNames } = useRoomNames();
  const [view, setView] = useState<'map' | 'tiles'>('map');
  // Day shown by the bed map / tiles; the summary strip always reports today.
  const [viewDate, setViewDate] = useState<string>(todayStr);

  // 1. Fetch dashboard counts
  const {
    data: counts,
    isLoading: countsLoading,
    refetch: refetchCounts,
  } = useQuery({
    queryKey: ['dashboard_counts', todayStr],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('dashboard_counts', { p_date: todayStr });
      if (error) throw error;
      return (
        data?.[0] || {
          free_rooms: 0,
          one_bed_free_rooms: 0,
          full_rooms: 0,
          out_of_service_rooms: 0,
          people_in_house: 0,
          pending_details_count: 0,
          arrivals_today: 0,
        }
      );
    },
  });

  // 2. Fetch daily room state for the selected day
  const {
    data: roomStates,
    isLoading: roomsLoading,
    refetch: refetchRoomStates,
  } = useQuery({
    queryKey: ['daily_room_state', viewDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('daily_room_state', {
        p_from: viewDate,
        p_to: addDaysToDateString(viewDate, 1),
      });
      if (error) throw error;

      return (data || []).map((row: any) => ({
        ...row,
        // A room held by a booking that does not allow sharing is full: it has no bookable bed.
        status: roomAvailability(row),
      }));
    },
  });

  // Real-time re-fetch whenever user views or returns to this screen
  useFocusEffect(
    useCallback(() => {
      refetchCounts();
      refetchRoomStates();
    }, [refetchCounts, refetchRoomStates])
  );

  // Realtime subscription setup
  const channelNameRef = useRef(`dashboard-realtime-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const channel = supabase
      .channel(channelNameRef.current)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'allocations' }, () => {
        queryClient.invalidateQueries({ queryKey: ['dashboard_counts'] });
        queryClient.invalidateQueries({ queryKey: ['daily_room_state'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, () => {
        queryClient.invalidateQueries({ queryKey: ['dashboard_counts'] });
        queryClient.invalidateQueries({ queryKey: ['daily_room_state'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'booking_guests' }, () => {
        queryClient.invalidateQueries({ queryKey: ['dashboard_counts'] });
        queryClient.invalidateQueries({ queryKey: ['daily_room_state'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, () => {
        queryClient.invalidateQueries({ queryKey: ['dashboard_counts'] });
        queryClient.invalidateQueries({ queryKey: ['daily_room_state'] });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  // Filter rooms
  const filteredRooms = (roomStates || []).filter((r: any) => {
    if (typeFilter !== 'ALL' && r.room_type !== typeFilter) return false;
    if (statusFilter !== 'ALL' && r.status !== statusFilter) return false;
    return true;
  });

  // Group rooms by type
  const roomGroups = ['VIP', 'SEMI_VIP', 'NORMAL'].map((type) => ({
    type,
    rooms: filteredRooms.filter((r: any) => r.room_type === type),
  }));

  return (
    <Screen title="Live Room Inventory">
      {/* 1. Summary Strip */}
      {countsLoading ? (
        <View style={styles.statsStrip}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} width={140} height={56} />
          ))}
        </View>
      ) : (
        <View style={styles.statsStrip}>
          <Stat label="Free rooms" value={counts?.free_rooms ?? 0} indicatorColor={colors.green} />
          {/* Occupied rooms, shared or not: partly free plus full. */}
          <Stat
            label="Occupied"
            value={(counts?.one_bed_free_rooms ?? 0) + (counts?.full_rooms ?? 0)}
            indicatorColor={colors.orange}
          />
          <Stat
            label="Out of service"
            value={counts?.out_of_service_rooms ?? 0}
            indicatorColor={colors.grey}
          />
          <Stat
            label="People in house"
            value={counts?.people_in_house ?? 0}
            indicatorColor={colors.navy}
          />
        </View>
      )}

      {/* 2. Needs Attention Strip */}
      {counts?.pending_details_count || counts?.arrivals_today ? (
        <View style={styles.attentionRow}>
          <Banner
            message={`${counts?.arrivals_today || 0} arrivals today, ${counts?.pending_details_count || 0} guests with details pending.`}
            type="warning"
            actionLabel="Open ledger"
            onAction={() => router.push('/bookings')}
          />
        </View>
      ) : null}

      {/* 3. Action bar & Filters */}
      <View style={{ marginBottom: spacing.sm, flexDirection: 'row', justifyContent: 'flex-end' }}>
        <Button
          label="📅 Room Occupancy Grid Matrix (Custom Dates & PDF)"
          variant="secondary"
          onPress={() => router.push('/(app)/reports/grid' as any)}
        />
      </View>

      <Card style={styles.filterCard}>
        <View style={styles.filterRow}>
          <View style={{ flex: 1, minWidth: 200 }}>
            <Select
              label="Room Type"
              selectedValue={typeFilter}
              onValueChange={setTypeFilter}
              options={[
                { label: 'All Types', value: 'ALL' },
                { label: 'VIP', value: 'VIP' },
                { label: 'Semi VIP', value: 'SEMI_VIP' },
                { label: 'Normal', value: 'NORMAL' },
              ]}
            />
          </View>

          <View style={{ flex: 1, minWidth: 200 }}>
            <Select
              label="Availability Status"
              selectedValue={statusFilter}
              onValueChange={setStatusFilter}
              options={[
                { label: 'All Statuses', value: 'ALL' },
                { label: 'Free', value: 'free' },
                { label: '1 Bed Free', value: 'one_bed_free' },
                { label: 'Full', value: 'full' },
                { label: 'Out of Service', value: 'out_of_service' },
              ]}
            />
          </View>
        </View>
      </Card>

      {/* 4. View switch and day */}
      <View style={styles.viewBar}>
        <View style={{ minWidth: 220 }}>
          <Segmented
            accessibilityLabel="Room view"
            value={view}
            onChange={setView}
            options={[
              { label: 'Bed map', value: 'map' },
              { label: 'Room tiles', value: 'tiles' },
            ]}
          />
        </View>
        <View style={styles.dayStepper}>
          <Button
            label="‹"
            variant="secondary"
            accessibilityLabel="Previous day"
            disabled={viewDate <= todayStr}
            onPress={() => setViewDate(addDaysToDateString(viewDate, -1))}
          />
          <Text style={[styles.dayLabel, { color: colors.navy }]} accessibilityLiveRegion="polite">
            {viewDate === todayStr ? `Today · ${viewDate}` : viewDate}
          </Text>
          <Button
            label="›"
            variant="secondary"
            accessibilityLabel="Next day"
            onPress={() => setViewDate(addDaysToDateString(viewDate, 1))}
          />
          {viewDate !== todayStr && (
            <Button label="Today" variant="secondary" onPress={() => setViewDate(todayStr)} />
          )}
        </View>
      </View>

      {/* 5. Rooms: bed map or tiles grouped by type */}
      {roomsLoading ? (
        <View style={styles.tilesGrid}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} width={160} height={90} />
          ))}
        </View>
      ) : filteredRooms.length === 0 ? (
        <EmptyState
          title="No rooms match these filters"
          description="Change the day, room type or availability filter to see more rooms."
        />
      ) : view === 'map' ? (
        <RoomBedMap
          rooms={filteredRooms}
          roomNames={roomNames}
          onOpenRoom={(roomId) => router.push(`/rooms/${roomId}`)}
          onBookBed={() =>
            router.push({
              pathname: '/bookings/new',
              params: { initialCheckIn: viewDate, initialCheckOut: addDaysToDateString(viewDate, 1) },
            } as any)
          }
        />
      ) : (
        roomGroups.map((group) => {
          if (group.rooms.length === 0) return null;
          return (
            <View key={group.type} style={styles.groupContainer}>
              <View style={[styles.groupHeaderRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.groupHeader, { color: colors.navy }]} accessibilityRole="header">
                  {GROUP_LABELS[group.type]}
                </Text>
                <Text style={[styles.groupCount, { color: colors.muted }]}>
                  {group.rooms.length} {group.rooms.length === 1 ? 'room' : 'rooms'}
                </Text>
              </View>
              <View style={styles.tilesGrid}>
                {group.rooms.map((r: any) => (
                  <Tile
                    key={r.room_id}
                    roomName={roomNames?.[r.room_id] ?? '…'}
                    roomType={r.room_type}
                    status={r.status}
                    occupantSummary={summarizeOccupants(r.occupants)}
                    onPress={() => router.push(`/rooms/${r.room_id}`)}
                  />
                ))}
              </View>
            </View>
          );
        })
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  statsStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  attentionRow: {
    marginBottom: spacing.sm,
  },
  filterCard: {
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: spacing.md,
  },
  groupContainer: {
    marginBottom: spacing.xl,
  },
  groupHeaderRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    paddingBottom: spacing.xs,
    marginBottom: spacing.md,
  },
  groupHeader: {
    fontSize: typography.md,
    fontWeight: typography.weights.bold,
  },
  groupCount: {
    fontSize: typography.sm,
    ...typography.numeric,
  },
  viewBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  dayStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  dayLabel: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
    minWidth: 150,
    textAlign: 'center',
    ...typography.numeric,
  },
  tilesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
});
