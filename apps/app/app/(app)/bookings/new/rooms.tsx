import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { persistGuestDetails } from '../../../../src/features/bookings/guestDetails';
import type { Category, GuestDemand, RoomDayState } from '@sms/core';

export interface RoomGuest extends GuestDemand {
  name?: string;
  serviceNumber?: string | null;
  unit?: string | null;
  phone?: string | null;
  idNumber?: string | null;
  idType?: string | null;
  notes?: string | null;
}

interface ParsedPayload {
  bookingId?: string;
  category: Category;
  checkIn: string;
  checkOut: string;
  guests: RoomGuest[];
  preferredRoomType?: string;
  preferredRoomId?: string;
  preferredBedSlot?: 1 | 2;
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
  occupants: Array<{ gender: string; rankCode: string }>;
}

function summarizeOccupancy(states: RoomDayState[] | undefined): Record<string, RoomOccupancy> {
  const out: Record<string, RoomOccupancy> = {};
  for (const s of states ?? []) {
    const o = (out[s.roomId] ??= { closed: false, takenBeds: new Set(), occupants: [] });
    if (s.isClosed) o.closed = true;
    if (s.bedsTaken >= 2) {
      o.takenBeds.add(1);
      o.takenBeds.add(2);
    }
    for (const occ of s.occupants) {
      if (occ.bedSlot != null) {
        o.takenBeds.add(Number(occ.bedSlot));
      }
      if (!o.occupants.some((x) => x.gender === occ.gender && x.rankCode === occ.rankCode)) {
        o.occupants.push({ gender: occ.gender, rankCode: occ.rankCode });
      }
    }
  }
  return out;
}

export default function RoomAllotmentScreen() {
  const { payload } = useLocalSearchParams<{ payload: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const colors = useThemeStore((s) => s.colors);

  const parsed = useMemo(() => parsePayload(payload), [payload]);
  const category = parsed?.category ?? 'MFA';
  const checkIn = parsed?.checkIn ?? '';
  const checkOut = parsed?.checkOut ?? '';
  const guests = useMemo(() => parsed?.guests ?? [], [parsed]);

  const [roomTypeFilter, setRoomTypeFilter] = useState<string>(() => {
    return parsed?.preferredRoomType || 'ALL';
  });

  const [assignments, setAssignments] = useState<Record<number, Assignment>>(() => {
    const init: Record<number, Assignment> = {};
    parsed?.plan?.assignments?.forEach((a) => {
      init[a.guestIndex] = { roomId: a.roomId, bedSlot: a.bedSlot };
    });
    if (parsed?.preferredRoomId && !init[0]) {
      init[0] = {
        roomId: parsed.preferredRoomId,
        bedSlot: (parsed.preferredBedSlot as 1 | 2) || 1,
      };
    }
    return init;
  });

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Fetch all active non-suite rooms
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

  const filteredRooms = useMemo(() => {
    if (!rooms) return [];
    if (roomTypeFilter === 'ALL') return rooms;
    return rooms.filter((r) => r.room_type === roomTypeFilter);
  }, [rooms, roomTypeFilter]);

  // Query live room occupancy for the requested stay dates
  const { data: states, isLoading: statesLoading } = useQuery({
    queryKey: ['daily_room_state_manual', checkIn, checkOut],
    queryFn: () => fetchRoomDayStates(checkIn, checkOut),
    enabled: Boolean(checkIn && checkOut),
  });

  const occupancy = useMemo(() => summarizeOccupancy(states), [states]);

  const roomName = useCallback(
    (id: string) => rooms?.find((r) => r.id === id)?.name ?? 'room',
    [rooms],
  );

  // Helper: compute strictly available rooms for a given guest index (excludes full rooms & sharing conflicts)
  const getAvailableRoomsForGuest = useCallback(
    (guestIdx: number) => {
      const guest = guests[guestIdx];
      if (!guest || !states) return [];

      return filteredRooms
        .filter((r) => {
          const occ = occupancy[r.id];
          if (occ?.closed) return false;

          // Which beds in room r are taken by OTHER guests in this session?
          const sessionTakenBeds = new Set<number>();
          guests.forEach((_, j) => {
            if (j !== guestIdx && assignments[j]?.roomId === r.id) {
              sessionTakenBeds.add(assignments[j].bedSlot);
            }
          });

          const totalTaken = new Set([...(occ ? occ.takenBeds : []), ...sessionTakenBeds]);
          const freeBeds = [1, 2].filter((b) => !totalTaken.has(b));

          // STRICT: Rooms with 0 free beds are completely excluded from the dropdown!
          if (freeBeds.length === 0) return false;

          // Check sharing rules with DB occupants: same gender and same rank required
          if (occ && occ.occupants.length > 0) {
            const hasConflict = occ.occupants.some(
              (o) => o.gender !== guest.gender || o.rankCode !== guest.rankCode
            );
            if (hasConflict) return false;
          }

          // Check sharing rules with session guests
          const sessionConflict = guests.some((otherG, j) => {
            if (j !== guestIdx && assignments[j]?.roomId === r.id) {
              return otherG.gender !== guest.gender || otherG.rankCode !== guest.rankCode;
            }
            return false;
          });
          if (sessionConflict) return false;

          return true;
        })
        .map((r) => {
          const occ = occupancy[r.id];
          const sessionTakenBeds = new Set<number>();
          guests.forEach((_, j) => {
            if (j !== guestIdx && assignments[j]?.roomId === r.id) {
              sessionTakenBeds.add(assignments[j].bedSlot);
            }
          });
          const totalTaken = new Set([...(occ ? occ.takenBeds : []), ...sessionTakenBeds]);
          const freeBeds = [1, 2].filter((b) => !totalTaken.has(b));

          return {
            ...r,
            availableBeds: freeBeds,
          };
        });
    },
    [filteredRooms, guests, assignments, occupancy, states]
  );

  // Auto-select target room or first available room when states load
  useEffect(() => {
    if (!states || !rooms || statesLoading) return;

    guests.forEach((_, idx) => {
      const avail = getAvailableRoomsForGuest(idx);
      const currentRoomId = assignments[idx]?.roomId;
      const isCurrentValid = avail.some((r) => r.id === currentRoomId);

      // If user came with a pre-selected target room for guest 0, check if it's available
      if (idx === 0 && parsed?.preferredRoomId) {
        const targetAvail = avail.find((r) => r.id === parsed.preferredRoomId);
        if (targetAvail) {
          const targetSlot =
            parsed.preferredBedSlot && targetAvail.availableBeds.includes(parsed.preferredBedSlot)
              ? parsed.preferredBedSlot
              : (targetAvail.availableBeds[0] as 1 | 2);
          if (currentRoomId !== targetAvail.id || assignments[0]?.bedSlot !== targetSlot) {
            setAssignments((prev) => ({
              ...prev,
              [0]: { roomId: targetAvail.id, bedSlot: targetSlot },
            }));
          }
          return;
        }
      }

      if (!isCurrentValid && avail.length > 0) {
        const first = avail[0];
        setAssignments((prev) => ({
          ...prev,
          [idx]: { roomId: first.id, bedSlot: first.availableBeds[0] as 1 | 2 },
        }));
      }
    });
  }, [states, rooms, statesLoading, getAvailableRoomsForGuest, guests, assignments, parsed]);

  // Validation rules
  const validationErrors = useMemo(() => {
    if (!states || statesLoading) return [];
    const errors: string[] = [];
    const byRoom: Record<string, Array<{ idx: number; bedSlot: 1 | 2 }>> = {};

    guests.forEach((_, idx) => {
      const a = assignments[idx];
      if (!a?.roomId) return;
      (byRoom[a.roomId] ??= []).push({ idx, bedSlot: a.bedSlot });
    });

    const unassigned = guests.filter((_, idx) => !assignments[idx]?.roomId).length;
    if (unassigned > 0) {
      errors.push(`${unassigned} guest${unassigned > 1 ? 's' : ''} still need${unassigned > 1 ? '' : 's'} a room selection.`);
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

      const profiles = [
        ...list.map((l) => ({ gender: guests[l.idx].gender, rankCode: guests[l.idx].rankCode })),
        ...(occ?.occupants ?? []),
      ];
      if (profiles.some((p) => p.gender !== profiles[0].gender || p.rankCode !== profiles[0].rankCode)) {
        errors.push(
          `${name}: guests sharing a room must have the same gender and rank.`,
        );
      }
    }
    return Array.from(new Set(errors));
  }, [assignments, guests, occupancy, roomName, states, statesLoading]);

  const isValid =
    !statesLoading &&
    validationErrors.length === 0 &&
    guests.length > 0 &&
    guests.every((_, idx) => Boolean(assignments[idx]?.roomId));

  const handleConfirm = async () => {
    if (!isValid || !parsed) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const allocs = guests.map((_, idx) => ({
        guest_seq: idx + 1,
        room_id: assignments[idx].roomId,
        bed_slot: assignments[idx].bedSlot,
        check_in: checkIn,
        check_out: checkOut,
      }));

      let finalBookingId: string | null = null;
      let allottedSuccessfully = false;

      if (parsed.bookingId) {
        const { error } = await supabase.rpc('allot_booking_rooms', {
          p_booking_id: parsed.bookingId,
          p_allocations: allocs,
        });

        if (!error) {
          allottedSuccessfully = true;
          finalBookingId = parsed.bookingId;
          logAction('bookings.allot', {
            entity: 'bookings',
            entityId: parsed.bookingId,
            meta: { mode: 'manual', party_size: guests.length },
          });
        } else if (
          error.code === 'PGRST202' ||
          error.message?.includes('schema cache') ||
          error.message?.includes('allot_booking_rooms') ||
          error.message?.includes('ERR_BOOKING_NOT_PENDING')
        ) {
          // Resilient fallback for databases where allot_booking_rooms migration hasn't been applied yet:
          // Directly create the confirmed booking with allocations via create_booking
          const { data: newBkgId, error: directErr } = await supabase.rpc('create_booking', {
            p_booking: {
              category,
              check_in: checkIn,
              check_out: checkOut,
              party_size: guests.length,
              is_suite_booking: false,
              preferred_room_type: roomTypeFilter === 'ALL' ? null : roomTypeFilter,
            },
            p_guests: guests.map((g, idx) => ({
              seq: idx + 1,
              gender: g.gender,
              rank_code: g.rankCode,
              guest_name: g.name,
              service_number: g.serviceNumber,
              unit: g.unit,
              phone: g.phone,
            })),
            p_allocations: allocs,
          });

          if (directErr) throw directErr;

          allottedSuccessfully = true;
          finalBookingId = newBkgId as string;
          logAction('bookings.allot_direct', {
            entity: 'bookings',
            entityId: newBkgId as string,
            meta: { mode: 'direct_allotment', party_size: guests.length },
          });

          // Cancel the old unallotted placeholder booking so it is removed from requests
          try {
            await supabase.rpc('cancel_booking', {
              p_id: parsed.bookingId,
              p_reason_enc: 'Allotted via direct booking',
              p_key_version: 1,
            });
          } catch {
            // Ignore cancel error if already superseded
          }
        } else {
          throw error;
        }
      } else {
        const { data: bookingId, error } = await supabase.rpc('create_booking', {
          p_booking: {
            category,
            check_in: checkIn,
            check_out: checkOut,
            party_size: guests.length,
            is_suite_booking: false,
            preferred_room_type: roomTypeFilter === 'ALL' ? null : roomTypeFilter,
          },
          p_guests: guests.map((g, idx) => ({
            seq: idx + 1,
            gender: g.gender,
            rank_code: g.rankCode,
            guest_name: g.name,
            service_number: g.serviceNumber,
            unit: g.unit,
            phone: g.phone,
          })),
          p_allocations: allocs,
        });

        if (error) throw error;
        allottedSuccessfully = true;
        finalBookingId = bookingId as string;
        logAction('bookings.create', {
          entity: 'bookings',
          entityId: bookingId as string,
          meta: { mode: 'manual' },
        });
      }

      if (allottedSuccessfully && finalBookingId) {
        // Guarantee guest details & encrypted PII are persisted on the finalized booking
        try {
          const { data: gRows } = await supabase
            .from('booking_guests')
            .select('id, seq')
            .eq('booking_id', finalBookingId)
            .order('seq', { ascending: true });

          if (gRows && gRows.length > 0) {
            for (let idx = 0; idx < gRows.length; idx++) {
              const gInfo = guests[idx] || guests[0];
              if (gInfo) {
                await persistGuestDetails(gRows[idx].id, gInfo);
              }
            }
          }
        } catch (saveErr) {
          console.warn('Could not persist guest details on allotted booking:', saveErr);
        }
        // Invalidate all related caches to refresh Room Inventory, Ledger, and Requests
        queryClient.invalidateQueries({ queryKey: ['pending_booking_requests'] });
        queryClient.invalidateQueries({ queryKey: ['tabbar_pending_requests_count'] });
        queryClient.invalidateQueries({ queryKey: ['bookings_ledger'] });
        queryClient.invalidateQueries({ queryKey: ['guest_pii_for_requests'] });
        queryClient.invalidateQueries({ queryKey: ['guest_pii_for_ledger'] });
        queryClient.invalidateQueries({ queryKey: ['guest_pii_for_past_bookings'] });
        queryClient.invalidateQueries({ queryKey: ['past_bookings_list'] });
        queryClient.invalidateQueries({ queryKey: ['dashboard_counts'] });
        queryClient.invalidateQueries({ queryKey: ['daily_room_state'] });
        queryClient.invalidateQueries({ queryKey: ['daily_room_state_grid'] });
        queryClient.invalidateQueries({ queryKey: ['active_rooms_grid'] });
        queryClient.invalidateQueries({ queryKey: ['available_rooms_list'] });

        // Navigate directly to Live Room Inventory
        router.replace('/' as any);
      }
    } catch (err: unknown) {
      setSubmitError(userErrorMessage(err, 'Failed to complete room allotment'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!parsed || guests.length === 0) {
    return (
      <Screen title="Room Allotment" showBack={true}>
        <EmptyState
          title="No Request Selected"
          description="Start from Booking Requests or New Booking to allot rooms."
        />
        <Button label="Go to Booking Requests" onPress={() => router.replace('/(app)/requests')} />
      </Screen>
    );
  }

  return (
    <Screen title="Room Allotment" showBack={true}>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <Card>
          <Text style={[styles.title, { color: colors.navy }]}>Assign Room & Bed</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            {category} • 📅 {checkIn} (12:00 PM) → {checkOut} (12:00 PM) • {guests.length} Guest
            {guests.length > 1 ? 's' : ''}
          </Text>
          <View style={{ marginTop: 2 }}>
            <Text style={{ fontSize: 11, color: colors.muted }}>
              Policy: Standard 12:00 PM Check-In / 12:00 PM Check-Out turnover rule applies.
            </Text>
          </View>

          <View style={{ marginTop: spacing.md }}>
            <Select
              label="Filter Rooms by Category"
              value={roomTypeFilter}
              onChange={(val: string) => setRoomTypeFilter(val)}
              options={[
                { label: 'All Room Types', value: 'ALL' },
                { label: 'VIP Rooms Only', value: 'VIP' },
                { label: 'Semi VIP Rooms Only', value: 'SEMI_VIP' },
                { label: 'Normal Rooms Only', value: 'NORMAL' },
              ]}
            />
          </View>

          {statesLoading || roomsLoading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={colors.navy} />
              <Text style={[styles.loadingText, { color: colors.muted }]}>
                Checking live room vacancy...
              </Text>
            </View>
          ) : null}

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
        </Card>

        {guests.map((g, idx) => {
          const assign = assignments[idx] || { roomId: '', bedSlot: 1 as const };
          const avail = getAvailableRoomsForGuest(idx);
          const hasRooms = avail.length > 0;
          const selectedRoom = avail.find((r) => r.id === assign.roomId);

          return (
            <Card key={idx} style={{ marginTop: spacing.md }}>
              <View style={styles.guestTitleRow}>
                <Text style={[styles.guestTitle, { color: colors.navy }]}>
                  {g.name ? `${g.name} (${g.rankCode})` : `Guest ${idx + 1}: ${g.rankCode}`} • {g.gender === 'M' ? 'Male' : 'Female'}
                </Text>
                {assign.roomId && selectedRoom ? (
                  <Badge label={`Bed ${assign.bedSlot}`} variant="default" />
                ) : null}
              </View>

              <Select
                label="Available Room"
                value={assign.roomId}
                onChange={(newRoomId: string) => {
                  const roomData = avail.find((r) => r.id === newRoomId);
                  const nextBed = (roomData?.availableBeds[0] as 1 | 2) || 1;
                  setAssignments({ ...assignments, [idx]: { roomId: newRoomId, bedSlot: nextBed } });
                }}
                options={
                  !hasRooms
                    ? [{ label: 'No vacant rooms available in this category', value: '' }]
                    : avail.map((r) => ({
                        label: `${r.name} (${r.room_type.replace('_', ' ')}) · ${
                          r.availableBeds.length === 2
                            ? 'Both Beds Free'
                            : `Bed ${r.availableBeds[0]} Free`
                        }`,
                        value: r.id,
                      }))
                }
                disabled={statesLoading || roomsLoading || !hasRooms}
              />

              <View style={{ marginTop: spacing.sm }}>
                <Select
                  label="Bed Slot"
                  value={String(assign.bedSlot)}
                  onChange={(val: string) =>
                    setAssignments({
                      ...assignments,
                      [idx]: { ...assign, bedSlot: Number(val) as 1 | 2 },
                    })
                  }
                  options={
                    selectedRoom && selectedRoom.availableBeds.length > 0
                      ? selectedRoom.availableBeds.map((b: number) => ({
                          label: `Bed ${b}`,
                          value: String(b),
                        }))
                      : [{ label: 'Bed 1', value: '1' }]
                  }
                  disabled={!assign.roomId || statesLoading || !hasRooms}
                />
              </View>
            </Card>
          );
        })}

        <View style={styles.footerActions}>
          <Button
            label="Confirm Room Allotment"
            disabled={!isValid || submitting}
            loading={submitting}
            onPress={handleConfirm}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    paddingBottom: spacing.xxl,
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
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  loadingText: {
    fontSize: typography.xs,
  },
  footerActions: {
    marginTop: spacing.xl,
    marginBottom: spacing.xxl,
  },
});
