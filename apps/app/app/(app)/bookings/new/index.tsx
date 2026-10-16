import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useThemeStore } from '../../../../src/state/themeStore';
import { useSessionStore } from '../../../../src/state/sessionStore';
import { Screen } from '../../../../src/ui/primitives/Screen';
import { Card } from '../../../../src/ui/primitives/Card';
import { Button } from '../../../../src/ui/primitives/Button';
import { Select } from '../../../../src/ui/primitives/Select';
import { Checkbox } from '../../../../src/ui/primitives/Checkbox';
import { DateRange } from '../../../../src/ui/primitives/DateRange';
import { Banner } from '../../../../src/ui/primitives/Banner';
import { spacing, typography } from '../../../../src/ui/tokens';
import { supabase } from '../../../../src/lib/supabase';
import { logAction } from '../../../../src/lib/activityLog';
import { userErrorMessage } from '../../../../src/lib/userError';
import {
  addDaysToDateString,
  isValidDateString,
  localDateString,
} from '../../../../src/lib/dates';
import { fetchRoomDayStates } from '../../../../src/features/bookings/roomState';
import { alternatesHorizonEnd } from '../../../../src/features/bookings/planBooking';
import { useRoomNames } from '../../../../src/features/rooms/useRoomNames';
import {
  planAllotment,
  RANK_ORDER,
  type Category,
  type Gender,
  type RankCode,
  type RoomType,
  type BookingPlanRequest,
  type GuestDemand,
} from '@sms/core';

const ROOM_TYPE_LABEL: Record<string, string> = {
  VIP: 'VIP',
  SEMI_VIP: 'Semi VIP',
  NORMAL: 'Normal',
};

export default function NewBookingScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const userRole = useSessionStore((s) => s.userRole);
  const { initialCheckIn, initialCheckOut, draft } = useLocalSearchParams<{
    initialCheckIn?: string;
    initialCheckOut?: string;
    draft?: string;
  }>();

  // The alternates screen hands back the party it was working with.
  const restored = useMemo(() => {
    try {
      return draft ? (JSON.parse(draft) as { category?: Category; guests?: GuestDemand[]; preferSharing?: boolean }) : null;
    } catch {
      return null;
    }
  }, [draft]);

  const today = localDateString();
  const [category, setCategory] = useState<Category>(restored?.category ?? 'MSA');
  const [checkIn, setCheckIn] = useState<string>(
    initialCheckIn && isValidDateString(initialCheckIn) ? initialCheckIn : today,
  );
  const [checkOut, setCheckOut] = useState<string>(
    initialCheckOut && isValidDateString(initialCheckOut)
      ? initialCheckOut
      : addDaysToDateString(today, 2),
  );
  const [preferredType, setPreferredType] = useState<RoomType | 'ANY'>('VIP');
  const [guests, setGuests] = useState<GuestDemand[]>(
    restored?.guests?.length ? restored.guests : [{ gender: 'M', rankCode: 'WG_CDR' }],
  );
  const [preferSharing, setPreferSharing] = useState<boolean>(restored?.preferSharing ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);

  // "Select Dates" on the alternates screen comes back here with new dates.
  useEffect(() => {
    if (initialCheckIn && isValidDateString(initialCheckIn)) setCheckIn(initialCheckIn);
    if (initialCheckOut && isValidDateString(initialCheckOut)) setCheckOut(initialCheckOut);
  }, [initialCheckIn, initialCheckOut]);

  const datesValid =
    isValidDateString(checkIn) && isValidDateString(checkOut) && checkOut > checkIn;
  const isBackdated = datesValid && userRole !== 'admin' && checkIn < today;

  const { data: roomNames } = useRoomNames();

  // Per-room, per-day state for the requested stay (engine-shaped).
  const {
    data: roomStates,
    isLoading: loadingState,
    error: stateError,
  } = useQuery({
    queryKey: ['daily_room_state', checkIn, checkOut],
    queryFn: () => fetchRoomDayStates(checkIn, checkOut),
    enabled: datesValid,
  });

  const planRequest: BookingPlanRequest = useMemo(
    () => ({
      category,
      checkIn,
      checkOut,
      guests,
      preferredRoomType: preferredType === 'ANY' ? undefined : preferredType,
      preferSharing,
    }),
    [category, checkIn, checkOut, guests, preferredType, preferSharing],
  );

  const stayPlan = useMemo(
    () =>
      datesValid && roomStates && roomStates.length > 0
        ? planAllotment(planRequest, roomStates)
        : null,
    [datesValid, roomStates, planRequest],
  );

  // The stay's own dates can't reveal alternate windows, so when nothing fits we load room state
  // for the following 90 days and plan again.
  const needsHorizon = stayPlan !== null && stayPlan.kind !== 'ALLOT';
  const { data: horizonStates, isLoading: loadingHorizon } = useQuery({
    queryKey: ['daily_room_state', checkIn, alternatesHorizonEnd(checkOut)],
    queryFn: () => fetchRoomDayStates(checkIn, alternatesHorizonEnd(checkOut)),
    enabled: needsHorizon,
  });

  const plan = useMemo(() => {
    if (!stayPlan || stayPlan.kind === 'ALLOT') return stayPlan;
    return horizonStates ? planAllotment(planRequest, horizonStates) : stayPlan;
  }, [stayPlan, horizonStates, planRequest]);

  // Rooms that already hold someone during the stay: placing a guest there is "sharing".
  const roomsWithOccupants = useMemo(() => {
    const set = new Set<string>();
    for (const st of roomStates ?? []) if (st.occupants.length > 0) set.add(st.roomId);
    return set;
  }, [roomStates]);

  const noRoomsConfigured = datesValid && roomStates !== undefined && roomStates.length === 0;

  const handleAddGuest = () => {
    if (guests.length < 40) {
      // New guests start as a copy of the previous one: parties are usually same gender/rank.
      setGuests([...guests, { ...guests[guests.length - 1] }]);
    }
  };

  const handleRemoveGuest = (index: number) => {
    if (guests.length > 1) {
      setGuests(guests.filter((_, i) => i !== index));
    }
  };

  const handleUpdateGuest = (index: number, key: 'gender' | 'rankCode', val: Gender | RankCode) => {
    const updated = [...guests];
    updated[index] = { ...updated[index], [key]: val };
    setGuests(updated);
  };

  const handleAllotDirect = async () => {
    if (!plan || plan.kind !== 'ALLOT') return;
    setSubmitting(true);
    setBookingError(null);
    try {
      const { data: bookingId, error } = await supabase.rpc('create_booking', {
        p_booking: {
          category,
          check_in: checkIn,
          check_out: checkOut,
          party_size: guests.length,
          is_suite_booking: false,
        },
        p_guests: guests.map((g, idx) => ({
          seq: idx + 1,
          gender: g.gender,
          rank_code: g.rankCode,
        })),
        p_allocations: plan.assignments.map((a) => ({
          guest_seq: a.guestIndex + 1,
          room_id: a.roomId,
          bed_slot: a.bedSlot,
          check_in: checkIn,
          check_out: checkOut,
        })),
      });

      if (error) throw error;
      logAction('bookings.create', {
        entity: 'bookings',
        entityId: bookingId as string,
        meta: { category, party_size: guests.length, mode: 'auto' },
      });
      router.replace(`/(app)/bookings/${bookingId}/confirmed` as any);
    } catch (err: unknown) {
      setBookingError(userErrorMessage(err, 'Failed to allot booking'));
    } finally {
      setSubmitting(false);
    }
  };

  const payload = () =>
    JSON.stringify({ category, checkIn, checkOut, guests, plan, preferSharing });

  return (
    <Screen title="New Booking" showBack={true}>
      <View style={styles.container}>
        <Card>
          <Text style={[styles.sectionTitle, { color: colors.navy }]}>
            1. VISITOR CATEGORY & DATES
          </Text>

          <Select
            label="Visitor Category"
            value={category}
            onChange={(val: string) => setCategory(val as Category)}
            options={[
              { label: 'MSA · BA MSA', value: 'MSA' },
              { label: 'PI · Posted In', value: 'PI' },
              { label: 'LEAVE · On Leave', value: 'LEAVE' },
              { label: 'TD · Temp. Displacement', value: 'TD' },
            ]}
          />
          <Text style={[styles.helpText, { color: colors.muted, marginTop: -spacing.sm }]}>
            {category === 'MSA' &&
              'Highest priority, free of charge. Can displace PI, LEAVE and TD bookings.'}
            {category === 'PI' &&
              'High priority, free of charge. Can displace LEAVE and TD bookings.'}
            {category === 'LEAVE' && 'Paid, low priority. Can be offered other dates or denied.'}
            {category === 'TD' && 'Paid, low priority. Can be offered other dates or denied.'}
          </Text>

          <DateRange
            label="Stay Period"
            startDate={checkIn}
            endDate={checkOut}
            onStartDateChange={setCheckIn}
            onEndDateChange={setCheckOut}
          />

          {isBackdated && (
            <Banner
              type="warning"
              message="Check-in is in the past. Only an Administrator can create backdated bookings."
            />
          )}

          <Checkbox
            label="Prefer shared rooms"
            hint="Seat guests beside a compatible guest (same gender and rank) before opening an empty room. Applies to all room types."
            checked={preferSharing}
            onChange={setPreferSharing}
          />

          <Select
            label="Preferred Room Type (suites are booked separately)"
            value={preferredType}
            onChange={(val: string) => setPreferredType(val as RoomType | 'ANY')}
            options={[
              { label: 'VIP', value: 'VIP' },
              { label: 'Semi VIP', value: 'SEMI_VIP' },
              { label: 'Normal', value: 'NORMAL' },
              { label: 'No preference', value: 'ANY' },
            ]}
          />
        </Card>

        <Card style={styles.spaced}>
          <View style={styles.guestHeaderRow}>
            <Text style={[styles.sectionTitle, styles.noMargin, { color: colors.navy }]}>
              2. GUESTS ({guests.length} person{guests.length > 1 ? 's' : ''})
            </Text>
            <Button label="+ Add Guest" variant="secondary" onPress={handleAddGuest} />
          </View>
          <Text style={[styles.helpText, { color: colors.muted }]}>
            Gender and rank are required upfront to enforce room sharing rules (two guests share a
            room only with the same gender and rank). Names and ID numbers can be backfilled later.
          </Text>

          {guests.map((g, idx) => (
            <View key={idx} style={[styles.guestRow, { borderColor: colors.border }]}>
              <View style={styles.guestTitleRow}>
                <Text style={[styles.guestSeq, { color: colors.navy }]}>Guest {idx + 1}</Text>
                {guests.length > 1 && (
                  <Button
                    label="Remove"
                    variant="secondary"
                    accessibilityLabel={`Remove guest ${idx + 1}`}
                    onPress={() => handleRemoveGuest(idx)}
                  />
                )}
              </View>
              <Select
                label="Gender"
                value={g.gender}
                onChange={(val: string) => handleUpdateGuest(idx, 'gender', val as Gender)}
                options={[
                  { label: 'Male', value: 'M' },
                  { label: 'Female', value: 'F' },
                ]}
              />
              <Select
                label="Rank"
                value={g.rankCode}
                onChange={(val: string) => handleUpdateGuest(idx, 'rankCode', val as RankCode)}
                options={RANK_ORDER.map((r) => ({
                  label: `${r.label} (${r.code})`,
                  value: r.code,
                }))}
              />
            </View>
          ))}
        </Card>

        <Card style={styles.spaced}>
          <Text style={[styles.sectionTitle, { color: colors.navy }]}>Live availability</Text>

          {stateError ? (
            <Banner type="error" message={userErrorMessage(stateError, 'Could not load room availability.')} />
          ) : !datesValid ? (
            <Text style={[styles.planStatus, { color: colors.muted }]}>
              Enter a valid stay period to see room options.
            </Text>
          ) : loadingState || (needsHorizon && loadingHorizon) ? (
            <Text style={[styles.planStatus, { color: colors.muted }]}>
              {loadingState ? 'Checking room availability…' : 'Looking for other dates…'}
            </Text>
          ) : noRoomsConfigured ? (
            <Banner
              type="warning"
              message="No rooms are set up yet. An Administrator can add rooms under Rooms & Data."
            />
          ) : !plan ? null : plan.kind === 'ALLOT' ? (
            <View>
              <Banner
                type="success"
                message={`Available! All ${guests.length} guest${guests.length > 1 ? 's' : ''} can be accommodated for ${checkIn} → ${checkOut}.`}
              />
              {plan.usedFallbackType && (
                <Banner
                  type="warning"
                  message={`No ${ROOM_TYPE_LABEL[preferredType] ?? ''} room is free for these guests and dates. Other room types are used instead.`}
                />
              )}

              <View style={[styles.proposal, { borderColor: colors.border }]}>
                <Text style={[styles.proposalTitle, { color: colors.navy }]}>Proposed placement</Text>
                {[...plan.assignments]
                  .sort((a, b) => a.guestIndex - b.guestIndex)
                  .map((a) => (
                    <Text key={a.guestIndex} style={[styles.proposalRow, { color: colors.text }]}>
                      Guest {a.guestIndex + 1} → {roomNames?.[a.roomId] ?? '…'} (
                      {ROOM_TYPE_LABEL[a.roomType] ?? a.roomType}), Bed {a.bedSlot}
                      {roomsWithOccupants.has(a.roomId) ? ' — shares with a current guest' : ''}
                    </Text>
                  ))}
              </View>

              <View style={styles.actionButtons}>
                <Button
                  label="Confirm & Allot Now"
                  onPress={handleAllotDirect}
                  loading={submitting}
                  disabled={isBackdated}
                />
                <Button
                  label="Customise Bed Placement"
                  variant="secondary"
                  disabled={isBackdated}
                  onPress={() => {
                    router.push({
                      pathname: '/(app)/bookings/new/rooms',
                      params: { payload: payload() },
                    } as any);
                  }}
                />
              </View>
            </View>
          ) : (
            <View>
              <Banner
                type="error"
                message={
                  plan.kind === 'ALTERNATES'
                    ? 'No room is free for these guests on the selected dates, but other dates work.'
                    : 'No rooms are free for these guests on the selected dates or in the next 90 days.'
                }
              />
              <Text style={[styles.summaryText, { color: colors.text }]}>
                {category === 'MSA' || category === 'PI'
                  ? 'This category has priority: you can review lower-priority bookings for displacement.'
                  : 'You can offer other dates or deny the request with a recorded reason.'}
              </Text>
              <Button
                label={
                  category === 'MSA' || category === 'PI'
                    ? 'See Dates & Eviction Options'
                    : 'See Alternate Dates & Options'
                }
                variant="primary"
                disabled={isBackdated}
                onPress={() => {
                  router.push({
                    pathname: '/(app)/bookings/new/alternates',
                    params: { payload: payload() },
                  } as any);
                }}
              />
            </View>
          )}

          {bookingError && (
            <Banner type="error" message={bookingError} style={{ marginTop: spacing.md }} />
          )}
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  spaced: {
    marginTop: spacing.md,
  },
  sectionTitle: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
    marginBottom: spacing.md,
  },
  noMargin: {
    marginBottom: 0,
  },
  guestHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  helpText: {
    fontSize: typography.xs,
    marginBottom: spacing.md,
  },
  guestRow: {
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
  },
  guestTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  guestSeq: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
  },
  planStatus: {
    fontSize: typography.sm,
    marginVertical: spacing.md,
  },
  summaryText: {
    fontSize: typography.sm,
    marginBottom: spacing.md,
  },
  proposal: {
    borderWidth: 1,
    borderRadius: 4,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.xs,
  },
  proposalTitle: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
  },
  proposalRow: {
    fontSize: typography.sm,
  },
  actionButtons: {
    gap: spacing.sm,
  },
});
