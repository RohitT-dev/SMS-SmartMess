import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useThemeStore } from '../../../../src/state/themeStore';
import { useSessionStore } from '../../../../src/state/sessionStore';
import { Screen } from '../../../../src/ui/primitives/Screen';
import { Card } from '../../../../src/ui/primitives/Card';
import { Button } from '../../../../src/ui/primitives/Button';
import { Field } from '../../../../src/ui/primitives/Field';
import { Banner } from '../../../../src/ui/primitives/Banner';
import { Badge } from '../../../../src/ui/primitives/Badge';
import { Dialog } from '../../../../src/ui/primitives/Dialog';
import { spacing, typography } from '../../../../src/ui/tokens';
import { supabase } from '../../../../src/lib/supabase';
import { randomUUID } from 'expo-crypto';
import { logAction } from '../../../../src/lib/activityLog';
import { userErrorMessage } from '../../../../src/lib/userError';
import { fetchRoomDayStates } from '../../../../src/features/bookings/roomState';
import {
  encryptReason,
  decryptRoomName,
  getActiveKeyVersion,
} from '../../../../src/features/crypto-session/cryptoSession';
import {
  canShareRoom,
  rankCandidates,
  type Category,
  type GuestDemand,
  type EvictionCandidate,
  type SharingPerson,
} from '@sms/core';
import { guestRowsPayload, seatPartyOnBeds, type FreedBed } from '../../../../src/features/bookings/planBooking';

/** Stand-in booking id for the incoming party, which has no id until it is created. */
const INCOMING = 'incoming';

interface ParsedPayload {
  /** The pending request being resolved; absent for a party that has no booking yet. */
  bookingId?: string;
  category: Category;
  checkIn: string;
  checkOut: string;
  /** "Allow room sharing" of the incoming request; off, it cannot be seated beside anyone who stays. */
  allowSharing?: boolean;
  guests: GuestDemand[];
}

export default function EvictionReviewScreen() {
  const { payload } = useLocalSearchParams<{ payload: string }>();
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const { userRole, userPermissions } = useSessionStore();
  const queryClient = useQueryClient();

  const canApprove = userRole === 'admin' || userPermissions.includes('approve_eviction');

  let parsed: ParsedPayload | null = null;
  try {
    parsed = payload ? (JSON.parse(payload) as ParsedPayload) : null;
  } catch {
    parsed = null;
  }
  const { bookingId, category, checkIn, checkOut, guests, allowSharing } = parsed || {
    bookingId: undefined,
    category: 'MFA' as Category,
    checkIn: '',
    checkOut: '',
    guests: [],
    allowSharing: undefined,
  };

  const [selectedAllocationIds, setSelectedAllocationIds] = useState<string[]>([]);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [writtenReason, setWrittenReason] = useState('');
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const [approving, setApproving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Fetch unranked eviction candidates from RPC
  const { data: rawCandidates, isLoading } = useQuery({
    queryKey: ['eviction_candidates', category, checkIn, checkOut, guests],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('eviction_candidates', {
        p_category: category,
        p_check_in: checkIn,
        p_check_out: checkOut,
        p_guests: guestRowsPayload(guests),
      });
      if (error) throw error;

      // Map room names and return typed candidate objects
      const mapped: EvictionCandidate[] = (data || []).map((row: any) => ({
        allocationId: row.allocation_id,
        bookingId: row.booking_id,
        roomId: row.room_id,
        roomCode: row.room_name_enc ? decryptRoomName(row.room_id, row.room_name_enc) : 'Room',
        roomType: row.room_type || 'NORMAL',
        bedSlot: row.bed_slot,
        category: row.category,
        occupantGender: row.occupant_gender,
        occupantRank: row.occupant_rank,
        daysStayed: row.days_stayed,
        daysRemaining: row.days_remaining,
        fitsIncoming: row.fits_incoming,
      }));

      // Pass through rankCandidates hook (deferred ranking)
      return rankCandidates(mapped);
    },
    enabled: Boolean(category && checkIn && checkOut && guests.length > 0),
  });

  const candidates = rawCandidates || [];

  // Who stays behind in each room, so we can warn before the server rejects the swap.
  const { data: states } = useQuery({
    queryKey: ['daily_room_state_eviction', checkIn, checkOut],
    queryFn: () => fetchRoomDayStates(checkIn, checkOut),
    enabled: Boolean(checkIn && checkOut),
  });

  const remainingByRoom = useMemo(() => {
    const out: Record<string, Array<SharingPerson & { allocationId: string; relation?: string }>> = {};
    for (const st of states ?? []) {
      for (const occ of st.occupants) {
        const list = (out[st.roomId] ??= []);
        if (!list.some((x) => x.allocationId === occ.allocationId)) {
          list.push({
            allocationId: occ.allocationId,
            gender: occ.gender,
            rankCode: occ.rankCode,
            relation: occ.relation,
            bookingId: occ.bookingId,
            allowSharing: occ.allowSharing,
          });
        }
      }
    }
    return out;
  }, [states]);

  // Selected beds in selection order, and who sits where. Pairs that belong together (couples,
  // same gender, a ranked guest and a civilian of the party) go into one room.
  const selectedBeds: FreedBed[] = useMemo(
    () =>
      selectedAllocationIds
        .map((id) => candidates.find((c) => c.allocationId === id))
        .filter((c): c is EvictionCandidate => !!c)
        .map((c) => ({ allocationId: c.allocationId, roomId: c.roomId, bedSlot: c.bedSlot as 1 | 2 })),
    [selectedAllocationIds, candidates],
  );
  const seating = useMemo(() => seatPartyOnBeds(guests, selectedBeds), [guests, selectedBeds]);
  const guestForAllocation = useMemo(() => {
    const map = new Map<string, number>();
    seating?.forEach((s) => map.set(s.bed.allocationId, s.guestIndex));
    return map;
  }, [seating]);

  const seatingProblems = useMemo(() => {
    const problems: string[] = [];
    if (selectedBeds.length > 0 && selectedBeds.length < guests.length) {
      problems.push(
        `Select at least ${guests.length} bed${guests.length > 1 ? 's' : ''}: one for each incoming guest (${selectedBeds.length} selected).`,
      );
    }
    const seatedByRoom: Record<string, Array<GuestDemand & { idx: number }>> = {};
    (seating ?? []).forEach(({ guestIndex, bed }) => {
      (seatedByRoom[bed.roomId] ??= []).push({ idx: guestIndex, ...guests[guestIndex] });
    });
    for (const [roomId, seated] of Object.entries(seatedByRoom)) {
      const roomLabel = candidates.find((c) => c.roomId === roomId)?.roomCode ?? 'room';
      const stayers = (remainingByRoom[roomId] ?? []).filter(
        (r) => !selectedAllocationIds.includes(r.allocationId),
      );
      const incoming: SharingPerson[] = seated.map((x) => ({
        gender: x.gender,
        rankCode: x.rankCode,
        bookingId: bookingId ?? INCOMING,
        allowSharing: allowSharing === true,
      }));
      const clashesWithStayer = stayers.some((st) => incoming.some((p) => !canShareRoom(p, st)));
      const clashesWithinParty = incoming.some((p, i) => incoming.slice(i + 1).some((q) => !canShareRoom(p, q)));
      if (clashesWithStayer) {
        problems.push(
          `${roomLabel}: the guest remaining there cannot share with the incoming guest (different gender, a civilian from another booking, or a booking that does not allow room sharing). Also select that occupant's bed, or choose another room.`,
        );
      } else if (clashesWithinParty) {
        problems.push(
          `${roomLabel}: incoming guests ${seated.map((x) => x.idx + 1).join(' and ')} differ in gender and cannot share this room.`,
        );
      }
    }
    return problems;
  }, [selectedBeds, seating, candidates, guests, remainingByRoom, selectedAllocationIds, bookingId, allowSharing]);

  const toggleSelectAllocation = (id: string) => {
    if (selectedAllocationIds.includes(id)) {
      setSelectedAllocationIds(selectedAllocationIds.filter((x) => x !== id));
    } else {
      setSelectedAllocationIds([...selectedAllocationIds, id]);
    }
  };

  const isReasonValid = writtenReason.trim().length >= 10;
  const isTypedConfirmValid = typedConfirmation.trim() === 'CONFIRM EVICTION';

  const handleApproveEviction = async () => {
    if (!isReasonValid || !isTypedConfirmValid || selectedAllocationIds.length === 0 || !seating) return;
    setApproving(true);
    setErrorMessage(null);

    try {
      const evictionId = randomUUID();
      const reasonEnc = encryptReason('evictions', 'reason_enc', evictionId, writtenReason.trim());

      const { data: incomingBookingId, error } = await supabase.rpc('approve_eviction', {
        p_incoming: {
          // An existing pending request is allotted in place rather than booked a second time.
          booking_id: bookingId ?? null,
          category,
          check_in: checkIn,
          check_out: checkOut,
          party_size: guests.length,
          // Only used when the incoming party is booked here; a saved request keeps its own flag.
          allow_sharing: allowSharing === true,
          guests: bookingId ? [] : guestRowsPayload(guests),
          allocations: (seating ?? []).map((s) => ({
            guest_seq: s.guestIndex + 1,
            room_id: s.bed.roomId,
            bed_slot: s.bed.bedSlot,
          })),
        },
        p_evict_allocation_ids: selectedAllocationIds,
        p_reason_enc: reasonEnc,
        p_key_version: getActiveKeyVersion(),
        p_reason_aad_id: evictionId,
      });

      if (error) throw error;
      logAction('bookings.eviction_approved', {
        entity: 'bookings',
        entityId: incomingBookingId as string,
        meta: { category, evicted: selectedAllocationIds.length },
      });

      setShowConfirmDialog(false);
      queryClient.invalidateQueries({ queryKey: ['pending_booking_requests'] });
      queryClient.invalidateQueries({ queryKey: ['tabbar_pending_requests_count'] });
      queryClient.invalidateQueries({ queryKey: ['bookings_ledger'] });
      queryClient.invalidateQueries({ queryKey: ['daily_room_state'] });
      router.replace(`/(app)/bookings/${incomingBookingId}/confirmed` as any);
    } catch (err: any) {
      setErrorMessage(userErrorMessage(err, 'Eviction approval failed'));
    } finally {
      setApproving(false);
    }
  };

  return (
    <Screen title="Eviction Review" showBack={true}>
      <View style={styles.container}>
        <Banner
          type="warning"
          message={`Incoming Request: ${category} for ${guests.length} person(s) (${checkIn} to ${checkOut}). Select existing lower-priority occupant(s) to displace.`}
        />

        {!canApprove && (
          <Banner
            type="error"
            message="Permission notice: Default policy requires Admin approval to execute evictions."
            style={{ marginTop: spacing.sm }}
          />
        )}

        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.sectionTitle, { color: colors.navy }]}>
            DISPLACEMENT CANDIDATES ({candidates.length} bed{candidates.length === 1 ? '' : 's'})
          </Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Tap beds to displace. Guests who belong together (couples, guests of the same gender) are seated in one room when both its beds are selected.
            MFA can displace PI/LEAVE/TD; PI can displace LEAVE/TD. Suites are excluded.
          </Text>

          {isLoading ? (
            <Text style={[styles.loadingText, { color: colors.muted }]}>Loading candidates...</Text>
          ) : candidates.length === 0 ? (
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              No eligible lower-priority occupants found for this date window.
            </Text>
          ) : (
            candidates.map((cand) => {
              const isSelected = selectedAllocationIds.includes(cand.allocationId);
              const roommate = (remainingByRoom[cand.roomId] ?? []).find(
                (r) => r.allocationId !== cand.allocationId,
              );
              return (
                <Pressable
                  key={cand.allocationId}
                  onPress={() => toggleSelectAllocation(cand.allocationId)}
                  style={[
                    styles.candidateRow,
                    {
                      borderColor: isSelected ? colors.blue : colors.border,
                      backgroundColor: isSelected ? colors.bg : colors.surface,
                    },
                  ]}
                >
                  <View style={styles.candidateHeader}>
                    <View style={styles.roomBadgeRow}>
                      <Text style={[styles.roomCode, { color: colors.navy }]}>{cand.roomCode}</Text>
                      <Badge label={`Bed ${cand.bedSlot}`} variant="default" />
                      <Badge
                        label={cand.category}
                        variant={cand.category === 'PI' ? 'warning' : 'default'}
                      />
                    </View>
                    <Badge
                      label={
                        isSelected
                          ? guestForAllocation.has(cand.allocationId)
                            ? `EVICT → GUEST ${guestForAllocation.get(cand.allocationId)! + 1}`
                            : 'EVICT (BED LEFT EMPTY)'
                          : 'SELECT'
                      }
                      variant={isSelected ? 'error' : 'default'}
                    />
                  </View>

                  <Text style={[styles.candMeta, { color: colors.text }]}>
                    Occupant: <Text style={{ fontWeight: 'bold' }}>{cand.occupantGender}/{cand.occupantRank ?? 'Civilian'}</Text> •
                    Stayed: <Text style={{ fontWeight: 'bold' }}>{cand.daysStayed}d</Text> • Remaining:{' '}
                    <Text style={{ fontWeight: 'bold' }}>{cand.daysRemaining}d</Text>
                  </Text>
                  <Text style={[styles.candMeta, { color: colors.muted }]}>
                    {roommate
                      ? `Other bed: ${roommate.gender}/${roommate.rankCode ?? 'Civilian'} stays unless also selected`
                      : 'Other bed in this room is empty'}
                  </Text>
                </Pressable>
              );
            })
          )}
        </Card>

        {seatingProblems.length > 0 && (
          <Banner
            type="warning"
            message={seatingProblems.join('\n')}
            style={{ marginTop: spacing.md }}
          />
        )}

        {errorMessage && (
          <Banner type="error" message={errorMessage} style={{ marginTop: spacing.md }} />
        )}

        <View style={styles.actionRow}>
          <Button
            label={`Approve Eviction (${selectedAllocationIds.length} selected)`}
            variant="destructive"
            disabled={
              !canApprove ||
              !seating ||
              seatingProblems.length > 0
            }
            onPress={() => setShowConfirmDialog(true)}
          />
        </View>

        {/* Confirmation Dialog */}
        <Dialog
          visible={showConfirmDialog}
          title="Approve Displacement & Eviction"
          message={`This will atomically displace ${selectedAllocationIds.length} occupant(s), mark their bookings as DISPLACED, and book the rooms for the incoming ${category} guest(s).`}
          confirmLabel="Execute Eviction"
          confirmVariant="destructive"
          disabled={!isReasonValid || !isTypedConfirmValid || approving}
          loading={approving}
          onConfirm={handleApproveEviction}
          onCancel={() => setShowConfirmDialog(false)}
        >
          <Field
            label="Formal Justification / Reason (Min 10 characters)"
            value={writtenReason}
            onChangeText={setWrittenReason}
            placeholder="Official justification for operational displacement..."
            multiline={true}
            error={
              writtenReason.length > 0 && writtenReason.length < 10
                ? 'Reason must be at least 10 characters'
                : undefined
            }
          />

          <Field
            label="Type 'CONFIRM EVICTION' to confirm"
            value={typedConfirmation}
            onChangeText={setTypedConfirmation}
            placeholder="CONFIRM EVICTION"
            autoCapitalize="characters"
            error={
              typedConfirmation.length > 0 && typedConfirmation !== 'CONFIRM EVICTION'
                ? 'Phrase must match exactly: CONFIRM EVICTION'
                : undefined
            }
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
  sectionTitle: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
  },
  subtitle: {
    fontSize: typography.sm,
    marginVertical: spacing.xs,
  },
  loadingText: {
    padding: spacing.md,
    fontStyle: 'italic',
  },
  emptyText: {
    padding: spacing.md,
    fontStyle: 'italic',
  },
  candidateRow: {
    padding: spacing.md,
    borderWidth: 1,
    borderRadius: 4,
    marginTop: spacing.sm,
  },
  candidateHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  roomBadgeRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    alignItems: 'center',
  },
  roomCode: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
  },
  candMeta: {
    fontSize: typography.sm,
  },
  actionRow: {
    marginTop: spacing.xl,
    marginBottom: spacing.xxl,
  },
});
