import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useThemeStore } from '../../../../src/state/themeStore';
import { Screen } from '../../../../src/ui/primitives/Screen';
import { Card } from '../../../../src/ui/primitives/Card';
import { Button } from '../../../../src/ui/primitives/Button';
import { Select } from '../../../../src/ui/primitives/Select';
import { Banner } from '../../../../src/ui/primitives/Banner';
import { Badge } from '../../../../src/ui/primitives/Badge';
import { spacing, typography } from '../../../../src/ui/tokens';
import { supabase } from '../../../../src/lib/supabase';
import { decryptRoomName } from '../../../../src/features/crypto-session/cryptoSession';
import type { Category, Gender, RankCode, GuestDemand } from '@sms/core';

interface ParsedPayload {
  category: Category;
  checkIn: string;
  checkOut: string;
  guests: GuestDemand[];
  plan?: {
    assignments: Array<{ guestIndex: number; roomId: string; bedSlot: 1 | 2 }>;
  };
}

export default function MultiRoomAssignmentScreen() {
  const { payload } = useLocalSearchParams<{ payload: string }>();
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);

  const parsed: ParsedPayload = payload ? JSON.parse(payload) : null;
  const { category, checkIn, checkOut, guests, plan } = parsed || {
    category: 'MSA' as Category,
    checkIn: '',
    checkOut: '',
    guests: [],
    plan: { assignments: [] }
  };

  // State for assignments: index -> { roomId, bedSlot }
  const [assignments, setAssignments] = useState<
    Record<number, { roomId: string; bedSlot: 1 | 2 }>
  >(() => {
    const init: Record<number, { roomId: string; bedSlot: 1 | 2 }> = {};
    if (plan?.assignments) {
      plan.assignments.forEach((a) => {
        init[a.guestIndex] = { roomId: a.roomId, bedSlot: a.bedSlot };
      });
    }
    return init;
  });

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Fetch available rooms
  const { data: rooms } = useQuery({
    queryKey: ['available_rooms_list'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rooms')
        .select('*')
        .neq('room_type', 'SUITE')
        .eq('is_active', true)
        .order('display_order');
      if (error) throw error;
      return (data || []).map((r) => ({
        ...r,
        name: decryptRoomName(r.id, r.name_enc)
      }));
    }
  });

  // Fetch room daily states to detect existing occupants
  const { data: rawStates } = useQuery({
    queryKey: ['daily_room_state_raw', checkIn, checkOut],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('daily_room_state', {
        p_from: checkIn,
        p_to: checkOut
      });
      if (error) throw error;
      return (data || []) as any[];
    },
    enabled: Boolean(checkIn && checkOut)
  });

  // Validate assignments for sharing rules
  const validateSharingRules = () => {
    const errors: string[] = [];
    const roomSlots: Record<string, { guestIdx: number; gender: Gender; rankCode: RankCode; bedSlot: 1 | 2 }[]> = {};

    Object.entries(assignments).forEach(([idxStr, assign]) => {
      const idx = Number(idxStr);
      const guest = guests[idx];
      if (!assign.roomId) {
        errors.push(`Guest ${idx + 1} has not been assigned a room.`);
        return;
      }
      if (!roomSlots[assign.roomId]) {
        roomSlots[assign.roomId] = [];
      }
      roomSlots[assign.roomId].push({
        guestIdx: idx,
        gender: guest.gender,
        rankCode: guest.rankCode,
        bedSlot: assign.bedSlot
      });
    });

    // Check intra-booking sharing
    Object.entries(roomSlots).forEach(([roomId, list]) => {
      if (list.length > 2) {
        errors.push(`Room has more than 2 guests assigned.`);
      }
      if (list.length === 2) {
        if (list[0].bedSlot === list[1].bedSlot) {
          errors.push(`Guests ${list[0].guestIdx + 1} and ${list[1].guestIdx + 1} are assigned the same bed slot.`);
        }
        if (list[0].gender !== list[1].gender || list[0].rankCode !== list[1].rankCode) {
          errors.push(
            `ERR_SHARE_RULE: Guests ${list[0].guestIdx + 1} and ${list[1].guestIdx + 1} in the same room must have matching gender and rank.`
          );
        }
      }

      // Check external occupancy overlap
      if (rawStates) {
        const occupied = rawStates.find((s: any) => s.room_id === roomId && s.beds_taken > 0);
        if (occupied && list.length > 0) {
          if (occupied.beds_taken >= 2) {
            errors.push(`Room already has 2 existing occupants.`);
          } else if (occupied.beds_taken === 1) {
            const first = list[0];
            if (occupied.occupant_gender && occupied.occupant_gender !== first.gender) {
              errors.push(`ERR_SHARE_RULE: Gender mismatch with existing occupant in room.`);
            }
            if (occupied.occupant_rank && occupied.occupant_rank !== first.rankCode) {
              errors.push(`ERR_SHARE_RULE: Rank mismatch with existing occupant in room.`);
            }
          }
        }
      }
    });

    return errors;
  };

  const validationErrors = validateSharingRules();
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
          is_suite_booking: false
        },
        p_guests: guests.map((g, idx) => ({
          seq: idx + 1,
          gender: g.gender,
          rank_code: g.rankCode
        })),
        p_allocations: Object.entries(assignments).map(([idxStr, a]) => ({
          guest_seq: Number(idxStr) + 1,
          room_id: a.roomId,
          bed_slot: a.bedSlot,
          check_in: checkIn,
          check_out: checkOut
        }))
      });

      if (error) throw error;
      router.replace(`/(app)/bookings/${bookingId}/confirmed` as any);
    } catch (err: any) {
      setSubmitError(err.message || 'Failed to complete multi-room booking');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen title="Multi-Room Assignment" showBack={true}>
      <ScrollView contentContainerStyle={styles.container}>
        <Card>
          <Text style={[styles.title, { color: colors.navy }]}>ASSIGN GUESTS TO ROOMS & BEDS</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Category: {category} • Dates: {checkIn} to {checkOut} • Total Guests: {guests.length}
          </Text>

          {validationErrors.length > 0 && (
            <Banner
              type="error"
              message={validationErrors.join('\n')}
              style={{ marginTop: spacing.md }}
            />
          )}

          {submitError && (
            <Banner
              type="error"
              message={submitError}
              style={{ marginTop: spacing.md }}
            />
          )}
        </Card>

        {guests.map((g, idx) => {
          const assign = assignments[idx] || { roomId: '', bedSlot: 1 };
          return (
            <Card key={idx} style={{ marginTop: spacing.md }}>
              <View style={styles.guestTitleRow}>
                <Text style={[styles.guestTitle, { color: colors.navy }]}>
                  Guest {idx + 1}: Rank {g.rankCode} • Gender {g.gender}
                </Text>
                <Badge label={`Bed ${assign.bedSlot}`} variant="default" />
              </View>

              <View style={styles.inputsRow}>
                <View style={{ flex: 2 }}>
                  <Select
                    label="Assign Room"
                    value={assign.roomId}
                    onChange={(roomId: string) =>
                      setAssignments({
                        ...assignments,
                        [idx]: { ...assign, roomId }
                      })
                    }
                    options={(rooms || []).map((r) => ({
                      label: `${r.name} (${r.room_type})`,
                      value: r.id
                    }))}
                  />
                </View>

                <View style={{ flex: 1 }}>
                  <Select
                    label="Bed Slot"
                    value={String(assign.bedSlot)}
                    onChange={(val: string) =>
                      setAssignments({
                        ...assignments,
                        [idx]: { ...assign, bedSlot: Number(val) as 1 | 2 }
                      })
                    }
                    options={[
                      { label: 'Bed 1', value: '1' },
                      { label: 'Bed 2', value: '2' }
                    ]}
                  />
                </View>
              </View>
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
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.md
  },
  title: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold
  },
  subtitle: {
    fontSize: typography.sm,
    marginTop: 4
  },
  guestTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm
  },
  guestTitle: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold
  },
  inputsRow: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  footerActions: {
    marginTop: spacing.xl,
    marginBottom: spacing.xxl
  }
});
