import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useThemeStore } from '../../src/state/themeStore';
import { useSessionStore } from '../../src/state/sessionStore';
import { Screen } from '../../src/ui/primitives/Screen';
import { Card } from '../../src/ui/primitives/Card';
import { Button } from '../../src/ui/primitives/Button';
import { Select } from '../../src/ui/primitives/Select';
import { DateRange } from '../../src/ui/primitives/DateRange';
import { Badge } from '../../src/ui/primitives/Badge';
import { Banner } from '../../src/ui/primitives/Banner';
import { Dialog } from '../../src/ui/primitives/Dialog';
import { spacing, typography } from '../../src/ui/tokens';
import { supabase } from '../../src/lib/supabase';
import { decryptRoomName } from '../../src/features/crypto-session/cryptoSession';
import { userErrorMessage } from '../../src/lib/userError';
import { addDaysToDateString, isValidDateString, localDateString } from '../../src/lib/dates';

interface SuiteRow {
  id: string;
  name: string;
  is_active: boolean;
  stays: Array<{ id: string; checkIn: string; checkOut: string }>;
}

export default function SuitesManagementScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const { userRole } = useSessionStore();
  const queryClient = useQueryClient();

  const isAdmin = userRole === 'admin';

  const [selectedSuiteId, setSelectedSuiteId] = useState<string>('');
  const [showBookDialog, setShowBookDialog] = useState(false);
  const today = localDateString();
  const [checkIn, setCheckIn] = useState(today);
  const [checkOut, setCheckOut] = useState(addDaysToDateString(today, 3));
  const datesValid = isValidDateString(checkIn) && isValidDateString(checkOut) && checkOut > checkIn;
  const [vipRank, setVipRank] = useState('AM');
  const [vipGender, setVipGender] = useState('M');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Fetch suites (Only admin can query SUITE rooms per RLS policy)
  const { data: suites } = useQuery<SuiteRow[]>({
    queryKey: ['admin_suites_list'],
    queryFn: async () => {
      if (!isAdmin) return [];
      const { data, error } = await supabase
        .from('rooms')
        .select('*')
        .eq('room_type', 'SUITE')
        .is('deleted_at', null)
        .order('display_order');
      if (error) throw error;
      const { data: allocs, error: allocErr } = await supabase
        .from('allocations')
        .select('*, bookings(*)')
        .eq('status', 'ACTIVE');
      if (allocErr) throw allocErr;
      return (data || []).map((r) => ({
        id: r.id as string,
        is_active: r.is_active as boolean,
        name: decryptRoomName(r.id, r.name_enc),
        stays: ((allocs || []) as any[])
          .filter((a) => a.room_id === r.id && a.bookings && a.bookings.check_out > today)
          .map((a) => ({
            id: a.id as string,
            checkIn: a.bookings.check_in as string,
            checkOut: a.bookings.check_out as string,
          }))
          .sort((a, b) => (a.checkIn < b.checkIn ? -1 : 1)),
      }));
    },
    enabled: isAdmin,
  });

  const handleBookSuite = async () => {
    if (!selectedSuiteId) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const { data: bookingId, error } = await supabase.rpc('create_booking', {
        p_booking: {
          category: 'MFA',
          check_in: checkIn,
          check_out: checkOut,
          party_size: 1,
          is_suite_booking: true,
        },
        p_guests: [
          {
            seq: 1,
            gender: vipGender,
            rank_code: vipRank,
          },
        ],
        p_allocations: [
          {
            guest_seq: 1,
            room_id: selectedSuiteId,
            bed_slot: 1,
            check_in: checkIn,
            check_out: checkOut,
          },
        ],
      });

      if (error) throw error;
      setShowBookDialog(false);
      queryClient.invalidateQueries({ queryKey: ['admin_suites_list'] });
      queryClient.invalidateQueries({ queryKey: ['daily_room_state'] });
      router.push(`/(app)/bookings/${bookingId}/confirmed` as any);
    } catch (err: any) {
      setErrorMsg(userErrorMessage(err, 'Failed to book Suite'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!isAdmin) {
    return (
      <Screen title="AM / VVIP Suites" showBack={true}>
        <Banner
          type="error"
          message="Restricted Access: Suites are strictly reserved for AM/VVIP guests and managed exclusively by the Administrator."
        />
      </Screen>
    );
  }

  return (
    <Screen title="AM / VVIP Suites" showBack={false}>
      <View style={styles.container}>
        <Card>
          <View style={styles.header}>
            <View>
              <Text style={[styles.title, { color: colors.navy }]}>AM / VVIP SUITES</Text>
              <Text style={[styles.subtitle, { color: colors.muted }]}>
                Executive suites are isolated from normal engine allotment and clerk booking.
              </Text>
            </View>
            <Badge label="Admin only" variant="warning" />
          </View>
        </Card>

        <Text style={[styles.sectionHeading, { color: colors.navy }]}>Suite inventory</Text>

        {(suites || []).length === 0 && (
          <Banner
            type="info"
            message="No suites exist yet. Add a room with the 'Executive Suite' classification under Rooms & Data."
          />
        )}

        {(suites || []).map((suite) => {
          const stays = suite.stays ?? [];
          const occupiedToday = stays.some((st) => st.checkIn <= today && today < st.checkOut);
          return (
          <Card key={suite.id} style={styles.suiteCard}>
            <View style={styles.suiteHeader}>
              <View style={styles.suiteTitleRow}>
                <View style={[styles.saffronIndicator, { backgroundColor: colors.saffron }]} />
                <Text style={[styles.suiteName, { color: colors.navy }]}>{suite.name}</Text>
                <Badge label="Suite" variant="warning" />
              </View>
              <Badge
                label={!suite.is_active ? 'OFFLINE' : occupiedToday ? 'OCCUPIED' : 'READY'}
                variant={!suite.is_active ? 'default' : occupiedToday ? 'warning' : 'success'}
              />
            </View>

            {stays.length > 0 && (
              <View style={{ marginBottom: spacing.sm }}>
                <Text style={[styles.subtitle, { color: colors.muted }]}>Booked stays</Text>
                {stays.map((st) => (
                  <Text key={st.id} style={{ color: colors.text, fontSize: typography.sm }}>
                    {st.checkIn} → {st.checkOut}
                  </Text>
                ))}
              </View>
            )}

            <View style={styles.suiteActions}>
              <Button
                label="Book Suite for VVIP"
                variant="primary"
                onPress={() => {
                  setSelectedSuiteId(suite.id);
                  setErrorMsg(null);
                  setShowBookDialog(true);
                }}
              />
            </View>
          </Card>
          );
        })}

        {/* Suite Booking Modal */}
        <Dialog
          visible={showBookDialog}
          title="Direct VVIP Suite Booking"
          message="Direct allocation for AM / Air Chief Marshal / VVIP. Creates a dedicated suite booking."
          confirmLabel="Confirm Suite Allotment"
          confirmVariant="primary"
          disabled={!datesValid}
          onConfirm={handleBookSuite}
          onCancel={() => setShowBookDialog(false)}
          loading={submitting}
        >
          <DateRange
            label="VVIP Stay Duration"
            startDate={checkIn}
            endDate={checkOut}
            onStartDateChange={setCheckIn}
            onEndDateChange={setCheckOut}
          />

          <Select
            label="VVIP Dignitary Rank"
            value={vipRank}
            onChange={setVipRank}
            options={[
              { label: 'AM - Air Marshal', value: 'AM' },
              { label: 'ACM - Air Chief Marshal', value: 'ACM' },
              { label: 'MIAF - Marshal of the IAF', value: 'MIAF' },
              { label: 'AVM - Air Vice Marshal', value: 'AVM' },
            ]}
          />

          <Select
            label="Gender"
            value={vipGender}
            onChange={setVipGender}
            options={[
              { label: 'Male (M)', value: 'M' },
              { label: 'Female (F)', value: 'F' },
            ]}
          />

          {errorMsg && <Banner type="error" message={errorMsg} style={{ marginTop: spacing.sm }} />}
        </Dialog>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
  },
  subtitle: {
    fontSize: typography.sm,
    marginTop: 2,
  },
  sectionHeading: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
    letterSpacing: 0.5,
  },
  suiteCard: {
    marginTop: spacing.sm,
  },
  suiteHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  suiteTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  saffronIndicator: {
    width: 4,
    height: 18,
    borderRadius: 2,
  },
  suiteName: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
  },
  suiteActions: {
    marginTop: spacing.md,
  },
});
