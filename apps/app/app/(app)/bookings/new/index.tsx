import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useThemeStore } from '../../../../src/state/themeStore';
import { Screen } from '../../../../src/ui/primitives/Screen';
import { Card } from '../../../../src/ui/primitives/Card';
import { Button } from '../../../../src/ui/primitives/Button';
import { Select } from '../../../../src/ui/primitives/Select';
import { DateRange } from '../../../../src/ui/primitives/DateRange';
import { Banner } from '../../../../src/ui/primitives/Banner';
import { spacing, typography } from '../../../../src/ui/tokens';
import { supabase } from '../../../../src/lib/supabase';
import {
  planAllotment,
  RANK_ORDER,
  type Category,
  type Gender,
  type RankCode,
  type RoomType,
  type RoomDayState,
  type BookingPlanRequest,
  type GuestDemand
} from '@sms/core';

export default function NewBookingScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);

  const [category, setCategory] = useState<Category>('MSA');
  const [checkIn, setCheckIn] = useState<string>(
    new Date().toISOString().split('T')[0]
  );
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 2);
  const [checkOut, setCheckOut] = useState<string>(
    tomorrow.toISOString().split('T')[0]
  );
  const [preferredType, setPreferredType] = useState<RoomType | ''>('VIP');
  const [guests, setGuests] = useState<GuestDemand[]>([
    { gender: 'M', rankCode: 'WG_CDR' }
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);

  // Fetch daily room state for the date range
  const { data: rawStates, isLoading: loadingState } = useQuery({
    queryKey: ['daily_room_state', checkIn, checkOut],
    queryFn: async () => {
      if (!checkIn || !checkOut || checkOut <= checkIn) return [];
      const { data, error } = await supabase.rpc('daily_room_state', {
        p_from: checkIn,
        p_to: checkOut
      });
      if (error) throw error;
      return (data || []) as RoomDayState[];
    },
    enabled: Boolean(checkIn && checkOut && checkOut > checkIn)
  });

  // Calculate live availability plan
  const planRequest: BookingPlanRequest = {
    category,
    checkIn,
    checkOut,
    guests,
    preferredRoomType: preferredType ? (preferredType as RoomType) : undefined
  };

  const plan = rawStates && rawStates.length > 0 ? planAllotment(planRequest, rawStates) : null;

  const handleAddGuest = () => {
    if (guests.length < 40) {
      setGuests([...guests, { gender: 'M', rankCode: 'FLT_LT' }]);
    }
  };

  const handleRemoveGuest = (index: number) => {
    if (guests.length > 1) {
      setGuests(guests.filter((_, i) => i !== index));
    }
  };

  const handleUpdateGuest = (index: number, key: 'gender' | 'rankCode', val: any) => {
    const updated = [...guests];
    updated[index] = { ...updated[index], [key]: val };
    setGuests(updated);
  };

  const handleAllotDirect = async () => {
    if (!plan || plan.kind !== 'ALLOT') return;
    setSubmitting(true);
    setBookingError(null);
    try {
      // Direct booking RPC call
      const { data: bookingId, error } = await supabase.rpc('create_booking', {
        p_booking: {
          category,
          check_in: checkIn,
          check_out: checkOut,
          party_size: guests.length,
          is_suite_booking: false
        },
        p_guests: guests.map((g, idx) => ({
          seq: idx + 1,
          gender: g.gender,
          rank_code: g.rankCode
        })),
        p_allocations: plan.assignments.map((a) => ({
          guest_seq: a.guestIndex + 1,
          room_id: a.roomId,
          bed_slot: a.bedSlot,
          check_in: checkIn,
          check_out: checkOut
        }))
      });

      if (error) throw error;
      router.replace(`/(app)/bookings/${bookingId}/confirmed` as any);
    } catch (err: any) {
      setBookingError(err.message || 'Failed to allot booking');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen title="New Booking" showBack={true}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.formSection}>
          <Card>
            <Text style={[styles.sectionTitle, { color: colors.navy }]}>1. VISITOR CATEGORY & DATES</Text>
            
            <Select
              label="Visitor Category"
              value={category}
              onChange={(val: string) => setCategory(val as Category)}
              options={[
                { label: 'MSA - BA MSA (Highest Priority, Free)', value: 'MSA' },
                { label: 'PI - Posted In (High Priority, Free)', value: 'PI' },
                { label: 'LEAVE - On Leave (Low Priority)', value: 'LEAVE' },
                { label: 'TD - Temporary Displacement (Low Priority)', value: 'TD' }
              ]}
            />

            <DateRange
              label="Stay Period [check-in, check-out)"
              startDate={checkIn}
              endDate={checkOut}
              onStartDateChange={setCheckIn}
              onEndDateChange={setCheckOut}
            />

            <Select
              label="Preferred Room Type (Non-Suite)"
              value={preferredType}
              onChange={(val: string) => setPreferredType(val as RoomType)}
              options={[
                { label: 'VIP Room', value: 'VIP' },
                { label: 'Semi VIP Room', value: 'SEMI_VIP' },
                { label: 'Normal Room', value: 'NORMAL' }
              ]}
            />
          </Card>

          <Card style={{ marginTop: spacing.md }}>
            <View style={styles.guestHeaderRow}>
              <Text style={[styles.sectionTitle, { color: colors.navy }]}>
                2. GUESTS ({guests.length} person{guests.length > 1 ? 's' : ''})
              </Text>
              <Button
                label="+ Add Guest"
                variant="secondary"
                onPress={handleAddGuest}
              />
            </View>
            <Text style={[styles.helpText, { color: colors.muted }]}>
              Gender and rank are required upfront to enforce room sharing rules. Names and ID numbers can be backfilled later.
            </Text>

            {guests.map((g, idx) => (
              <View key={idx} style={[styles.guestRow, { borderColor: colors.border }]}>
                <Text style={[styles.guestSeq, { color: colors.navy }]}>Guest {idx + 1}</Text>
                <View style={styles.guestInputs}>
                  <View style={{ flex: 1 }}>
                    <Select
                      label="Gender"
                      value={g.gender}
                      onChange={(val: string) => handleUpdateGuest(idx, 'gender', val as Gender)}
                      options={[
                        { label: 'Male (M)', value: 'M' },
                        { label: 'Female (F)', value: 'F' }
                      ]}
                    />
                  </View>
                  <View style={{ flex: 2 }}>
                    <Select
                      label="Rank"
                      value={g.rankCode}
                      onChange={(val: string) => handleUpdateGuest(idx, 'rankCode', val as RankCode)}
                      options={RANK_ORDER.map((r) => ({
                        label: `${r.code} - ${r.label}`,
                        value: r.code
                      }))}
                    />
                  </View>
                  {guests.length > 1 && (
                    <Button
                      label="✕"
                      variant="destructive"
                      onPress={() => handleRemoveGuest(idx)}
                      style={{ marginTop: 22, width: 44 }}
                    />
                  )}
                </View>
              </View>
            ))}
          </Card>
        </View>

        {/* Live Availability Section */}
        <View style={styles.planSection}>
          <Card>
            <Text style={[styles.sectionTitle, { color: colors.navy }]}>LIVE AVAILABILITY RESULT</Text>
            {loadingState ? (
              <Text style={[styles.planStatus, { color: colors.muted }]}>Checking room availability...</Text>
            ) : !plan ? (
              <Text style={[styles.planStatus, { color: colors.muted }]}>
                Select valid dates and guests to view live options.
              </Text>
            ) : plan.kind === 'ALLOT' ? (
              <View>
                <Banner
                  type="success"
                  message={`Available! All ${guests.length} guest(s) can be accommodated immediately.`}
                />
                {plan.usedFallbackType && (
                  <Banner
                    type="warning"
                    message="Preferred room type was full. A fallback room type is used."
                  />
                )}
                <Text style={[styles.summaryText, { color: colors.text }]}>
                  Proposed Beds: {plan.assignments.length} assigned across {new Set(plan.assignments.map((a) => a.roomId)).size} room(s).
                </Text>

                <View style={styles.actionButtons}>
                  <Button
                    label="Confirm & Allot Now"
                    onPress={handleAllotDirect}
                    loading={submitting}
                  />
                  <Button
                    label="Customise Bed Placement"
                    variant="secondary"
                    onPress={() => {
                      router.push({
                        pathname: '/(app)/bookings/new/rooms',
                        params: {
                          payload: JSON.stringify({
                            category,
                            checkIn,
                            checkOut,
                            guests,
                            plan
                          })
                        }
                      } as any);
                    }}
                  />
                </View>
              </View>
            ) : (
              <View>
                <Banner
                  type="error"
                  message="No rooms free for the selected dates."
                />
                <Text style={[styles.summaryText, { color: colors.text }]}>
                  {category === 'MSA' || category === 'PI'
                    ? 'High-priority category eligible for eviction review.'
                    : 'Low-priority category can be offered alternate dates or denied with reason.'}
                </Text>
                <Button
                  label="View Alternates & Options"
                  variant="primary"
                  onPress={() => {
                    router.push({
                      pathname: '/(app)/bookings/new/alternates',
                      params: {
                        payload: JSON.stringify({
                          category,
                          checkIn,
                          checkOut,
                          guests,
                          plan
                        })
                      }
                    } as any);
                  }}
                  style={{ marginTop: spacing.md }}
                />
              </View>
            )}

            {bookingError && (
              <Banner
                type="error"
                message={bookingError}
                style={{ marginTop: spacing.md }}
              />
            )}
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.md,
    gap: spacing.md
  },
  formSection: {
    flex: 1
  },
  planSection: {
    flex: 1
  },
  sectionTitle: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
    marginBottom: spacing.md
  },
  guestHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs
  },
  helpText: {
    fontSize: typography.xs,
    marginBottom: spacing.md
  },
  guestRow: {
    paddingVertical: spacing.sm,
    borderTopWidth: 1
  },
  guestSeq: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
    marginBottom: spacing.xs
  },
  guestInputs: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start'
  },
  planStatus: {
    fontSize: typography.sm,
    marginVertical: spacing.md
  },
  summaryText: {
    fontSize: typography.sm,
    marginVertical: spacing.md
  },
  actionButtons: {
    gap: spacing.sm
  }
});
