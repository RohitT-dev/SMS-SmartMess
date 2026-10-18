import React, { useMemo, useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useThemeStore } from '../../src/state/themeStore';
import { Screen } from '../../src/ui/primitives/Screen';
import { Card } from '../../src/ui/primitives/Card';
import { Button } from '../../src/ui/primitives/Button';
import { Badge } from '../../src/ui/primitives/Badge';
import { EmptyState } from '../../src/ui/primitives/EmptyState';
import { layout, spacing, typography } from '../../src/ui/tokens';
import { supabase } from '../../src/lib/supabase';
import { logAction } from '../../src/lib/activityLog';
import { decryptGuestPii, encryptReason, getActiveKeyVersion } from '../../src/features/crypto-session/cryptoSession';
import { fetchPendingAllotment } from '../../src/features/bookings/pendingRequests';
import { userErrorMessage } from '../../src/lib/userError';
import { Banner } from '../../src/ui/primitives/Banner';
import type { Category, Gender, GuestRelation, RankCode } from '@sms/core';

interface PendingGuest {
  id: string;
  seq: number;
  gender: Gender;
  /** Null for a civilian. */
  rank_code: RankCode | null;
  relation?: GuestRelation | null;
  guest_code?: string;
  guest_name?: string;
  unit?: string | null;
  service_number?: string | null;
  phone?: string | null;
}

interface PendingBookingRequest {
  id: string;
  category: Category;
  status: string;
  check_in: string;
  check_out: string;
  party_size: number;
  preferred_room_type?: string | null;
  created_at: string;
  booking_guests: PendingGuest[];
}

export default function BookingRequestsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const colors = useThemeStore((s) => s.colors);

  const [actioningId, setActioningId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Query all pending booking requests (either PENDING_ALLOTMENT or unallotted with zero active allocations)
  const { data: requests, isLoading, refetch } = useQuery({
    queryKey: ['pending_booking_requests'],
    queryFn: () =>
      // PENDING_ALLOTMENT requests, plus confirmed bookings that hold no active bed.
      fetchPendingAllotment<PendingBookingRequest & { allocations: Array<{ status: string }> }>('*, booking_guests(*)'),
  });

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  // Realtime subscription for instant updates when requests are added or allotted
  useEffect(() => {
    const channel = supabase
      .channel(`requests-realtime-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, () => {
        refetch();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'booking_guests' }, () => {
        refetch();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'allocations' }, () => {
        refetch();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [refetch]);

  // Query guest PII records to resolve guest names if decrypted session is unlocked
  const { data: piiRows } = useQuery({
    queryKey: ['guest_pii_for_requests'],
    queryFn: async () => {
      const { data, error } = await supabase.from('guest_pii').select('guest_id, pii_enc');
      if (error) return [];
      return data || [];
    },
  });

  const piiMap = useMemo(() => {
    const map = new Map<string, { name: string; serviceNumber?: string | null; unit?: string | null; phone?: string | null }>();
    if (!piiRows) return map;
    for (const p of piiRows) {
      if (p.pii_enc) {
        try {
          const dec = decryptGuestPii(p.guest_id, p.pii_enc);
          map.set(p.guest_id, {
            name: dec.name,
            serviceNumber: dec.serviceNumber,
            unit: dec.unit,
            phone: dec.phone,
          });
        } catch {
          // session locked
        }
      }
    }
    return map;
  }, [piiRows]);

  const handleAllotRooms = (req: PendingBookingRequest) => {
    // Navigate to room allotment screen with payload
    const payload = JSON.stringify({
      bookingId: req.id,
      category: req.category,
      checkIn: req.check_in,
      checkOut: req.check_out,
      preferredRoomType: req.preferred_room_type || undefined,
      guests: req.booking_guests
        .sort((a, b) => a.seq - b.seq)
        .map((g) => {
          const pii = piiMap.get(g.id);
          return {
            gender: g.gender,
            rankCode: g.rank_code,
            relation: g.relation ?? undefined,
            name: g.guest_name || pii?.name || undefined,
            serviceNumber: g.service_number || pii?.serviceNumber || undefined,
            unit: g.unit || pii?.unit || undefined,
            phone: g.phone || pii?.phone || undefined,
          };
        }),
    });

    router.push({
      pathname: '/(app)/bookings/new/rooms' as any,
      params: { payload },
    });
  };

  const handleCancelRequest = async (reqId: string) => {
    setActioningId(reqId);
    setActionError(null);
    try {
      const reasonEnc = encryptReason(
        'bookings',
        'cancel_reason_enc',
        reqId,
        'Cancelled by operator from pending requests queue',
      );
      const { error } = await supabase.rpc('cancel_booking', {
        p_id: reqId,
        p_reason_enc: reasonEnc,
        p_key_version: getActiveKeyVersion(),
      });
      if (error) throw error;
      logAction('bookings.cancel_request', {
        entity: 'bookings',
        entityId: reqId,
        meta: { status: 'CANCELLED' },
      });
      queryClient.invalidateQueries({ queryKey: ['pending_booking_requests'] });
      queryClient.invalidateQueries({ queryKey: ['tabbar_pending_requests_count'] });
      queryClient.invalidateQueries({ queryKey: ['past_bookings_list'] });
    } catch (err) {
      setActionError(userErrorMessage(err, 'Could not cancel this request.'));
    } finally {
      setActioningId(null);
    }
  };

  return (
    <Screen title="Booking Requests" showBack={false}>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        {/* Intro Banner */}
        <Card style={styles.headerCard}>
          <Text style={[styles.headerTitle, { color: colors.navy }]}>
            Pending Room Allotment Queue
          </Text>
          <Text style={[styles.headerSubtitle, { color: colors.muted }]}>
            Review booking requests waiting for room allotment. Tap any guest name or click &quot;Choose Room &amp; Assign Bed&quot; to pick an available room for their stay.
          </Text>
        </Card>

        {actionError ? (
          <Banner type="error" message={actionError} style={{ marginBottom: spacing.md }} />
        ) : null}

        {isLoading ? (
          <View style={{ padding: spacing.xl, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={colors.navy} />
            <Text style={{ marginTop: spacing.sm, color: colors.muted }}>Loading booking requests...</Text>
          </View>
        ) : !requests || requests.length === 0 ? (
          <EmptyState
            title="No Pending Requests"
            description="All booking requests have been assigned rooms. Create a new booking request anytime from the New tab."
            actionLabel="Create Booking Request"
            onAction={() => router.push('/(app)/bookings/new' as any)}
          />
        ) : (
          <View style={styles.list}>
            {requests.map((req) => {
              const nights = Math.max(
                1,
                Math.round((Date.parse(req.check_out) - Date.parse(req.check_in)) / 86400000)
              );
              const sortedGuests = [...(req.booking_guests || [])].sort((a, b) => a.seq - b.seq);

              return (
                <Card key={req.id} style={styles.requestCard}>
                  {/* Header Row */}
                  <View style={styles.cardHeader}>
                    <View style={styles.headerLeft}>
                      <Text style={[styles.reqId, { color: colors.navy }]}>
                        #{req.id.slice(0, 8)}
                      </Text>
                      <Badge
                        label={req.category}
                        variant={req.category === 'MFA' ? 'navy' : 'neutral'}
                      />
                      {req.preferred_room_type ? (
                        <Badge
                          label={`${req.preferred_room_type.replace('_', ' ')} ONLY`}
                          variant="saffron"
                        />
                      ) : null}
                      <Badge label="PENDING ALLOTMENT" variant="default" />
                    </View>
                    <Text style={[styles.nightsText, { color: colors.muted }]}>
                      {nights} night{nights === 1 ? '' : 's'}
                    </Text>
                  </View>

                  {/* Dates Banner */}
                  <View style={[styles.datesBanner, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
                    <Text style={[styles.datesText, { color: colors.text }]}>
                      📅 {req.check_in} (12 PM) → {req.check_out} (12 PM)
                    </Text>
                    <Text style={[styles.partyCountText, { color: colors.muted }]}>
                      {req.party_size === 1 ? 'Single Guest' : `👥 Party of ${req.party_size}`}
                    </Text>
                  </View>

                  {/* Guests List */}
                  <View style={styles.guestsSection}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs }}>
                      <Text style={[styles.sectionHeading, { color: colors.navy }]}>
                        GUESTS IN THIS REQUEST:
                      </Text>
                      <Text style={{ fontSize: 10, color: colors.blue, fontWeight: '700' }}>
                        👉 Tap guest to choose room
                      </Text>
                    </View>
                    {sortedGuests.map((g, idx) => {
                      const pii = piiMap.get(g.id);
                      const displayName = g.guest_name || pii?.name || (g.guest_code ? `Guest (${g.guest_code})` : `Guest ${idx + 1}`);

                      return (
                        <Pressable
                          key={g.id}
                          onPress={() => handleAllotRooms(req)}
                          accessibilityRole="button"
                          accessibilityLabel={`Assign room for ${g.rank_code} ${displayName}`}
                          style={({ pressed }) => [
                            styles.guestRow,
                            { borderBottomColor: colors.border },
                            idx === sortedGuests.length - 1 && { borderBottomWidth: 0 },
                            pressed && { opacity: 0.7, backgroundColor: colors.surfaceAlt },
                          ]}
                        >
                          <View style={styles.guestSeqCircle}>
                            <Text style={styles.guestSeqText}>{idx + 1}</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' }}>
                              <Text style={[styles.guestNameText, { color: colors.navy }]}>
                                {g.rank_code} <Text style={{ color: colors.blue, textDecorationLine: 'underline' }}>{displayName}</Text>
                              </Text>
                              {g.guest_code ? (
                                <Text style={[styles.guestCodeBadge, { color: colors.muted }]}>
                                  [{g.guest_code}]
                                </Text>
                              ) : null}
                            </View>
                            <Text style={[styles.guestMetaText, { color: colors.muted }]}>
                              {[
                                `Gender: ${g.gender === 'M' ? 'Male' : 'Female'}`,
                                (g.service_number || pii?.serviceNumber) && `Service No: ${g.service_number || pii?.serviceNumber}`,
                                (g.unit || pii?.unit) && `Unit: ${g.unit || pii?.unit}`,
                                (g.phone || pii?.phone) && `Phone: ${g.phone || pii?.phone}`,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </Text>
                          </View>
                          <View style={[styles.assignPill, { backgroundColor: '#E0F2FE' }]}>
                            <Text style={[styles.assignPillText, { color: '#0369A1' }]}>Assign Bed →</Text>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>

                  {/* Action Buttons */}
                  <View style={styles.actionsRow}>
                    <Button
                      label="Cancel Request"
                      variant="secondary"
                      onPress={() => handleCancelRequest(req.id)}
                      disabled={actioningId === req.id}
                      style={{ flex: 1 }}
                    />
                    <Button
                      label="Choose Room & Assign Bed →"
                      variant="primary"
                      onPress={() => handleAllotRooms(req)}
                      disabled={actioningId === req.id}
                      style={{ flex: 2 }}
                    />
                  </View>
                </Card>
              );
            })}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.md,
    gap: spacing.md,
  },
  headerCard: {
    padding: spacing.md,
  },
  headerTitle: {
    fontSize: typography.md,
    fontWeight: '800',
  },
  headerSubtitle: {
    fontSize: typography.xs,
    marginTop: 4,
    lineHeight: 18,
  },
  list: {
    gap: spacing.md,
  },
  requestCard: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexWrap: 'wrap',
  },
  reqId: {
    fontSize: typography.sm,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginRight: spacing.xs,
  },
  nightsText: {
    fontSize: typography.xs,
    fontWeight: '600',
  },
  datesBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.sm,
    borderRadius: layout.borderRadius,
    borderWidth: 1,
  },
  datesText: {
    fontSize: typography.xs,
    fontWeight: '700',
  },
  partyCountText: {
    fontSize: typography.xs,
    fontWeight: '600',
  },
  guestsSection: {
    marginTop: spacing.xs,
  },
  sectionHeading: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  guestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  guestSeqCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#E3F2FD',
    alignItems: 'center',
    justifyContent: 'center',
  },
  guestSeqText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#1565C0',
  },
  guestNameText: {
    fontSize: typography.sm,
    fontWeight: '700',
  },
  guestCodeBadge: {
    fontSize: 11,
    fontFamily: 'monospace',
  },
  guestMetaText: {
    fontSize: 11,
    marginTop: 1,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  assignPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    alignSelf: 'center',
  },
  assignPillText: {
    fontSize: 11,
    fontWeight: '700',
  },
});
