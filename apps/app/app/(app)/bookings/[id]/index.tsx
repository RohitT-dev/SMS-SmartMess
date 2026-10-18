import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useThemeStore } from '../../../../src/state/themeStore';
import { useSessionStore } from '../../../../src/state/sessionStore';
import { Screen } from '../../../../src/ui/primitives/Screen';
import { Card } from '../../../../src/ui/primitives/Card';
import { Badge } from '../../../../src/ui/primitives/Badge';
import { Button } from '../../../../src/ui/primitives/Button';
import { MaskedValue } from '../../../../src/ui/primitives/MaskedValue';
import { Dialog } from '../../../../src/ui/primitives/Dialog';
import { Field } from '../../../../src/ui/primitives/Field';
import { Banner } from '../../../../src/ui/primitives/Banner';
import { Checkbox } from '../../../../src/ui/primitives/Checkbox';
import { DateRange } from '../../../../src/ui/primitives/DateRange';
import { spacing, typography } from '../../../../src/ui/tokens';
import { supabase } from '../../../../src/lib/supabase';
import { logAction } from '../../../../src/lib/activityLog';
import { describeAuditAction } from '../../../../src/lib/auditLabels';
import { userErrorMessage } from '../../../../src/lib/userError';
import { localDateString, isValidDateString } from '../../../../src/lib/dates';
import {
  decryptGuestPii,
  decryptRoomName,
  encryptReason,
  getActiveKeyVersion,
} from '../../../../src/features/crypto-session/cryptoSession';
import { humanizeStatus } from '../../../../src/lib/labels';
import { describeGuest } from '../../../../src/features/bookings/party';
import {
  guestName,
  guestPhone,
  guestRankOrRelation,
  guestServiceNumber,
  guestUnit,
} from '../../../../src/features/bookings/guestDisplay';
import { fetchRoomDayStates } from '../../../../src/features/bookings/roomState';
import { alternatesHorizonEnd } from '../../../../src/features/bookings/planBooking';
import { useRoomNames } from '../../../../src/features/rooms/useRoomNames';
import {
  planAllotment,
  type Category,
  type Gender,
  type RankCode,
  type GuestRelation,
  type GuestDemand,
  type RoomType,
} from '@sms/core';

export default function BookingDetailRecordScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const queryClient = useQueryClient();
  const { userRole, userPermissions } = useSessionStore();
  const today = localDateString();

  const canReveal = userRole === 'admin' || userPermissions.includes('reveal_guest_pii');
  const canCancel = userRole === 'admin' || userPermissions.includes('cancel_booking');
  const canEditDates = userRole === 'admin' || userPermissions.includes('create_booking');
  const canAllot = userRole === 'admin' || userPermissions.includes('create_booking');

  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [showEditDatesDialog, setShowEditDatesDialog] = useState(false);
  const [editCheckIn, setEditCheckIn] = useState('');
  const [editCheckOut, setEditCheckOut] = useState('');
  const [savingDates, setSavingDates] = useState(false);
  const [editDatesError, setEditDatesError] = useState<string | null>(null);

  const [allotting, setAllotting] = useState(false);
  const [allotError, setAllotError] = useState<string | null>(null);

  // 1. Fetch booking details
  const { data: booking } = useQuery({
    queryKey: ['booking_record', id],
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

  const guestsBySeq = [...(booking?.booking_guests ?? [])].sort((x: any, y: any) => x.seq - y.seq);
  const guestNo = (guestId: string) => {
    const i = guestsBySeq.findIndex((g: any) => g.id === guestId);
    return i === -1 ? null : i + 1;
  };

  const activeAllocs = (booking?.allocations || []).filter((a: any) => a.status === 'ACTIVE');
  const isPendingAllotment =
    booking?.status === 'PENDING_ALLOTMENT' ||
    (booking?.status === 'CONFIRMED' && activeAllocs.length === 0);
  const { data: roomNames } = useRoomNames();

  const { data: roomStates, isLoading: loadingRoomStates } = useQuery({
    // Past the stay itself up to the alternate-window horizon, so a full house can offer new dates.
    queryKey: ['daily_room_state', 'allotment_plan', booking?.check_in, booking?.check_out],
    queryFn: () => fetchRoomDayStates(booking!.check_in, alternatesHorizonEnd(booking!.check_out)),
    enabled: isPendingAllotment && !!booking?.check_in && !!booking?.check_out,
  });

  const guestsDemand: GuestDemand[] = useMemo(() => {
    if (!booking?.booking_guests) return [];
    return [...booking.booking_guests]
      .sort((a, b) => a.seq - b.seq)
      .map((g: any) => ({
        gender: g.gender as Gender,
        rankCode: (g.rank_code ?? null) as RankCode | null,
        relation: g.relation as GuestRelation,
      }));
  }, [booking?.booking_guests]);

  const allotmentPlan = useMemo(() => {
    if (!isPendingAllotment || !roomStates || roomStates.length === 0 || guestsDemand.length === 0 || !booking) {
      return null;
    }
    return planAllotment(
      {
        category: booking.category as Category,
        checkIn: booking.check_in,
        checkOut: booking.check_out,
        guests: guestsDemand,
        preferredRoomType: (booking.preferred_room_type ?? undefined) as RoomType | undefined,
        // "Allow room sharing" as saved on the request: off offers only fully vacant rooms.
        allowSharing: booking.allow_sharing !== false,
      },
      roomStates,
    );
  }, [isPendingAllotment, roomStates, booking, guestsDemand]);

  const [savingSharing, setSavingSharing] = useState(false);
  const handleToggleSharing = async (next: boolean) => {
    setSavingSharing(true);
    setErrorMsg(null);
    try {
      const { error } = await supabase.rpc('set_booking_allow_sharing', { p_booking_id: id, p_allow: next });
      if (error) throw error;
      logAction('bookings.set_sharing', { entity: 'bookings', entityId: id, meta: { allow_sharing: next } });
      queryClient.invalidateQueries({ queryKey: ['booking_record', id] });
      queryClient.invalidateQueries({ queryKey: ['booking_audit', id] });
      queryClient.invalidateQueries({ queryKey: ['bookings_ledger'] });
      queryClient.invalidateQueries({ queryKey: ['pending_booking_requests'] });
    } catch (err: unknown) {
      setErrorMsg(userErrorMessage(err, 'Could not change room sharing'));
    } finally {
      setSavingSharing(false);
    }
  };

  const handleAllotSuggested = async () => {
    if (!allotmentPlan || allotmentPlan.kind !== 'ALLOT' || !booking) return;
    setAllotting(true);
    setAllotError(null);
    try {
      const allocs = allotmentPlan.assignments.map((a) => ({
        guest_seq: a.guestIndex + 1,
        room_id: a.roomId,
        bed_slot: a.bedSlot,
      }));
      const { error } = await supabase.rpc('allot_booking_rooms', {
        p_booking_id: id,
        p_allocations: allocs,
      });
      if (error) {
        if (error.code === 'PGRST202' || error.message?.includes('schema cache')) {
          openCustomPlacement();
          return;
        }
        throw error;
      }
      logAction('bookings.allot', {
        entity: 'bookings',
        entityId: id,
        meta: { mode: 'auto', party_size: guestsDemand.length },
      });
      queryClient.invalidateQueries({ queryKey: ['booking_record', id] });
      queryClient.invalidateQueries({ queryKey: ['booking_audit', id] });
      queryClient.invalidateQueries({ queryKey: ['daily_room_state'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard_counts'] });
      queryClient.invalidateQueries({ queryKey: ['bookings_ledger'] });
    } catch (err: unknown) {
      setAllotError(userErrorMessage(err, 'Failed to allot suggested rooms'));
    } finally {
      setAllotting(false);
    }
  };

  const openResolution = () => {
    if (!booking) return;
    router.push({
      pathname: '/(app)/bookings/new/alternates',
      params: {
        payload: JSON.stringify({
          bookingId: booking.id,
          category: booking.category,
          checkIn: booking.check_in,
          checkOut: booking.check_out,
          preferredRoomType: booking.preferred_room_type || undefined,
          allowSharing: booking.allow_sharing !== false,
          guests: guestsDemand,
        }),
      },
    } as any);
  };

  const openCustomPlacement = () => {
    if (!booking) return;
    const sortedGuests = [...(booking.booking_guests || [])].sort((a: any, b: any) => a.seq - b.seq);
    const payload = JSON.stringify({
      bookingId: booking.id,
      category: booking.category,
      checkIn: booking.check_in,
      checkOut: booking.check_out,
      preferredRoomType: booking.preferred_room_type || undefined,
      allowSharing: booking.allow_sharing !== false,
      guests: sortedGuests.map((g: any) => ({
        gender: g.gender as Gender,
        rankCode: (g.rank_code ?? null) as RankCode | null,
        relation: g.relation as GuestRelation,
        name: g.guest_name || undefined,
        serviceNumber: g.service_number || undefined,
        unit: g.unit || undefined,
        phone: g.phone || undefined,
      })),
      plan: allotmentPlan?.kind === 'ALLOT' ? allotmentPlan : undefined,
    });
    router.push({
      pathname: '/(app)/bookings/new/rooms',
      params: { payload },
    } as any);
  };

  // 2. Fetch timeline from audit_log (no PII in audit_log meta)
  const { data: auditEvents } = useQuery({
    queryKey: ['booking_audit', id],
    queryFn: async () => {
      const { data } = await supabase
        .from('audit_log')
        .select('*')
        .eq('entity_id', id)
        .order('at', { ascending: true });
      return data || [];
    },
  });

  const fetchGuestPii = async (guestId: string) => {
    const { data: cipher, error } = await supabase.rpc('get_guest_pii', {
      p_guest_id: guestId,
    });
    if (error) throw error;
    logAction('guests.pii_revealed', {
      entity: 'guest_pii',
      entityId: guestId,
      meta: { booking_id: id },
    });
    if (!cipher) return 'Details Pending';
    // Name, unit, service number and phone are shown in plain text on the guest card; only the
    // ID number and remarks are encrypted.
    const pii = decryptGuestPii(guestId, cipher);
    const parts = [
      `${pii.idType?.trim() || 'ID'}: ${pii.idNumber?.trim() || 'N/A'}`,
      pii.notes?.trim() ? `Notes: ${pii.notes.trim()}` : null,
    ];
    return parts.filter(Boolean).join(' · ');
  };

  const handleCancelBooking = async () => {
    if (!cancelReason.trim()) return;
    setCancelling(true);
    setErrorMsg(null);
    try {
      const reasonEnc = encryptReason('bookings', 'cancel_reason_enc', id, cancelReason.trim());

      const { error } = await supabase.rpc('cancel_booking', {
        p_id: id,
        p_reason_enc: reasonEnc,
        p_key_version: getActiveKeyVersion(),
      });

      if (error) throw error;
      logAction('bookings.cancel', { entity: 'bookings', entityId: id });
      setShowCancelDialog(false);
      setCancelReason('');
      queryClient.invalidateQueries({ queryKey: ['booking_record', id] });
      queryClient.invalidateQueries({ queryKey: ['booking_audit', id] });
      // Released beds must show as free everywhere straight away.
      queryClient.invalidateQueries({ queryKey: ['daily_room_state'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard_counts'] });
      queryClient.invalidateQueries({ queryKey: ['bookings_ledger'] });
    } catch (err: any) {
      setErrorMsg(userErrorMessage(err, 'Failed to cancel booking'));
    } finally {
      setCancelling(false);
    }
  };

  const canEditThisBooking = booking?.is_suite_booking ? userRole === 'admin' : canEditDates;
  const hasStarted = !!booking && booking.check_in <= today;
  const isDatesValid = isValidDateString(editCheckIn) && isValidDateString(editCheckOut) && editCheckOut > editCheckIn;
  const isDatesChanged = !!booking && (editCheckIn !== booking.check_in || editCheckOut !== booking.check_out);
  const isLeaveEarly = !!booking && isDatesValid && editCheckOut < booking.check_out;
  const isExtension = !!booking && isDatesValid && editCheckOut > booking.check_out;

  const openEditDatesDialog = () => {
    if (!booking) return;
    setEditCheckIn(booking.check_in);
    setEditCheckOut(booking.check_out);
    setEditDatesError(null);
    setShowEditDatesDialog(true);
  };

  const handleUpdateDates = async () => {
    if (!booking || !isDatesValid || !isDatesChanged) return;
    setSavingDates(true);
    setEditDatesError(null);
    try {
      const { error } = await supabase.rpc('update_booking_dates', {
        p_booking_id: id,
        p_new_check_in: editCheckIn,
        p_new_check_out: editCheckOut,
      });
      if (error) throw error;
      logAction('bookings.update_dates', {
        entity: 'bookings',
        entityId: id,
        meta: {
          old_check_in: booking.check_in,
          old_check_out: booking.check_out,
          new_check_in: editCheckIn,
          new_check_out: editCheckOut,
        },
      });
      setShowEditDatesDialog(false);
      queryClient.invalidateQueries({ queryKey: ['booking_record', id] });
      queryClient.invalidateQueries({ queryKey: ['booking_audit', id] });
      queryClient.invalidateQueries({ queryKey: ['daily_room_state'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard_counts'] });
      queryClient.invalidateQueries({ queryKey: ['bookings_ledger'] });
    } catch (err: unknown) {
      setEditDatesError(userErrorMessage(err, 'Failed to update stay dates.'));
    } finally {
      setSavingDates(false);
    }
  };

  return (
    <Screen title="Booking Record" showBack={true}>
      <View style={styles.container}>
        {/* Main Card */}
        <Card>
          <View style={styles.headerRow}>
            <View>
              <Text style={[styles.title, { color: colors.navy }]}>Booking #{id?.slice(0, 8)}</Text>
              <Text style={[styles.subtitle, { color: colors.muted }]}>
                📅 {booking?.check_in} (12:00 PM) to {booking?.check_out} (12:00 PM) • {booking?.party_size} person(s)
              </Text>
            </View>
            <Badge
              label={humanizeStatus(booking?.status || 'CONFIRMED')}
              variant={
                booking?.status === 'CONFIRMED'
                  ? 'success'
                  : booking?.status === 'PENDING_ALLOTMENT' || booking?.status === 'DISPLACED'
                    ? 'warning'
                    : booking?.status === 'CANCELLED'
                      ? 'error'
                      : 'default'
              }
            />
          </View>

          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          <View style={styles.grid}>
            <View style={styles.gridCol}>
              <Text style={[styles.label, { color: colors.muted }]}>Category</Text>
              <Text style={[styles.value, { color: colors.text }]}>{booking?.category}</Text>
            </View>
            <View style={styles.gridCol}>
              <Text style={[styles.label, { color: colors.muted }]}>Suite Booking</Text>
              <Text style={[styles.value, { color: colors.text }]}>
                {booking?.is_suite_booking ? 'Yes (AM/VVIP)' : 'No'}
              </Text>
            </View>
            <View style={styles.gridCol}>
              <Text style={[styles.label, { color: colors.muted }]}>Room Sharing</Text>
              <Text style={[styles.value, { color: colors.text }]}>
                {booking?.allow_sharing === false ? 'Not allowed' : 'Allowed'}
              </Text>
            </View>
            <View style={styles.gridCol}>
              <Text style={[styles.label, { color: colors.muted }]}>Created At</Text>
              <Text style={[styles.value, { color: colors.text }]}>
                {booking?.created_at ? new Date(booking.created_at).toLocaleString() : 'N/A'}
              </Text>
            </View>
          </View>

          {(booking?.status === 'CONFIRMED' || booking?.status === 'PENDING_ALLOTMENT') && (
            <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, flexWrap: 'wrap' }}>
              {canEditThisBooking && (
                <Button
                  label="Change Stay Dates (Leave Early / Extend)"
                  variant="secondary"
                  onPress={openEditDatesDialog}
                />
              )}
              {canCancel && (
                <Button
                  label={booking?.status === 'PENDING_ALLOTMENT' ? 'Cancel Request' : 'Cancel Booking'}
                  variant="destructive"
                  onPress={() => setShowCancelDialog(true)}
                />
              )}
            </View>
          )}

          {errorMsg && <Banner type="error" message={errorMsg} style={{ marginTop: spacing.sm }} />}
        </Card>

        {/* Room Allotment Suggestions Section for Pending Bookings */}
        {isPendingAllotment && (
          <Card style={{ marginTop: spacing.md }}>
            <View style={styles.sectionHeaderRow}>
              <Text style={[styles.sectionTitle, { color: colors.navy }]}>Room allotment suggestions</Text>
              <Badge label="Suggestions Live" variant="warning" />
            </View>
            <Text style={[styles.helpText, { color: colors.muted }]}>
              Automated allotment suggestions computed from live room inventory and the room sharing rules
              (ranked guests share with the same gender, any rank; civilians only within their own booking).
            </Text>
            {canAllot && (
              <Checkbox
                label="Allow room sharing"
                hint={
                  booking?.allow_sharing !== false
                    ? 'Fully vacant rooms and rooms with a free bed beside a compatible guest are suggested.'
                    : 'Only fully vacant rooms are suggested; this booking holds each room it uses.'
                }
                checked={booking?.allow_sharing !== false}
                onChange={handleToggleSharing}
                disabled={savingSharing || !booking}
              />
            )}

            {loadingRoomStates ? (
              <Text style={{ color: colors.muted, marginVertical: spacing.sm, fontSize: typography.sm }}>
                Checking room availability for allotment suggestions…
              </Text>
            ) : !allotmentPlan ? null : allotmentPlan.kind === 'ALLOT' ? (
              <View>
                <Banner
                  type="success"
                  message={`Rooms Available! All ${guestsDemand.length} guest${guestsDemand.length > 1 ? 's' : ''} can be accommodated for ${booking?.check_in} (12 PM) → ${booking?.check_out} (12 PM).`}
                />
                {allotmentPlan.usedFallbackType && (
                  <Banner
                    type="warning"
                    message="Fallback room types used to satisfy guest sharing constraints."
                    style={{ marginTop: spacing.xs }}
                  />
                )}

                <View style={[styles.proposal, { borderColor: colors.border, marginTop: spacing.sm }]}>
                  <Text style={[styles.proposalTitle, { color: colors.navy }]}>Suggested Bed Placement</Text>
                  {[...allotmentPlan.assignments]
                    .sort((a, b) => a.guestIndex - b.guestIndex)
                    .map((a) => {
                      const guest = booking?.booking_guests?.find((g: any) => g.seq === a.guestIndex + 1);
                      return (
                        <Text key={a.guestIndex} style={[styles.proposalRow, { color: colors.text }]}>
                          {guest ? guestName(guest, null, a.guestIndex) : `Guest #${a.guestIndex + 1}`} ({guest ? `${guestRankOrRelation(guest)}, ${guest.gender === 'M' ? 'Male' : 'Female'}` : ''}) → Room{' '}
                          <Text style={{ fontWeight: 'bold' }}>{roomNames?.[a.roomId] ?? '…'}</Text> ({a.roomType}), Bed Slot <Text style={{ fontWeight: 'bold' }}>{a.bedSlot}</Text>
                        </Text>
                      );
                    })}
                </View>

                {allotError && (
                  <Banner type="error" message={allotError} style={{ marginTop: spacing.sm }} />
                )}

                {canAllot && (
                  <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, flexWrap: 'wrap' }}>
                    <Button
                      label="Allot Suggested Rooms"
                      variant="primary"
                      loading={allotting}
                      onPress={handleAllotSuggested}
                    />
                    <Button
                      label="Choose Room & Assign Bed →"
                      variant="secondary"
                      disabled={allotting}
                      onPress={openCustomPlacement}
                    />
                  </View>
                )}
              </View>
            ) : (
              <View>
                <Banner
                  type="warning"
                  message="Currently no free rooms or compatible beds automatically match this request for the requested dates. You can manually inspect and assign any available room."
                />
                {allotmentPlan.kind === 'ALTERNATES' ? (
                  <Text style={{ color: colors.muted, marginTop: spacing.sm, fontSize: typography.sm }}>
                    Next free window of the same length starts {allotmentPlan.windows[0].checkIn}.
                  </Text>
                ) : null}
                {canAllot && (
                  <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
                    <Button
                      label="Alternate dates, eviction or denial →"
                      variant="primary"
                      onPress={openResolution}
                    />
                    <Button
                      label="Choose Room & Assign Bed →"
                      variant="secondary"
                      onPress={openCustomPlacement}
                    />
                  </View>
                )}
              </View>
            )}
          </Card>
        )}

        {/* Guests Section */}
        <Card style={{ marginTop: spacing.md }}>
          <View style={styles.sectionHeaderRow}>
            <Text style={[styles.sectionTitle, { color: colors.navy }]}>Guests and personal details</Text>
            <Button
              label="Edit / Backfill Details"
              variant="secondary"
              onPress={() => router.push(`/(app)/bookings/${id}/guests` as any)}
            />
          </View>

          {guestsBySeq.map((guest: any, idx: number) => (
            <View key={guest.id} style={[styles.guestItem, { borderColor: colors.border }]}>
              <View style={styles.guestItemHeader}>
                <View>
                  <Text style={[styles.guestName, { color: colors.navy }]}>
                    #{idx + 1}: {guestName(guest, null, idx)}
                  </Text>
                  <Text style={{ fontSize: typography.sm, color: colors.text, marginTop: 2 }}>
                    {describeGuest(guest)}
                  </Text>
                  {guestUnit(guest) || guestServiceNumber(guest) || guestPhone(guest) ? (
                    <Text style={{ fontSize: typography.sm, color: colors.muted, marginTop: 2 }}>
                      {[
                        guestUnit(guest) && `Unit: ${guestUnit(guest)}`,
                        guestServiceNumber(guest) && `Service No: ${guestServiceNumber(guest)}`,
                        guestPhone(guest) && `Phone: ${guestPhone(guest)}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  ) : null}
                  {guest.guest_code ? (
                    <Text style={{ fontSize: typography.xs, color: colors.blue, fontWeight: 'bold', marginTop: 2 }}>
                      Unique Guest ID: {guest.guest_code}
                    </Text>
                  ) : null}
                </View>
                <Badge
                  label={guest.details === 'COMPLETE' ? 'Details Complete' : 'Details Pending'}
                  variant={guest.details === 'COMPLETE' ? 'success' : 'warning'}
                />
              </View>

              <MaskedValue
                label="ID Number & Notes"
                maskedText="•••••••• •••••••••••• (Encrypted; reveal to read)"
                onReveal={() => fetchGuestPii(guest.id)}
                canReveal={canReveal}
              />
            </View>
          ))}
        </Card>

        {/* Allocations Section */}
        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.sectionTitle, { color: colors.navy }]}>Room and bed allocations</Text>
          {isPendingAllotment && (
            <Text style={{ color: colors.muted, marginVertical: spacing.sm, fontSize: typography.sm }}>
              No rooms allotted yet. Review the suggestions above to allot rooms and beds to guests.
            </Text>
          )}
          {booking?.allocations?.map((a: any) => (
            <View key={a.id} style={[styles.allocRow, { borderColor: colors.border }]}>
              <Text style={[styles.allocText, { color: colors.text }]}>
                Room:{' '}
                <Text style={{ fontWeight: 'bold' }}>
                  {decryptRoomName(a.room_id, a.rooms?.name_enc)}
                </Text>{' '}
                • Bed Slot: <Text style={{ fontWeight: 'bold' }}>{a.bed_slot}</Text>
                {guestNo(a.guest_id) ? ` • Person #${guestNo(a.guest_id)}` : ''}
              </Text>
              <Badge label={humanizeStatus(a.status)} variant={a.status === 'ACTIVE' ? 'success' : 'default'} />
            </View>
          ))}
        </Card>

        {/* Audit Timeline */}
        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.sectionTitle, { color: colors.navy }]}>
            TIMELINE & AUDIT HISTORY
          </Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Verified cryptographic audit trail. No personal data is stored in the audit log.
          </Text>

          {(auditEvents || []).map((ev: any) => (
            <View key={ev.id} style={[styles.timelineItem, { borderColor: colors.border }]}>
              <View style={[styles.timelinePoint, { backgroundColor: colors.blue }]} />
              <View>
                <Text style={[styles.timelineAction, { color: colors.navy }]}>
                  {describeAuditAction(ev.action)}
                </Text>
                <Text style={[styles.timelineTime, { color: colors.muted }]}>
                  {new Date(ev.at).toLocaleString()}
                </Text>
              </View>
            </View>
          ))}
        </Card>

        {/* Cancel Dialog */}
        <Dialog
          visible={showCancelDialog}
          title="Cancel Booking"
          message="Are you sure you want to cancel this booking? All room allocations will be released back into inventory."
          confirmLabel="Confirm Cancellation"
          confirmVariant="destructive"
          disabled={!cancelReason.trim()}
          onConfirm={handleCancelBooking}
          onCancel={() => {
            setShowCancelDialog(false);
            setCancelReason('');
          }}
          loading={cancelling}
        >
          <Field
            label="Cancellation Reason (Encrypted)"
            value={cancelReason}
            onChangeText={setCancelReason}
            placeholder="e.g. Official duty cancelled, flight diverted..."
            multiline={true}
          />
        </Dialog>

        {/* Edit Stay Dates Dialog */}
        <Dialog
          visible={showEditDatesDialog}
          title="Change Stay Dates"
          message="Modify check-in or check-out dates. Leaving early releases room and bed inventory back to the mess; extending stays requires room and bed availability."
          confirmLabel="Save Changes"
          confirmVariant="primary"
          disabled={!isDatesValid || !isDatesChanged}
          onConfirm={handleUpdateDates}
          onCancel={() => {
            setShowEditDatesDialog(false);
            setEditDatesError(null);
          }}
          loading={savingDates}
        >
          <View style={{ gap: spacing.sm }}>
            <DateRange
              label="Stay Period"
              startDate={editCheckIn}
              endDate={editCheckOut}
              onStartDateChange={hasStarted ? undefined : setEditCheckIn}
              onEndDateChange={setEditCheckOut}
              disabled={savingDates}
            />

            {hasStarted && (
              <Text style={{ fontSize: typography.xs, color: colors.muted }}>
                Stay has already commenced. Check-in date ({booking?.check_in}) is locked.
              </Text>
            )}

            {isLeaveEarly && (
              <Banner
                type="info"
                message={`Early departure: Check-out moved from ${booking?.check_out} to ${editCheckOut}. Bed inventory will be released early.`}
              />
            )}

            {isExtension && (
              <Banner
                type="info"
                message={`Stay extension: Extending stay from ${booking?.check_out} to ${editCheckOut}. Requires room and bed availability.`}
              />
            )}

            {editDatesError && <Banner type="error" message={editDatesError} />}
          </View>
        </Dialog>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  headerRow: {
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
  divider: {
    height: 1,
    marginVertical: spacing.md,
  },
  grid: {
    flexDirection: 'row',
    gap: spacing.lg,
  },
  gridCol: {
    flex: 1,
  },
  label: {
    fontSize: typography.xs,
    fontWeight: typography.weights.medium,
  },
  value: {
    fontSize: typography.sm,
    fontWeight: typography.weights.medium,
    marginTop: 2,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
  },
  guestItem: {
    borderTopWidth: 1,
    paddingVertical: spacing.sm,
  },
  guestItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  guestName: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
  },
  allocRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
  },
  allocText: {
    fontSize: typography.sm,
  },
  timelineItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
  },
  timelinePoint: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  timelineAction: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
  },
  timelineTime: {
    fontSize: typography.xs,
  },
  proposal: {
    borderWidth: 1,
    borderRadius: 4,
    padding: spacing.md,
    gap: spacing.xs,
  },
  proposalTitle: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
  },
  proposalRow: {
    fontSize: typography.sm,
  },
  helpText: {
    fontSize: typography.xs,
    marginBottom: spacing.sm,
  },
  planStatus: {
    fontSize: typography.sm,
    marginVertical: spacing.md,
  },
});
