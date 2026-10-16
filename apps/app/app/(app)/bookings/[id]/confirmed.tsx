import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useThemeStore } from '../../../../src/state/themeStore';
import { Screen } from '../../../../src/ui/primitives/Screen';
import { Card } from '../../../../src/ui/primitives/Card';
import { Icon } from '../../../../src/ui/primitives/Icon';
import { Button } from '../../../../src/ui/primitives/Button';
import { Badge } from '../../../../src/ui/primitives/Badge';
import { spacing, typography } from '../../../../src/ui/tokens';
import { supabase } from '../../../../src/lib/supabase';
import { decryptRoomName } from '../../../../src/features/crypto-session/cryptoSession';

export default function BookingConfirmedScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);

  const { data: booking } = useQuery({
    queryKey: ['booking_confirmed', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('bookings')
        .select('*, booking_guests(*), allocations(*, rooms(*))')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data;
    },
  });

  return (
    <Screen title="Booking Confirmed" showBack={false}>
      <View style={styles.container}>
        <Card style={styles.card}>
          <View style={[styles.successIconCircle, { backgroundColor: colors.green }]}>
            <Icon name="check" size={32} color={colors.onAction} strokeWidth={2.5} />
          </View>

          <Text style={[styles.title, { color: colors.navy }]}>Booking confirmed</Text>
          <Text style={[styles.bookingId, { color: colors.muted }]}>Reference: {id}</Text>

          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          <View style={styles.metaGrid}>
            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: colors.muted }]}>Category:</Text>
              <Badge label={booking?.category || 'CONFIRMED'} variant="success" />
            </View>

            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: colors.muted }]}>Stay Dates:</Text>
              <Text style={[styles.metaValue, { color: colors.text }]}>
                {booking?.check_in} to {booking?.check_out}
              </Text>
            </View>

            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: colors.muted }]}>Party Size:</Text>
              <Text style={[styles.metaValue, { color: colors.text }]}>
                {booking?.party_size} person(s)
              </Text>
            </View>

            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: colors.muted }]}>Rooms Allotted:</Text>
              <Text style={[styles.metaValue, { color: colors.text }]}>
                {booking?.allocations
                  ? booking.allocations
                      .map(
                        (a: any) =>
                          `${decryptRoomName(a.room_id, a.rooms?.name_enc)} (Bed ${a.bed_slot})`,
                      )
                      .join(', ')
                  : 'Pending'}
              </Text>
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          <View style={styles.actions}>
            <Button
              label="Backfill Guest Details Now"
              variant="primary"
              onPress={() => router.replace(`/(app)/bookings/${id}/guests` as any)}
            />

            <Button
              label="View Full Ledger Record"
              variant="secondary"
              onPress={() => router.replace(`/(app)/bookings/${id}` as any)}
            />

            <Button
              label="Return to Dashboard"
              variant="secondary"
              onPress={() => router.replace('/(app)' as any)}
            />
          </View>
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: '100%',
    maxWidth: 520,
    alignItems: 'center',
    padding: spacing.xl,
  },
  successIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  title: {
    fontSize: typography.xl,
    fontWeight: typography.weights.bold,
    textAlign: 'center',
  },
  bookingId: {
    fontSize: typography.xs,
    marginTop: 4,
    textAlign: 'center',
  },
  divider: {
    width: '100%',
    height: 1,
    marginVertical: spacing.lg,
  },
  metaGrid: {
    width: '100%',
    gap: spacing.sm,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metaLabel: {
    fontSize: typography.sm,
  },
  metaValue: {
    fontSize: typography.sm,
    fontWeight: typography.weights.medium,
  },
  actions: {
    width: '100%',
    gap: spacing.sm,
  },
});
