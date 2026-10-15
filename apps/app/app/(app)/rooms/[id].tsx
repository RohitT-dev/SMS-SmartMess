import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useThemeStore } from '../../../src/state/themeStore';
import { useSessionStore } from '../../../src/state/sessionStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Card } from '../../../src/ui/primitives/Card';
import { Badge } from '../../../src/ui/primitives/Badge';
import { Button } from '../../../src/ui/primitives/Button';
import { MaskedValue } from '../../../src/ui/primitives/MaskedValue';
import { Banner } from '../../../src/ui/primitives/Banner';
import { spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';
import { decryptGuestPii, decryptRoomName } from '../../../src/features/crypto-session/cryptoSession';

export default function RoomDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const { userRole, userPermissions } = useSessionStore();

  const canReveal = userRole === 'admin' || userPermissions.includes('reveal_guest_pii');

  const { data: room, isLoading } = useQuery({
    queryKey: ['room_detail', id],
    queryFn: async () => {
      const { data: roomRow, error: roomErr } = await supabase
        .from('rooms')
        .select('*')
        .eq('id', id)
        .single();
      if (roomErr) throw roomErr;

      // Fetch active allocations in this room
      const { data: allocRows } = await supabase
        .from('allocations')
        .select('*, bookings(*), booking_guests(*)')
        .eq('room_id', id)
        .eq('status', 'ACTIVE');

      const roomName = decryptRoomName(roomRow.id, roomRow.name_enc);

      return {
        ...roomRow,
        name: roomName,
        allocations: allocRows || []
      };
    }
  });

  const bed1Alloc = room?.allocations.find((a: any) => a.bed_slot === 1);
  const bed2Alloc = room?.allocations.find((a: any) => a.bed_slot === 2);

  const fetchPii = async (guestId: string) => {
    const { data: cipher, error } = await supabase.rpc('get_guest_pii', {
      p_guest_id: guestId
    });
    if (error) throw error;
    if (!cipher) return 'Details Pending';
    const pii = decryptGuestPii(guestId, cipher);
    return `${pii.name} (Service: ${pii.serviceNumber || 'N/A'}, Phone: ${pii.phone})`;
  };

  return (
    <Screen title={room?.name || 'Room Details'} showBack={true}>
      <Card>
        <View style={styles.header}>
          <View>
            <Text style={[styles.title, { color: colors.navy }]}>{room?.name}</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>
              {room?.room_type?.replace('_', ' ')} ROOM • Capacity: 2 Beds
            </Text>
          </View>
          <Badge
            label={room?.is_active ? 'ACTIVE' : 'OUT OF SERVICE'}
            variant={room?.is_active ? 'success' : 'default'}
          />
        </View>
      </Card>

      <Text style={[styles.sectionHeading, { color: colors.navy }]}>BED INVENTORY & OCCUPANTS</Text>

      {/* Bed 1 Card */}
      <Card style={styles.bedCard}>
        <View style={styles.bedHeader}>
          <Text style={[styles.bedTitle, { color: colors.text }]}>Bed Slot 1</Text>
          <Badge
            label={bed1Alloc ? 'OCCUPIED' : 'FREE'}
            variant={bed1Alloc ? 'warning' : 'success'}
          />
        </View>

        {bed1Alloc ? (
          <View style={styles.occupantInfo}>
            <Text style={[styles.infoRow, { color: colors.text }]}>
              Category: <Text style={{ fontWeight: 'bold' }}>{bed1Alloc.bookings?.category}</Text> • Rank:{' '}
              <Text style={{ fontWeight: 'bold' }}>{bed1Alloc.booking_guests?.rank_code}</Text> • Gender:{' '}
              <Text style={{ fontWeight: 'bold' }}>{bed1Alloc.booking_guests?.gender}</Text>
            </Text>
            <Text style={[styles.infoRow, { color: colors.muted }]}>
              Stay: {bed1Alloc.bookings?.check_in} to {bed1Alloc.bookings?.check_out}
            </Text>

            {canReveal ? (
              <MaskedValue
                id={bed1Alloc.guest_id}
                label="Guest Identity"
                fetchPlaintext={() => fetchPii(bed1Alloc.guest_id)}
              />
            ) : (
              <Banner message="Guest identity is masked. Admin authorization required to reveal." type="info" />
            )}
          </View>
        ) : (
          <Text style={[styles.freeNotice, { color: colors.green }]}>
            Available for allotment
          </Text>
        )}
      </Card>

      {/* Bed 2 Card */}
      <Card style={styles.bedCard}>
        <View style={styles.bedHeader}>
          <Text style={[styles.bedTitle, { color: colors.text }]}>Bed Slot 2</Text>
          <Badge
            label={bed2Alloc ? 'OCCUPIED' : 'FREE'}
            variant={bed2Alloc ? 'warning' : 'success'}
          />
        </View>

        {bed2Alloc ? (
          <View style={styles.occupantInfo}>
            <Text style={[styles.infoRow, { color: colors.text }]}>
              Category: <Text style={{ fontWeight: 'bold' }}>{bed2Alloc.bookings?.category}</Text> • Rank:{' '}
              <Text style={{ fontWeight: 'bold' }}>{bed2Alloc.booking_guests?.rank_code}</Text> • Gender:{' '}
              <Text style={{ fontWeight: 'bold' }}>{bed2Alloc.booking_guests?.gender}</Text>
            </Text>
            <Text style={[styles.infoRow, { color: colors.muted }]}>
              Stay: {bed2Alloc.bookings?.check_in} to {bed2Alloc.bookings?.check_out}
            </Text>

            {canReveal ? (
              <MaskedValue
                id={bed2Alloc.guest_id}
                label="Guest Identity"
                fetchPlaintext={() => fetchPii(bed2Alloc.guest_id)}
              />
            ) : (
              <Banner message="Guest identity is masked. Admin authorization required to reveal." type="info" />
            )}
          </View>
        ) : (
          <Text style={[styles.freeNotice, { color: colors.green }]}>
            Available for allotment (Must match occupant gender & rank if Bed 1 occupied)
          </Text>
        )}
      </Card>

      {/* Actions */}
      <View style={styles.actions}>
        <Button
          label="New Booking for this Room"
          onPress={() => router.push(`/bookings/new?roomId=${id}`)}
          style={{ marginBottom: spacing.sm }}
        />
        {userRole === 'admin' ? (
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
    alignItems: 'center'
  },
  title: {
    fontSize: typography.lg,
    fontWeight: typography.weights.bold
  },
  subtitle: {
    fontSize: typography.sm,
    marginTop: 2
  },
  sectionHeading: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    letterSpacing: 0.5
  },
  bedCard: {
    marginBottom: spacing.md
  },
  bedHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm
  },
  bedTitle: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold
  },
  occupantInfo: {
    marginTop: spacing.xs
  },
  infoRow: {
    fontSize: typography.sm,
    marginBottom: spacing.xs
  },
  freeNotice: {
    fontSize: typography.sm,
    fontStyle: 'italic',
    marginTop: spacing.xs
  },
  actions: {
    marginTop: spacing.lg
  }
});
