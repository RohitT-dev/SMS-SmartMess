import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useThemeStore } from '../../../../src/state/themeStore';
import { Screen } from '../../../../src/ui/primitives/Screen';
import { Card } from '../../../../src/ui/primitives/Card';
import { Button } from '../../../../src/ui/primitives/Button';
import { Select } from '../../../../src/ui/primitives/Select';
import { Banner } from '../../../../src/ui/primitives/Banner';
import { Badge } from '../../../../src/ui/primitives/Badge';
import { EmptyState } from '../../../../src/ui/primitives/EmptyState';
import { spacing, typography } from '../../../../src/ui/tokens';
import { supabase } from '../../../../src/lib/supabase';
import { logAction } from '../../../../src/lib/activityLog';
import { userErrorMessage } from '../../../../src/lib/userError';
import { fetchRoomDayStates } from '../../../../src/features/bookings/roomState';
import { decryptRoomName } from '../../../../src/features/crypto-session/cryptoSession';
import {
  canShareRoom,
  type Category,
  type GuestDemand,
  type RoomDayState,
  type SharingPerson,
} from '@sms/core';
import { guestRowsPayload } from '../../../../src/features/bookings/planBooking';
import {
  describeGuest,
  saveCivilianDetails,
  usePartyDetailsStore,
} from '../../../../src/features/bookings/party';

/** Stand-in booking id for the party being placed, which has no id until it is created. */
const NEW_BOOKING = 'new';

interface ParsedPayload {
  category: Category;
  checkIn: string;
  checkOut: string;
  guests: GuestDemand[];
  plan?: {
    assignments: Array<{ guestIndex: number; roomId: string; bedSlot: 1 | 2 }>;
  };
}

type Assignment = { roomId: string; bedSlot: 1 | 2 };

function parsePayload(payload: string | undefined): ParsedPayload | null {
  if (!payload) return null;
  try {
    return JSON.parse(payload) as ParsedPayload;
  } catch {
    return null;
  }
}

/** What is already in a room for the whole requested stay. */
interface RoomOccupancy {
  closed: boolean;
  takenBeds: Set<number>;
  occupants: SharingPerson[];
}

function summarizeOccupancy(states: RoomDayState[] | undefined): Record<string, RoomOccupancy> {
  const out: Record<string, RoomOccupancy> = {};
  for (const s of states ?? []) {
    const o = (out[s.roomId] ??= { closed: false, takenBeds: new Set(), occupants: [] });
    if (s.isClosed) o.closed = true;
    for (const occ of s.occupants) {
      o.takenBeds.add(occ.bedSlot);
      if (!o.occupants.some((x) => x.bookingId === occ.bookingId && x.gender === occ.gender && x.rankCode === occ.rankCode)) {
        o.occupants.push({ gender: occ.gender, rankCode: occ.rankCode, bookingId: occ.bookingId });
      }
    }
  }
  return out;
}

export default function MultiRoomAssignmentScreen() {
  const { payload } = useLocalSearchParams<{ payload: string }>();
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);

  const parsed = useMemo(() => parsePayload(payload), [payload]);
  const category = parsed?.category ?? 'MFA';
  const checkIn = parsed?.checkIn ?? '';
  const checkOut = parsed?.checkOut ?? '';
  const guests = useMemo(() => parsed?.guests ?? [], [parsed]);

  const [assignments, setAssignments] = useState<Record<number, Assignment>>(() => {
    const init: Record<number, Assignment> = {};
    parsed?.plan?.assignments?.forEach((a) => {
      init[a.guestIndex] = { roomId: a.roomId, bedSlot: a.bedSlot };
    });
    return init;
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const civilianDetails = usePartyDetailsStore((s) => s.details);
  const partyName = (idx: number) =>
    !guests[idx]?.rankCode ? civilianDetails[idx]?.name?.trim() || null : null;

  const { data: rooms, isLoading: roomsLoading } = useQuery({
    queryKey: ['available_rooms_list'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rooms')
        .select('*')
        .neq('room_type', 'SUITE')
        .eq('is_active', true)
        .order('display_order');
      if (error) throw error;
      return (data || []).map((r) => ({ ...r, name: decryptRoomName(r.id, r.name_enc) }));
    },
  });

  const { data: states } = useQuery({
    queryKey: ['daily_room_state_manual', checkIn, checkOut],
    queryFn: () => fetchRoomDayStates(checkIn, checkOut),
    enabled: Boolean(checkIn && checkOut),
  });
  const occupancy = useMemo(() => summarizeOccupancy(states), [states]);

  const roomName = useCallback(
    (id: string) => rooms?.find((r) => r.id === id)?.name ?? 'room',
    [rooms],
  );

  // Mirrors the server rules (closure, bed taken, sharing rule: see canShareRoom).
  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    const byRoom: Record<string, Array<{ idx: number; bedSlot: 1 | 2 }>> = {};

    guests.forEach((_, idx) => {
      const a = assignments[idx];
      if (!a?.roomId) return;
      (byRoom[a.roomId] ??= []).push({ idx, bedSlot: a.bedSlot });
    });

    const unassigned = guests.filter((_, idx) => !assignments[idx]?.roomId).length;
    if (unassigned > 0) {
      errors.push(`${unassigned} guest${unassigned > 1 ? 's' : ''} still need${unassigned > 1 ? '' : 's'} a room.`);
    }

    for (const [roomId, list] of Object.entries(byRoom)) {
      const name = roomName(roomId);
      const occ = occupancy[roomId];
      if (occ?.closed) errors.push(`${name} is out of service during these dates.`);

      const slots = list.map((l) => l.bedSlot);
      if (new Set(slots).size !== slots.length) {
        errors.push(
          `${list.map((l) => `Guest ${l.idx + 1}`).join(' and ')} are on the same bed in ${name}.`,
        );
      }
      list.forEach((l) => {
        if (occ?.takenBeds.has(l.bedSlot)) {
          errors.push(`Bed ${l.bedSlot} in ${name} is already taken during these dates.`);
        }
      });

      const party: SharingPerson[] = list.map((l) => ({
        gender: guests[l.idx].gender,
        rankCode: guests[l.idx].rankCode,
        bookingId: NEW_BOOKING,
      }));
      if (party.some((p, i) => party.slice(i + 1).some((q) => !canShareRoom(p, q)))) {
        errors.push(`${name}: ranked guests sharing a room must have the same gender and rank.`);
      }
      if ((occ?.occupants ?? []).some((o) => party.some((p) => !canShareRoom(p, o)))) {
        errors.push(
          `${name}: cannot share with the guest already staying there (ranked guests need the same gender and rank; civilians share only within their own booking).`,
        );
      }
    }
    return Array.from(new Set(errors));
  }, [assignments, guests, occupancy, roomName]);

  const isValid = validationErrors.length === 0 && Object.keys(assignments).length === guests.length;

  const handleConfirm = async () => {
    if (!isValid) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { data: bookingId, error } = await supabase.rpc('create_booking', {
        p_booking: {
          category,
          check_in: checkIn,
          check_out: checkOut,
          party_size: guests.length,
          is_suite_booking: false,
        },
        p_guests: guestRowsPayload(guests),
        p_allocations: Object.entries(assignments).map(([idxStr, a]) => ({
          guest_seq: Number(idxStr) + 1,
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
        meta: { mode: 'manual' },
      });
      await saveCivilianDetails(bookingId as string, guests);
      router.replace(`/(app)/bookings/${bookingId}/confirmed` as any);
    } catch (err: unknown) {
      setSubmitError(userErrorMessage(err, 'Failed to complete multi-room booking'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!parsed || guests.length === 0) {
    return (
      <Screen title="Customise Bed Placement" showBack={true}>
        <EmptyState
          title="Nothing to place"
          description="Start from New Booking, choose guests and dates, then pick Customise Bed Placement."
        />
        <Button label="Go to New Booking" onPress={() => router.replace('/bookings/new')} />
      </Screen>
    );
  }

  const bedHint = (roomId: string) => {
    const occ = occupancy[roomId];
    if (!occ) return '';
    if (occ.closed) return ' — out of service';
    const free = [1, 2].filter((b) => !occ.takenBeds.has(b));
    if (free.length === 2) return ' — both beds free';
    if (free.length === 1) return ` — bed ${free[0]} free`;
    return ' — full';
  };

  return (
    <Screen title="Customise Bed Placement" showBack={true}>
      <View style={styles.container}>
        <Card>
          <Text style={[styles.title, { color: colors.navy }]}>Assign guests to rooms and beds</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            {category} • {checkIn} → {checkOut} • {guests.length} guest
            {guests.length > 1 ? 's' : ''}
          </Text>

          {validationErrors.length > 0 && (
            <Banner
              type="error"
              message={validationErrors.join('\n')}
              style={{ marginTop: spacing.md }}
            />
          )}

          {submitError && (
            <Banner type="error" message={submitError} style={{ marginTop: spacing.md }} />
          )}

          {roomsLoading && (
            <Banner type="info" message="Loading rooms…" style={{ marginTop: spacing.md }} />
          )}
        </Card>

        {guests.map((g, idx) => {
          const assign = assignments[idx] || { roomId: '', bedSlot: 1 as const };
          return (
            <Card key={idx} style={{ marginTop: spacing.md }}>
              <View style={styles.guestTitleRow}>
                <Text style={[styles.guestTitle, { color: colors.navy }]}>
                  {partyName(idx) ?? `Guest ${idx + 1}`}: {describeGuest(g)}
                </Text>
                {assign.roomId ? <Badge label={`Bed ${assign.bedSlot}`} variant="default" /> : null}
              </View>

              <Select
                label="Room"
                value={assign.roomId}
                onChange={(roomId: string) =>
                  setAssignments({ ...assignments, [idx]: { ...assign, roomId } })
                }
                options={(rooms || []).map((r) => ({
                  label: `${r.name} (${r.room_type.replace('_', ' ')})${bedHint(r.id)}`,
                  value: r.id,
                }))}
                disabled={roomsLoading}
              />

              <Select
                label="Bed"
                value={String(assign.bedSlot)}
                onChange={(val: string) =>
                  setAssignments({
                    ...assignments,
                    [idx]: { ...assign, bedSlot: Number(val) as 1 | 2 },
                  })
                }
                options={[
                  { label: 'Bed 1', value: '1' },
                  { label: 'Bed 2', value: '2' },
                ]}
              />
            </Card>
          );
        })}

        <View style={styles.footerActions}>
          <Button
            label="Confirm All Allocations"
            disabled={!isValid || submitting}
            loading={submitting}
            onPress={handleConfirm}
          />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  title: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
  },
  subtitle: {
    fontSize: typography.sm,
    marginTop: 4,
  },
  guestTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  guestTitle: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
  },
  footerActions: {
    marginTop: spacing.xl,
    marginBottom: spacing.xxl,
  },
});
