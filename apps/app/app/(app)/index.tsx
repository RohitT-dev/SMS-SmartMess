import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useThemeStore } from '../../src/state/themeStore';
import { Screen } from '../../src/ui/primitives/Screen';
import { Stat } from '../../src/ui/primitives/Stat';
import { Tile } from '../../src/ui/primitives/Tile';
import { Select } from '../../src/ui/primitives/Select';
import { Card } from '../../src/ui/primitives/Card';
import { Banner } from '../../src/ui/primitives/Banner';
import { spacing, typography } from '../../src/ui/tokens';
import { supabase } from '../../src/lib/supabase';
import { decryptRoomName } from '../../src/features/crypto-session/cryptoSession';
import type { RoomAvailabilityStatus } from '@sms/core';

export default function DashboardScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const queryClient = useQueryClient();

  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  const todayStr = new Date().toISOString().split('T')[0];

  // 1. Fetch dashboard counts
  const { data: counts } = useQuery({
    queryKey: ['dashboard_counts', todayStr],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('dashboard_counts', { p_date: todayStr });
      if (error) throw error;
      return data?.[0] || {
        free_rooms: 0,
        one_bed_free_rooms: 0,
        full_rooms: 0,
        out_of_service_rooms: 0,
        people_in_house: 0,
        pending_details_count: 0,
        arrivals_today: 0
      };
    }
  });

  // 2. Fetch daily room state for today
  const { data: roomStates, isLoading } = useQuery({
    queryKey: ['daily_room_state', todayStr],
    queryFn: async () => {
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];

      const { data, error } = await supabase.rpc('daily_room_state', {
        p_from: todayStr,
        p_to: tomorrowStr
      });
      if (error) throw error;

      // Decrypt room names
      return (data || []).map((row: any) => {
        let status: RoomAvailabilityStatus = 'free';
        if (row.is_closed) status = 'out_of_service';
        else if (row.beds_taken === 1) status = 'one_bed_free';
        else if (row.beds_taken === 2) status = 'full';

        return {
          ...row,
          status,
          name: decryptRoomName(row.room_id, row.room_name_enc || '')
        };
      });
    }
  });

  // Realtime subscription setup
  useEffect(() => {
    const channel = supabase
      .channel('dashboard-realtime')
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
    rooms: filteredRooms.filter((r: any) => r.room_type === type)
  }));

  return (
    <Screen title="Live Room Inventory">
      {/* 1. Summary Strip */}
      <View style={styles.statsStrip}>
        <Stat label="Free Rooms" value={counts?.free_rooms ?? 0} indicatorColor={colors.green} />
        <Stat label="1 Bed Free" value={counts?.one_bed_free_rooms ?? 0} indicatorColor={colors.blue} />
        <Stat label="Full" value={counts?.full_rooms ?? 0} indicatorColor={colors.orange} />
        <Stat label="Out of Service" value={counts?.out_of_service_rooms ?? 0} indicatorColor={colors.grey} />
        <Stat label="People in House" value={counts?.people_in_house ?? 0} indicatorColor={colors.navy} />
      </View>

      {/* 2. Needs Attention Strip */}
      {(counts?.pending_details_count || counts?.arrivals_today) ? (
        <View style={styles.attentionRow}>
          <Banner
            message={`Needs Attention: ${counts?.arrivals_today || 0} arrivals today • ${counts?.pending_details_count || 0} bookings with details pending.`}
            type="warning"
            actionLabel="View Ledger"
            onAction={() => router.push('/bookings')}
          />
        </View>
      ) : null}

      {/* 3. Filters */}
      <Card style={styles.filterCard}>
        <View style={styles.filterRow}>
          <View style={{ flex: 1, minWidth: 200, marginRight: spacing.md }}>
            <Select
              label="Room Type"
              selectedValue={typeFilter}
              onValueChange={setTypeFilter}
              options={[
                { label: 'All Types', value: 'ALL' },
                { label: 'VIP', value: 'VIP' },
                { label: 'Semi VIP', value: 'SEMI_VIP' },
                { label: 'Normal', value: 'NORMAL' }
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
                { label: 'Out of Service', value: 'out_of_service' }
              ]}
            />
          </View>
        </View>
      </Card>

      {/* 4. Rooms Grouped by Type as Tiles */}
      {roomGroups.map((group) => {
        if (group.rooms.length === 0) return null;
        return (
          <View key={group.type} style={styles.groupContainer}>
            <Text style={[styles.groupHeader, { color: colors.navy }]}>
              {group.type.replace('_', ' ')} ROOMS ({group.rooms.length})
            </Text>
            <View style={styles.tilesGrid}>
              {group.rooms.map((r: any) => (
                <Tile
                  key={r.room_id}
                  roomName={r.name || 'Room'}
                  roomType={r.room_type}
                  status={r.status}
                  occupantSummary={
                    r.occupants?.[0] ? `${r.occupants[0].category} (${r.occupants[0].gender}/${r.occupants[0].rankCode})` : undefined
                  }
                  onPress={() => router.push(`/rooms/${r.room_id}`)}
                />
              ))}
            </View>
          </View>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  statsStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md
  },
  attentionRow: {
    marginBottom: spacing.sm
  },
  filterCard: {
    padding: spacing.md,
    marginBottom: spacing.lg
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap'
  },
  groupContainer: {
    marginBottom: spacing.xl
  },
  groupHeader: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  tilesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm
  }
});
