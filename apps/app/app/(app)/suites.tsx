import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
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

export default function SuitesManagementScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const { userRole } = useSessionStore();
  const queryClient = useQueryClient();

  const isAdmin = userRole === 'admin';

  const [selectedSuiteId, setSelectedSuiteId] = useState<string>('');
  const [showBookDialog, setShowBookDialog] = useState(false);
  const [checkIn, setCheckIn] = useState(new Date().toISOString().split('T')[0]);
  const defaultCheckOut = new Date();
  defaultCheckOut.setDate(defaultCheckOut.getDate() + 3);
  const [checkOut, setCheckOut] = useState(defaultCheckOut.toISOString().split('T')[0]);
  const [vipRank, setVipRank] = useState('AM');
  const [vipGender, setVipGender] = useState('M');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Fetch suites (Only admin can query SUITE rooms per RLS policy)
  const { data: suites, isLoading } = useQuery({
    queryKey: ['admin_suites_list'],
    queryFn: async () => {
      if (!isAdmin) return [];
      const { data, error } = await supabase
        .from('rooms')
        .select('*')
        .eq('room_type', 'SUITE')
        .order('display_order');
      if (error) throw error;
      return (data || []).map((r) => ({
        ...r,
        name: decryptRoomName(r.id, r.name_enc)
      }));
    },
    enabled: isAdmin
  });

  const handleBookSuite = async () => {
    if (!selectedSuiteId) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const { data: bookingId, error } = await supabase.rpc('create_booking', {
        p_booking: {
          category: 'MSA',
          check_in: checkIn,
          check_out: checkOut,
          party_size: 1,
          is_suite_booking: true
        },
        p_guests: [
          {
            seq: 1,
            gender: vipGender,
            rank_code: vipRank
          }
        ],
        p_allocations: [
          {
            guest_seq: 1,
            room_id: selectedSuiteId,
            bed_slot: 1,
            check_in: checkIn,
            check_out: checkOut
          }
        ]
      });

      if (error) throw error;
      setShowBookDialog(false);
      queryClient.invalidateQueries({ queryKey: ['admin_suites_list'] });
      router.push(`/(app)/bookings/${bookingId}/confirmed` as any);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to book Suite');
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
      <ScrollView contentContainerStyle={styles.container}>
        <Card>
          <View style={styles.header}>
            <View>
              <Text style={[styles.title, { color: colors.navy }]}>AM / VVIP SUITES</Text>
              <Text style={[styles.subtitle, { color: colors.muted }]}>
                Executive suites are isolated from normal engine allotment and clerk booking.
              </Text>
            </View>
            <Badge label="ADMIN ONLY" variant="warning" />
          </View>
        </Card>

        <Text style={[styles.sectionHeading, { color: colors.navy }]}>SUITE INVENTORY</Text>

        {(suites || []).map((suite) => (
          <Card key={suite.id} style={styles.suiteCard}>
            <View style={styles.suiteHeader}>
              <View style={styles.suiteTitleRow}>
                <View style={[styles.saffronIndicator, { backgroundColor: colors.saffron }]} />
                <Text style={[styles.suiteName, { color: colors.navy }]}>{suite.name}</Text>
                <Badge label="SUITE" variant="warning" />
              </View>
              <Badge label={suite.is_active ? 'READY' : 'OFFLINE'} variant={suite.is_active ? 'success' : 'default'} />
            </View>

            <View style={styles.suiteActions}>
              <Button
                label="Book Suite for VVIP"
                variant="primary"
                onPress={() => {
                  setSelectedSuiteId(suite.id);
                  setShowBookDialog(true);
                }}
              />
            </View>
          </Card>
        ))}

        {/* Suite Booking Modal */}
        <Dialog
          visible={showBookDialog}
          title="Direct VVIP Suite Booking"
          message="Direct allocation for AM / Air Chief Marshal / VVIP. Creates a dedicated suite booking."
          confirmLabel="Confirm Suite Allotment"
          confirmVariant="primary"
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
              { label: 'AVM - Air Vice Marshal', value: 'AVM' }
            ]}
          />

          <Select
            label="Gender"
            value={vipGender}
            onChange={setVipGender}
            options={[
              { label: 'Male (M)', value: 'M' },
              { label: 'Female (F)', value: 'F' }
            ]}
          />

          {errorMsg && (
            <Banner
              type="error"
              message={errorMsg}
              style={{ marginTop: spacing.sm }}
            />
          )}
        </Dialog>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.md
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  title: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold
  },
  subtitle: {
    fontSize: typography.sm,
    marginTop: 2
  },
  sectionHeading: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
    letterSpacing: 0.5
  },
  suiteCard: {
    marginTop: spacing.sm
  },
  suiteHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  suiteTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  saffronIndicator: {
    width: 4,
    height: 18,
    borderRadius: 2
  },
  suiteName: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold
  },
  suiteActions: {
    marginTop: spacing.md
  }
});
