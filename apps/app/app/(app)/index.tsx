import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useThemeStore } from '../../src/state/themeStore';
import { Screen } from '../../src/ui/primitives/Screen';
import { Stat } from '../../src/ui/primitives/Stat';
import { Tile } from '../../src/ui/primitives/Tile';
import { Select } from '../../src/ui/primitives/Select';
import { Card } from '../../src/ui/primitives/Card';
import { Banner } from '../../src/ui/primitives/Banner';
import { Skeleton } from '../../src/ui/primitives/Skeleton';
import { EmptyState } from '../../src/ui/primitives/EmptyState';
import { spacing, typography } from '../../src/ui/tokens';
import { supabase } from '../../src/lib/supabase';
import { useRoomNames } from '../../src/features/rooms/useRoomNames';
import { addDaysToDateString, localDateString } from '../../src/lib/dates';
import type { RoomAvailabilityStatus } from '@sms/core';

interface TileOccupant {
  category: string;
  gender: string;
  rankCode: string;
}

/** "LEAVE · M/FO ×2" when both beds hold the same profile, otherwise one entry per guest. */
function summarizeOccupants(occupants: TileOccupant[] | undefined): string | undefined {
  if (!occupants?.length) return undefined;
  const counts = new Map<string, number>();
  for (const o of occupants) {
    const key = `${o.category} · ${o.gender}/${o.rankCode}`;
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

  // 1. Fetch dashboard counts
  const { data: counts, isLoading: countsLoading } = useQuery({
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

  // 2. Fetch daily room state for today
  const { data: roomStates, isLoading: roomsLoading } = useQuery({
    queryKey: ['daily_room_state', todayStr],
    queryFn: async () => {
      const tomorrowStr = addDaysToDateString(todayStr, 1);

      const { data, error } = await supabase.rpc('daily_room_state', {
        p_from: todayStr,
        p_to: tomorrowStr,
      });
      if (error) throw error;

      return (data || []).map((row: any) => {
        let status: RoomAvailabilityStatus = 'free';
        if (row.is_closed) status = 'out_of_service';
        else if (row.beds_taken === 1) status = 'one_bed_free';
        else if (row.beds_taken === 2) status = 'full';

        return {
          ...row,
          status,
        };
      });
    },
  });

  // Realtime subscription setup
  // Unique per mount: a shared 'dashboard-realtime' topic races with dev-mode's
  // mount→cleanup→remount, since removeChannel() unsubscribes asynchronously and
  // the remount can reuse the still-subscribed channel before it's gone.
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
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} width={140} height={56} />
          ))}
        </View>
      ) : (
        <View style={styles.statsStrip}>
          <Stat label="Free rooms" value={counts?.free_rooms ?? 0} indicatorColor={colors.green} />
          <Stat
            label="1 bed free"
            value={counts?.one_bed_free_rooms ?? 0}
            indicatorColor={colors.blue}
          />
          <Stat label="Full" value={counts?.full_rooms ?? 0} indicatorColor={colors.orange} />
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

      {/* 3. Filters */}
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

      {/* 4. Rooms Grouped by Type as Tiles */}
      {roomsLoading ? (
        <View style={styles.tilesGrid}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} width={160} height={90} />
          ))}
        </View>
      ) : filteredRooms.length === 0 ? (
        <EmptyState
          title="No rooms match these filters"
          description="Change the room type or availability filter to see more rooms."
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
  tilesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
});
