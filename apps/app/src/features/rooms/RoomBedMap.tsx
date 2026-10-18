import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { RELATION_LABELS, type GuestRelation, type RoomDayOccupant } from '@sms/core';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../../ui/tokens';
import { isHeldByExclusiveBooking, roomBedLayout, type BedState } from './bedLayout';
import { rankLabel } from '../bookings/guestDisplay';

/** One room for one day, as daily_room_state returns it. */
export interface BedMapRoom {
  room_id: string;
  room_type: string;
  is_closed: boolean;
  occupants: RoomDayOccupant[] | null;
}

export interface RoomBedMapProps {
  rooms: BedMapRoom[];
  roomNames: Record<string, string> | undefined;
  /** A free bed was pressed. */
  onBookBed: (roomId: string, bedSlot: 1 | 2) => void;
  /** An occupied or closed bed (or the room header) was pressed. */
  onOpenRoom: (roomId: string) => void;
}

const GROUPS: Array<{ type: string; label: string }> = [
  { type: 'VIP', label: 'VIP rooms' },
  { type: 'SEMI_VIP', label: 'Semi VIP rooms' },
  { type: 'NORMAL', label: 'Normal rooms' },
];

function personLabel(o: RoomDayOccupant): string {
  if (o.rankCode) return rankLabel(o.rankCode);
  return RELATION_LABELS[(o.relation as GuestRelation) ?? 'OTHER'] ?? 'Civilian';
}

/**
 * Floor-plan style map: every room drawn with its two beds, so a clerk sees at a glance which beds
 * are taken and which can still be booked for the selected day. Free beds open New Booking.
 * A room held by a booking that does not allow sharing is drawn with just that one bed: its other
 * bed is not free and is not drawn.
 */
export function RoomBedMap({ rooms, roomNames, onBookBed, onOpenRoom }: RoomBedMapProps) {
  const colors = useThemeStore((s) => s.colors);

  const palette = {
    free: { fill: colors.greenSoft, edge: colors.green, ink: colors.green },
    held: { fill: colors.blueSoft, edge: colors.blue, ink: colors.blue },
    occupied: { fill: colors.orangeSoft, edge: colors.orange, ink: colors.orange },
    closed: { fill: colors.greySoft, edge: colors.grey, ink: colors.grey },
  } as const;

  const totals = { free: 0, held: 0, occupied: 0, closed: 0 };
  for (const r of rooms) for (const b of roomBedLayout(r)) totals[b.state.kind]++;

  const legend: Array<{ kind: keyof typeof palette; label: string }> = [
    { kind: 'free', label: `Free (${totals.free})` },
    { kind: 'occupied', label: `Occupied (${totals.occupied})` },
    { kind: 'held', label: `Party only (${totals.held})` },
    { kind: 'closed', label: `Out of service (${totals.closed})` },
  ];

  const renderBed = (room: BedMapRoom, slot: 1 | 2, state: BedState, name: string, alone = false) => {
    const p = palette[state.kind];
    let title: string;
    let detail: string;
    let a11y: string;
    switch (state.kind) {
      case 'free':
        title = 'Free';
        detail = state.sharesWith
          ? `Any ${state.sharesWith.gender === 'F' ? 'female' : 'male'} guest · shares with ${personLabel(state.sharesWith)}`
          : 'Tap to book';
        a11y = `${name} bed ${slot}, free${state.sharesWith ? `, ${detail}` : ''}. Book this bed`;
        break;
      case 'held':
        title = 'Party only';
        detail = 'Beside a civilian guest';
        a11y = `${name} bed ${slot}, free but only for the party of the civilian guest in the other bed`;
        break;
      case 'occupied':
        title = `${personLabel(state.occ)} · ${state.occ.gender}`;
        detail = `${state.occ.category} · until ${state.occ.checkOut.slice(5)}${
          state.occ.allowSharing === false ? ' · no sharing' : ''
        }`;
        a11y = `${name} bed ${slot}, occupied by ${state.occ.rankCode ? 'a ranked guest' : 'a civilian guest'}, ${detail}`;
        break;
      case 'closed':
        title = 'Closed';
        detail = 'Out of service';
        a11y = `${name} bed ${slot}, out of service`;
        break;
    }
    const bookable = state.kind === 'free';
    return (
      <Pressable
        key={slot}
        onPress={() => (bookable ? onBookBed(room.room_id, slot) : onOpenRoom(room.room_id))}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        style={({ pressed }) => [
          styles.bed,
          // A room held by one booking shows its single bed at the width of one of two.
          alone && styles.bedAlone,
          {
            backgroundColor: p.fill,
            borderColor: p.edge,
            borderStyle: bookable ? 'dashed' : 'solid',
            opacity: pressed ? 0.75 : 1,
          },
        ]}
      >
        {/* Pillow */}
        <View style={[styles.pillow, { borderColor: p.edge, backgroundColor: colors.surface }]} />
        <Text style={[styles.bedSlot, { color: colors.muted }]}>Bed {slot}</Text>
        <Text style={[styles.bedTitle, { color: p.ink }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.bedDetail, { color: colors.muted }]} numberOfLines={2}>
          {detail}
        </Text>
      </Pressable>
    );
  };

  return (
    <View>
      <View style={styles.legend} accessibilityRole="summary">
        {legend.map((l) => (
          <View key={l.kind} style={styles.legendItem}>
            <View
              style={[
                styles.legendSwatch,
                {
                  backgroundColor: palette[l.kind].fill,
                  borderColor: palette[l.kind].edge,
                  borderStyle: l.kind === 'free' ? 'dashed' : 'solid',
                },
              ]}
            />
            <Text style={[styles.legendText, { color: colors.text }]}>{l.label}</Text>
          </View>
        ))}
      </View>

      {GROUPS.map((g) => {
        const list = rooms.filter((r) => r.room_type === g.type);
        if (list.length === 0) return null;
        return (
          <View key={g.type} style={styles.group}>
            <Text style={[styles.groupHeader, { color: colors.navy, borderBottomColor: colors.border }]}>
              {g.label}
            </Text>
            <View style={styles.grid}>
              {list.map((room) => {
                const name = roomNames?.[room.room_id] ?? '…';
                const beds = roomBedLayout(room);
                const occ = room.occupants ?? [];
                const oneParty =
                  occ.length === 2 && occ[0].bookingId === occ[1].bookingId;
                const roomHeld = isHeldByExclusiveBooking(room);
                return (
                  <View
                    key={room.room_id}
                    style={[styles.room, { backgroundColor: colors.surface, borderColor: colors.borderStrong }]}
                  >
                    <Pressable
                      onPress={() => onOpenRoom(room.room_id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${name}`}
                      style={styles.roomHeader}
                    >
                      <Text style={[styles.roomName, { color: colors.text }]} numberOfLines={1}>
                        {name}
                      </Text>
                      {oneParty && (
                        <Text style={[styles.partyChip, { color: colors.navy, borderColor: colors.border }]}>
                          One party
                        </Text>
                      )}
                      {roomHeld && (
                        <Text style={[styles.partyChip, { color: colors.navy, borderColor: colors.border }]}>
                          Whole room held
                        </Text>
                      )}
                    </Pressable>
                    <View style={styles.beds}>
                      {beds.map((b) => renderBed(room, b.slot, b.state, name, roomHeld))}
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  legendSwatch: {
    width: 16,
    height: 16,
    borderRadius: 3,
    borderWidth: 1.5,
  },
  legendText: {
    fontSize: typography.sm,
  },
  group: {
    marginBottom: spacing.xl,
  },
  groupHeader: {
    fontSize: typography.md,
    fontWeight: typography.weights.bold,
    borderBottomWidth: 1,
    paddingBottom: spacing.xs,
    marginBottom: spacing.md,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  room: {
    flexGrow: 1,
    flexBasis: 220,
    maxWidth: 360,
    borderWidth: 2,
    borderRadius: layout.surfaceRadius,
    padding: spacing.sm,
  },
  roomHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xs,
    marginBottom: spacing.sm,
    minHeight: 24,
  },
  roomName: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
    flexShrink: 1,
  },
  partyChip: {
    fontSize: typography.xs,
    fontWeight: typography.weights.semibold,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  beds: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  bed: {
    flex: 1,
    minHeight: 104,
    borderWidth: 1.5,
    borderRadius: 6,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
    paddingTop: 26,
  },
  bedAlone: {
    flexGrow: 0,
    flexBasis: '50%',
    maxWidth: '50%',
  },
  pillow: {
    position: 'absolute',
    top: 6,
    left: '20%',
    right: '20%',
    height: 12,
    borderRadius: 6,
    borderWidth: 1,
  },
  bedSlot: {
    fontSize: typography.xs,
  },
  bedTitle: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
    marginTop: 2,
  },
  bedDetail: {
    fontSize: typography.xs,
    marginTop: 2,
  },
});
