import React, { useState } from 'react';
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
import { spacing, typography } from '../../../../src/ui/tokens';
import { supabase } from '../../../../src/lib/supabase';
import { logAction } from '../../../../src/lib/activityLog';
import { describeAuditAction } from '../../../../src/lib/auditLabels';
import { userErrorMessage } from '../../../../src/lib/userError';
import {
  decryptGuestPii,
  decryptRoomName,
  encryptReason,
  getActiveKeyVersion,
} from '../../../../src/features/crypto-session/cryptoSession';
import { humanizeStatus } from '../../../../src/lib/labels';
import { describeGuest } from '../../../../src/features/bookings/party';

export default function BookingDetailRecordScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const queryClient = useQueryClient();
  const { userRole, userPermissions } = useSessionStore();

  const canReveal = userRole === 'admin' || userPermissions.includes('reveal_guest_pii');
  const canCancel = userRole === 'admin' || userPermissions.includes('cancel_booking');

  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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
    const pii = decryptGuestPii(guestId, cipher);
    const guest = booking?.booking_guests?.find((g: any) => g.id === guestId);
    if (guest && !guest.rank_code) return `${pii.name} (Phone: ${pii.phone || 'N/A'})`;
    return `${pii.name} (Service No: ${pii.serviceNumber || 'N/A'}, Phone: ${pii.phone || 'N/A'}, Unit: ${pii.unit || 'N/A'})`;
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

  return (
    <Screen title="Booking Record" showBack={true}>
      <View style={styles.container}>
        {/* Main Card */}
        <Card>
          <View style={styles.headerRow}>
            <View>
              <Text style={[styles.title, { color: colors.navy }]}>Booking #{id?.slice(0, 8)}</Text>
              <Text style={[styles.subtitle, { color: colors.muted }]}>
                {booking?.check_in} to {booking?.check_out} ({booking?.party_size} person(s))
              </Text>
            </View>
            <Badge
              label={humanizeStatus(booking?.status || 'CONFIRMED')}
              variant={
                booking?.status === 'CONFIRMED'
                  ? 'success'
                  : booking?.status === 'DISPLACED'
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
              <Text style={[styles.label, { color: colors.muted }]}>Created At</Text>
              <Text style={[styles.value, { color: colors.text }]}>
                {booking?.created_at ? new Date(booking.created_at).toLocaleString() : 'N/A'}
              </Text>
            </View>
          </View>

          {booking?.status === 'CONFIRMED' && canCancel && (
            <Button
              label="Cancel Booking"
              variant="destructive"
              onPress={() => setShowCancelDialog(true)}
              style={{ marginTop: spacing.md }}
            />
          )}

          {errorMsg && <Banner type="error" message={errorMsg} style={{ marginTop: spacing.sm }} />}
        </Card>

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
                <Text style={[styles.guestName, { color: colors.navy }]}>
                  #{idx + 1}: {describeGuest(guest)}
                </Text>
                <Badge
                  label={guest.details === 'COMPLETE' ? 'Details Complete' : 'Details Pending'}
                  variant={guest.details === 'COMPLETE' ? 'success' : 'warning'}
                />
              </View>

              <MaskedValue
                label="Guest Identity & Contact"
                maskedText="•••••••• •••••••••••• (Masked for privacy)"
                onReveal={() => fetchGuestPii(guest.id)}
                canReveal={canReveal}
              />
            </View>
          ))}
        </Card>

        {/* Allocations Section */}
        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.sectionTitle, { color: colors.navy }]}>Room and bed allocations</Text>
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
});
