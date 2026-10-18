import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { localDateString } from '../../../src/lib/dates';
import { useThemeStore } from '../../../src/state/themeStore';
import { useSessionStore } from '../../../src/state/sessionStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Card } from '../../../src/ui/primitives/Card';
import { Badge } from '../../../src/ui/primitives/Badge';
import { Button } from '../../../src/ui/primitives/Button';
import { MaskedValue } from '../../../src/ui/primitives/MaskedValue';
import { Skeleton } from '../../../src/ui/primitives/Skeleton';
import { spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';
import { describeGuest } from '../../../src/features/bookings/party';
import {
  decryptGuestPii,
  decryptRoomName,
} from '../../../src/features/crypto-session/cryptoSession';

interface Occupant {
  id: string;
  guest_id: string;
  bed_slot: 1 | 2;
  bookings?: { id: string; category: string; check_in: string; check_out: string; status: string };
  booking_guests?: { rank_code: string | null; gender: string; relation?: string };
}

interface RoomDetail {
  id: string;
  name: string;
  room_type: string;
  is_active: boolean;
  allocations: Occupant[];
  closures: Array<{ id: string; period: string }>;
}

export default function RoomDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const { userRole, userPermissions } = useSessionStore();

  const canReveal = userRole === 'admin' || userPermissions.includes('reveal_guest_pii');
  const canManageRooms = userRole === 'admin' || userPermissions.includes('manage_rooms');
  const today = localDateString();

  const { data: room, isLoading: roomLoading } = useQuery<RoomDetail>({
    queryKey: ['room_detail', id],
    queryFn: async () => {
      const { data: roomRow, error: roomErr } = await supabase
        .from('rooms')
        .select('*')
        .eq('id', id)
        .single();
      if (roomErr) throw roomErr;

      const { data: allocRows, error: allocErr } = await supabase
        .from('allocations')
        .select('*, bookings(*), booking_guests(*)')
        .eq('room_id', id)
        .eq('status', 'ACTIVE');
      if (allocErr) throw allocErr;

      const { data: closureRows } = await supabase
        .from('room_closures')
        .select('*')
        .eq('room_id', id);

      return {
        id: roomRow.id,
        room_type: roomRow.room_type,
        is_active: roomRow.is_active,
        name: decryptRoomName(roomRow.id, roomRow.name_enc),
        allocations: (allocRows || []) as Occupant[],
        closures: (closureRows || []) as Array<{ id: string; period: string }>,
      };
    },
  });

  // "Today" is the stay interval [check_in, check_out): check-out morning is already free.
  const current = (room?.allocations ?? []).filter(
    (a) => a.bookings && a.bookings.check_in <= today && today < a.bookings.check_out,
  );
  const upcoming = (room?.allocations ?? [])
    .filter((a) => a.bookings && a.bookings.check_in > today)
    .sort((a, b) => (a.bookings!.check_in < b.bookings!.check_in ? -1 : 1));
  const closedToday = (room?.closures ?? []).some((c) => {
    const m = /^[[(]\s*([0-9-]+)\s*,\s*([0-9-]+)\s*[)\]]$/.exec(c.period);
    return !!m && m[1] <= today && today < m[2];
  });

  const fetchPii = async (guestId: string) => {
    const { data: cipher, error } = await supabase.rpc('get_guest_pii', {
      p_guest_id: guestId,
    });
    if (error) throw error;
    if (!cipher) return 'Details Pending';
    const pii = decryptGuestPii(guestId, cipher);
    return `${pii.name} (Service: ${pii.serviceNumber || 'N/A'}, Phone: ${pii.phone || 'N/A'})`;
  };

  if (roomLoading) {
    return (
      <Screen title="Room Details" showBack={true}>
        <Card>
          <Skeleton width={160} height={24} style={{ marginBottom: spacing.sm }} />
          <Skeleton width={220} height={16} />
        </Card>
      </Screen>
    );
  }

  const renderBed = (slot: 1 | 2) => {
    const alloc = current.find((a) => a.bed_slot === slot);
    return (
      <Card style={styles.bedCard} key={slot}>
        <View style={styles.bedHeader}>
          <Text style={[styles.bedTitle, { color: colors.text }]}>Bed {slot} · today</Text>
          <Badge
            label={alloc ? 'OCCUPIED' : closedToday ? 'CLOSED' : 'FREE'}
            variant={alloc ? 'warning' : closedToday ? 'default' : 'success'}
          />
        </View>

        {alloc ? (
          <View style={styles.occupantInfo}>
            <Text style={[styles.infoRow, { color: colors.text }]}>
              Category: <Text style={{ fontWeight: 'bold' }}>{alloc.bookings?.category}</Text> •
              Guest:{' '}
              <Text style={{ fontWeight: 'bold' }}>
                {alloc.booking_guests ? describeGuest(alloc.booking_guests) : '—'}
              </Text>
            </Text>
            <Text style={[styles.infoRow, { color: colors.muted }]}>
              Stay: {alloc.bookings?.check_in} to {alloc.bookings?.check_out}
            </Text>

            <MaskedValue
              id={alloc.guest_id}
              label="Guest Identity"
              canReveal={canReveal}
              maskedText={canReveal ? undefined : '•••••••• (reveal permission required)'}
              fetchPlaintext={() => fetchPii(alloc.guest_id)}
            />
            <Button
              label="Open Booking"
              variant="secondary"
              onPress={() => router.push(`/bookings/${alloc.bookings?.id}` as any)}
              style={{ marginTop: spacing.sm }}
            />
          </View>
        ) : (
          <Text style={[styles.freeNotice, { color: closedToday ? colors.muted : colors.green }]}>
            {closedToday
              ? 'Out of service today'
              : 'Available. A ranked guest must match the other occupant’s gender and rank; civilians share only with their own booking.'}
          </Text>
        )}
      </Card>
    );
  };

  return (
    <Screen title={room?.name || 'Room Details'} showBack={true}>
      <Card>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: colors.navy }]}>{room?.name}</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>
              {room?.room_type?.replace('_', ' ')} ROOM • Capacity: 2 Beds
            </Text>
          </View>
          <Badge
            label={!room?.is_active ? 'INACTIVE' : closedToday ? 'OUT OF SERVICE' : 'IN SERVICE'}
            variant={room?.is_active && !closedToday ? 'success' : 'default'}
          />
        </View>
      </Card>

      <Text style={[styles.sectionHeading, { color: colors.navy }]}>
        BED INVENTORY & OCCUPANTS ({today})
      </Text>

      {renderBed(1)}
      {renderBed(2)}

      <Text style={[styles.sectionHeading, { color: colors.navy }]}>Upcoming stays</Text>
      <Card style={styles.bedCard}>
        {upcoming.length === 0 ? (
          <Text style={[styles.freeNotice, { color: colors.muted }]}>No upcoming stays.</Text>
        ) : (
          upcoming.map((a) => (
            <Text key={a.id} style={[styles.infoRow, { color: colors.text }]}>
              {a.bookings?.check_in} → {a.bookings?.check_out} • Bed {a.bed_slot} •{' '}
              {a.bookings?.category} • {a.booking_guests ? describeGuest(a.booking_guests) : '—'}
            </Text>
          ))
        )}
      </Card>

      {(room?.closures?.length ?? 0) > 0 && (
        <>
          <Text style={[styles.sectionHeading, { color: colors.navy }]}>
            OUT-OF-SERVICE PERIODS
          </Text>
          <Card style={styles.bedCard}>
            {room!.closures.map((c) => (
              <Text key={c.id} style={[styles.infoRow, { color: colors.text }]}>
                {c.period.replace(/[[)\]]/g, '').replace(',', ' → ')}
              </Text>
            ))}
          </Card>
        </>
      )}

      <View style={styles.actions}>
        <Button
          label="New Booking"
          onPress={() => router.push('/bookings/new')}
          style={{ marginBottom: spacing.sm }}
        />
        {canManageRooms ? (
          <Button
            label="Mark Out of Service / Closure"
            variant="secondary"
            onPress={() => router.push(`/admin/data?roomId=${id}`)}
          />
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: typography.lg,
    fontWeight: typography.weights.bold,
  },
  subtitle: {
    fontSize: typography.sm,
    marginTop: 2,
  },
  sectionHeading: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    letterSpacing: 0.5,
  },
  bedCard: {
    marginBottom: spacing.md,
  },
  bedHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  bedTitle: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
  },
  occupantInfo: {
    marginTop: spacing.xs,
  },
  infoRow: {
    fontSize: typography.sm,
    marginBottom: spacing.xs,
  },
  freeNotice: {
    fontSize: typography.sm,
    fontStyle: 'italic',
    marginTop: spacing.xs,
  },
  actions: {
    marginTop: spacing.lg,
  },
});
