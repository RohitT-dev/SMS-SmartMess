import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useThemeStore } from '../../../../src/state/themeStore';
import { Screen } from '../../../../src/ui/primitives/Screen';
import { Card } from '../../../../src/ui/primitives/Card';
import { Button } from '../../../../src/ui/primitives/Button';
import { Select } from '../../../../src/ui/primitives/Select';
import { DateRange } from '../../../../src/ui/primitives/DateRange';
import { Banner } from '../../../../src/ui/primitives/Banner';
import { Badge } from '../../../../src/ui/primitives/Badge';
import { Field } from '../../../../src/ui/primitives/Field';
import { Checkbox } from '../../../../src/ui/primitives/Checkbox';
import { layout, spacing, typography } from '../../../../src/ui/tokens';
import { supabase } from '../../../../src/lib/supabase';
import { logAction } from '../../../../src/lib/activityLog';
import { userErrorMessage } from '../../../../src/lib/userError';
import {
  addDaysToDateString,
  isValidDateString,
  localDateString,
} from '../../../../src/lib/dates';
import {
  encryptGuestPii,
  computeIdBlindIndex,
  getActiveKeyVersion,
} from '../../../../src/features/crypto-session/cryptoSession';
import { persistGuestDetails } from '../../../../src/features/bookings/guestDetails';
import { guestRowsPayload } from '../../../../src/features/bookings/planBooking';
import {
  RANKS,
  RELATION_LABELS,
  isCivilianRelation,
  type Category,
  type Gender,
  type GuestRelation,
  type RankCode,
  type RoomType,
} from '@sms/core';

/** A person travelling with the primary guest: another service member or a civilian. */
interface Companion {
  relation: GuestRelation;
  gender: Gender;
  /** Null for civilians. */
  rankCode: RankCode | null;
  name: string;
  phone: string;
}

const COMPANION_RELATION_OPTIONS = (['SPOUSE', 'CHILD', 'PARENT', 'OTHER', 'SERVICE'] as const).map(
  (r) => ({ label: r === 'SERVICE' ? 'Service member (ranked)' : RELATION_LABELS[r], value: r }),
);

interface SavedRequestConfirmation {
  bookingId: string;
  guestId: string;
  guestCode: string;
  guestName: string;
  rankCode: RankCode;
  gender: Gender;
  unit: string | null;
  serviceNumber: string | null;
  phone: string | null;
  category: Category;
  checkIn: string;
  checkOut: string;
  preferredRoomType: RoomType | null;
  /** "Allow room sharing" as saved on the request. */
  allowSharing: boolean;
  nights: number;
  /** People travelling with the primary guest, saved on the same booking. */
  companions: Companion[];
}

const CATEGORY_OPTIONS = [
  { label: 'MFA · BA MFA (Mandatory / High Priority)', value: 'MFA' },
  { label: 'PI · Posted In (Mandatory / High Priority)', value: 'PI' },
  { label: 'LEAVE · On Leave (Paid / Low Priority)', value: 'LEAVE' },
  { label: 'TD · Temp. Displacement (Paid / Low Priority)', value: 'TD' },
];

const GENDER_OPTIONS = [
  { label: 'Male', value: 'M' },
  { label: 'Female', value: 'F' },
];

const ROOM_PREFERENCE_OPTIONS = [
  { label: 'Any Room Type', value: 'ANY' },
  { label: 'VIP Rooms', value: 'VIP' },
  { label: 'Semi VIP Rooms', value: 'SEMI_VIP' },
  { label: 'Normal Rooms', value: 'NORMAL' },
];

const ID_TYPE_OPTIONS = [
  { label: 'Service ID', value: 'Service ID' },
  { label: 'Aadhaar Card', value: 'Aadhaar Card' },
  { label: 'PAN Card', value: 'PAN Card' },
  { label: 'Voter ID', value: 'Voter ID' },
  { label: 'Passport', value: 'Passport' },
];

const RANK_OPTIONS = RANKS.map((r) => ({
  label: `${r.label} (${r.code})`,
  value: r.code,
}));

export default function NewBookingWizardScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    roomId?: string;
    roomType?: string;
    roomName?: string;
    bedSlot?: string;
    checkIn?: string;
    checkOut?: string;
  }>();
  const queryClient = useQueryClient();
  const colors = useThemeStore((s) => s.colors);

  const today = localDateString();

  // Target Room preselection if coming from Room Inventory or Room Details
  const [targetRoomId, setTargetRoomId] = useState<string | null>(params.roomId || null);
  const [targetRoomName, setTargetRoomName] = useState<string | null>(params.roomName || null);
  const [targetBedSlot, setTargetBedSlot] = useState<string | null>(params.bedSlot || null);

  // Stay Parameters
  const [category, setCategory] = useState<Category>('MFA');
  const [checkIn, setCheckIn] = useState<string>(() =>
    params.checkIn && isValidDateString(params.checkIn) ? params.checkIn : today,
  );
  const [checkOut, setCheckOut] = useState<string>(() =>
    params.checkOut && isValidDateString(params.checkOut)
      ? params.checkOut
      : addDaysToDateString(today, 2),
  );
  const [preferredType, setPreferredType] = useState<RoomType | 'ANY'>(() => {
    if (params.roomType && ['VIP', 'SEMI_VIP', 'NORMAL'].includes(params.roomType)) {
      return params.roomType as RoomType;
    }
    return 'ANY';
  });

  // "Allow room sharing": off, the booking holds each room for its own party and only fully
  // vacant rooms are offered; on, rooms with a free bed beside a compatible guest are offered too.
  const [allowSharing, setAllowSharing] = useState<boolean>(false);

  // Guest Details (All optional)
  const [currentRank, setCurrentRank] = useState<RankCode>('WG_CDR');
  const [currentGender, setCurrentGender] = useState<Gender>('M');
  const [currentName, setCurrentName] = useState<string>('');
  const [currentServiceNumber, setCurrentServiceNumber] = useState<string>('');
  const [currentPhone, setCurrentPhone] = useState<string>('');
  const [currentUnit, setCurrentUnit] = useState<string>('');
  const [currentIdType, setCurrentIdType] = useState<string>('Service ID');
  const [currentIdNumber, setCurrentIdNumber] = useState<string>('');
  const [currentNotes, setCurrentNotes] = useState<string>('');

  // Party: further service members and civilians (family) booked together with the primary guest.
  const [companions, setCompanions] = useState<Companion[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Success Confirmation State
  const [savedRequest, setSavedRequest] = useState<SavedRequestConfirmation | null>(null);

  const datesValid =
    isValidDateString(checkIn) && isValidDateString(checkOut) && checkOut > checkIn;
  const nights = Math.max(
    1,
    Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86400000)
  );

  const handleResetForm = () => {
    setSavedRequest(null);
    setSubmitError(null);
    setCurrentName('');
    setCurrentServiceNumber('');
    setCurrentPhone('');
    setCurrentUnit('');
    setCurrentIdNumber('');
    setCurrentNotes('');
    setCompanions([]);
    setAllowSharing(false);
  };

  const handleAddCivilian = () => {
    if (companions.length >= 39) return;
    const hasSpouse = companions.some((c) => c.relation === 'SPOUSE');
    setCompanions([
      ...companions,
      {
        relation: hasSpouse ? 'CHILD' : 'SPOUSE',
        gender: currentGender === 'M' ? 'F' : 'M',
        rankCode: null,
        name: '',
        phone: '',
      },
    ]);
  };

  const handleAddServiceMember = () => {
    if (companions.length >= 39) return;
    // Starts as a copy of the primary: colleagues travelling together usually match.
    setCompanions([
      ...companions,
      { relation: 'SERVICE', gender: currentGender, rankCode: currentRank, name: '', phone: '' },
    ]);
  };

  const handleUpdateCompanion = (index: number, patch: Partial<Companion>) => {
    setCompanions(companions.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const handleChangeRelation = (index: number, relation: GuestRelation) => {
    handleUpdateCompanion(index, {
      relation,
      rankCode: isCivilianRelation(relation) ? null : (companions[index].rankCode ?? currentRank),
    });
  };

  const handleRemoveCompanion = (index: number) => {
    setCompanions(companions.filter((_, i) => i !== index));
  };

  /** The whole party in booking order: the primary guest first. */
  const buildParty = (resolvedName: string, resolvedServiceNo: string | null, resolvedUnit: string | null, resolvedPhone: string | null) => [
    {
      gender: currentGender,
      rankCode: currentRank as RankCode | null,
      relation: 'PRIMARY' as GuestRelation,
      name: resolvedName,
      serviceNumber: resolvedServiceNo,
      unit: resolvedUnit,
      phone: resolvedPhone,
    },
    ...companions.map((c) => ({
      gender: c.gender,
      rankCode: c.rankCode,
      relation: c.relation,
      name: c.name.trim() || undefined,
      serviceNumber: null,
      unit: null,
      phone: c.phone.trim() || null,
    })),
  ];

  const unnamedCivilians = useMemo(
    () => companions.filter((c) => !c.rankCode && !c.name.trim()).length,
    [companions],
  );

  const handleSaveRequest = async (andAllotNow: boolean = false) => {
    if (!datesValid) {
      setSubmitError('Please select valid check-in and check-out dates.');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      const resolvedName = currentName.trim() || 'Officer / Guest';
      const resolvedServiceNo = currentServiceNumber.trim() || null;
      const resolvedUnit = currentUnit.trim() || null;
      const resolvedPhone = currentPhone.trim() || null;
      const prefType = preferredType === 'ANY' ? null : preferredType;
      const party = buildParty(resolvedName, resolvedServiceNo, resolvedUnit, resolvedPhone);

      // 1. Create booking request in DB using standard create_booking RPC
      const { data: bookingId, error: createError } = await supabase.rpc(
        'create_booking',
        {
          p_booking: {
            category,
            check_in: checkIn,
            check_out: checkOut,
            party_size: party.length,
            is_suite_booking: false,
            allow_sharing: allowSharing,
            preferred_room_type: prefType,
            status: 'PENDING_ALLOTMENT',
            // Remarks travel in the encrypted guest record (persistGuestDetails). notes_enc is a
            // ciphertext column and must never receive plain text.
            key_version: getActiveKeyVersion(),
          },
          p_guests: guestRowsPayload(party),
          p_allocations: [],
        }
      );

      if (createError) throw createError;

      // 2. Fetch created guest record to get guest ID and unique code safely
      let guestId = '';
      let guestCode = 'GST-…';

      const { data: guestRows } = await supabase
        .from('booking_guests')
        .select('*')
        .eq('booking_id', bookingId)
        .order('seq', { ascending: true })
        .limit(1);

      if (guestRows && guestRows.length > 0) {
        guestId = guestRows[0].id;
        guestCode = (guestRows[0] as any).guest_code || 'GST-…';
      }

      if (!guestId) {
        const { data: fallbackRows } = await supabase
          .from('booking_guests')
          .select('id')
          .eq('booking_id', bookingId)
          .limit(1);
        if (fallbackRows && fallbackRows.length > 0) {
          guestId = fallbackRows[0].id;
        }
      }

      // 3. Save guest details via multiple redundant channels to guarantee persistence
      if (guestId) {
        await persistGuestDetails(guestId, {
          name: resolvedName,
          serviceNumber: resolvedServiceNo,
          unit: resolvedUnit,
          phone: resolvedPhone,
          idNumber: currentIdNumber.trim() || null,
          idType: currentIdType.trim() || null,
          notes: currentNotes.trim() || null,
        });
      }

      // 3b. Companions: store the names typed here. A civilian left unnamed is completed later
      // from Guest Details.
      if (party.length > 1) {
        const { data: allRows } = await supabase
          .from('booking_guests')
          .select('id, seq')
          .eq('booking_id', bookingId)
          .order('seq', { ascending: true });
        for (const row of (allRows ?? []) as Array<{ id: string; seq: number }>) {
          const p = party[row.seq - 1];
          if (!p || row.seq === 1 || !(p.rankCode || p.name)) continue;
          await persistGuestDetails(row.id, { name: p.name, phone: p.phone });
        }
      }

      // 4. Invalidate query caches for real-time updates everywhere
      queryClient.invalidateQueries({ queryKey: ['pending_booking_requests'] });
      queryClient.invalidateQueries({ queryKey: ['bookings_ledger'] });
      queryClient.invalidateQueries({ queryKey: ['guest_pii_for_requests'] });
      queryClient.invalidateQueries({ queryKey: ['guest_pii_for_ledger'] });
      queryClient.invalidateQueries({ queryKey: ['guest_pii_for_past_bookings'] });
      queryClient.invalidateQueries({ queryKey: ['past_bookings_list'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard_counts'] });
      queryClient.invalidateQueries({ queryKey: ['daily_room_state'] });
      queryClient.invalidateQueries({ queryKey: ['daily_room_state_grid'] });
      queryClient.invalidateQueries({ queryKey: ['active_rooms_grid'] });
      queryClient.invalidateQueries({ queryKey: ['tabbar_pending_requests_count'] });

      logAction('bookings.create_request', {
        entity: 'bookings',
        entityId: bookingId as string,
        meta: { mode: 'wizard_request', category, checkIn, checkOut, andAllotNow, party_size: party.length, allow_sharing: allowSharing },
      });

      if (andAllotNow) {
        // Direct navigation to room allotment screen!
        const payload = JSON.stringify({
          bookingId: bookingId as string,
          category,
          checkIn,
          checkOut,
          preferredRoomType: prefType || undefined,
          preferredRoomId: targetRoomId || undefined,
          preferredBedSlot: targetBedSlot ? Number(targetBedSlot) : undefined,
          allowSharing,
          guests: party.map((p, i) =>
            i === 0
              ? {
                  ...p,
                  idNumber: currentIdNumber.trim() || null,
                  idType: currentIdType.trim() || null,
                  notes: currentNotes.trim() || null,
                }
              : p,
          ),
        });

        router.push({
          pathname: '/(app)/bookings/new/rooms' as any,
          params: { payload },
        });
        return;
      }

      // 5. Store saved booking request confirmation state
      setSavedRequest({
        bookingId: bookingId as string,
        guestId,
        guestCode,
        guestName: resolvedName,
        rankCode: currentRank,
        gender: currentGender,
        unit: resolvedUnit,
        serviceNumber: resolvedServiceNo,
        phone: resolvedPhone,
        category,
        checkIn,
        checkOut,
        preferredRoomType: prefType,
        allowSharing,
        nights,
        companions,
      });
    } catch (err: any) {
      setSubmitError(userErrorMessage(err, 'Failed to save booking request'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAllotNow = () => {
    if (!savedRequest) return;
    const payload = JSON.stringify({
      bookingId: savedRequest.bookingId,
      category: savedRequest.category,
      checkIn: savedRequest.checkIn,
      checkOut: savedRequest.checkOut,
      preferredRoomType: savedRequest.preferredRoomType || undefined,
      preferredRoomId: targetRoomId || undefined,
      preferredBedSlot: targetBedSlot ? Number(targetBedSlot) : undefined,
      allowSharing: savedRequest.allowSharing,
      guests: [
        {
          gender: savedRequest.gender,
          rankCode: savedRequest.rankCode,
          relation: 'PRIMARY',
          name: savedRequest.guestName,
          serviceNumber: savedRequest.serviceNumber,
          unit: savedRequest.unit,
          phone: savedRequest.phone,
        },
        ...savedRequest.companions.map((c) => ({
          gender: c.gender,
          rankCode: c.rankCode,
          relation: c.relation,
          name: c.name.trim() || undefined,
          phone: c.phone.trim() || null,
        })),
      ],
    });

    router.push({
      pathname: '/(app)/bookings/new/rooms' as any,
      params: { payload },
    });
  };

  // SUCCESS CONFIRMATION VIEW
  if (savedRequest) {
    return (
      <Screen title="Request Saved" showBack={true}>
        <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
          <Card style={[styles.card, styles.successCard]}>
            <View style={styles.successIconBadge}>
              <Text style={styles.successIconText}>✓</Text>
            </View>
            <Text style={[styles.successTitle, { color: colors.navy }]}>
              Booking Request Saved
            </Text>
            <Text style={[styles.successSubtitle, { color: colors.muted }]}>
              The booking request has been successfully registered and queued for room allotment.
            </Text>

            <View
              style={[
                styles.detailsBox,
                { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
              ]}
            >
              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { color: colors.muted }]}>Guest Name</Text>
                <Text style={[styles.detailValue, { color: colors.navy }]}>
                  {savedRequest.rankCode} {savedRequest.guestName}
                </Text>
              </View>

              {savedRequest.companions.length > 0 ? (
                <View style={styles.detailRow}>
                  <Text style={[styles.detailLabel, { color: colors.muted }]}>Party</Text>
                  <Text style={[styles.detailValue, { color: colors.text }]}>
                    {savedRequest.companions.length + 1} people
                  </Text>
                </View>
              ) : null}

              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { color: colors.muted }]}>Request ID</Text>
                <Badge label={savedRequest.guestCode} variant="default" />
              </View>

              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { color: colors.muted }]}>Category</Text>
                <Badge
                  label={savedRequest.category}
                  variant={savedRequest.category === 'MFA' ? 'navy' : 'neutral'}
                />
              </View>

              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { color: colors.muted }]}>Stay Period</Text>
                <Text style={[styles.detailValue, { color: colors.text }]}>
                  📅 {savedRequest.checkIn} (12:00 PM) → {savedRequest.checkOut} (12:00 PM) ({savedRequest.nights} night
                  {savedRequest.nights === 1 ? '' : 's'})
                </Text>
              </View>

              <View style={{ paddingVertical: 2 }}>
                <Text style={{ fontSize: 11, color: colors.muted, fontStyle: 'italic' }}>
                  Standard Turnover: Check-in from 12:00 PM · Vacate by 12:00 PM on departure date
                </Text>
              </View>

              {savedRequest.preferredRoomType ? (
                <View style={styles.detailRow}>
                  <Text style={[styles.detailLabel, { color: colors.muted }]}>
                    Room Preference
                  </Text>
                  <Text style={[styles.detailValue, { color: colors.text }]}>
                    {savedRequest.preferredRoomType.replace('_', ' ')}
                  </Text>
                </View>
              ) : null}

              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { color: colors.muted }]}>Room Sharing</Text>
                <Text style={[styles.detailValue, { color: colors.text }]}>
                  {savedRequest.allowSharing ? 'Allowed' : 'Not allowed (whole room held)'}
                </Text>
              </View>

              {savedRequest.serviceNumber ? (
                <View style={styles.detailRow}>
                  <Text style={[styles.detailLabel, { color: colors.muted }]}>Service No</Text>
                  <Text style={[styles.detailValue, { color: colors.text }]}>
                    {savedRequest.serviceNumber}
                  </Text>
                </View>
              ) : null}

              {savedRequest.unit ? (
                <View style={styles.detailRow}>
                  <Text style={[styles.detailLabel, { color: colors.muted }]}>Unit</Text>
                  <Text style={[styles.detailValue, { color: colors.text }]}>
                    {savedRequest.unit}
                  </Text>
                </View>
              ) : null}

              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { color: colors.muted }]}>Status</Text>
                <Badge label="PENDING ALLOTMENT" variant="saffron" />
              </View>
            </View>

            <View style={styles.successActions}>
              <Button
                label="Choose Room & Allot Now →"
                onPress={handleAllotNow}
                style={{ width: '100%', marginBottom: spacing.sm }}
              />

              <Button
                label="View in Booking Requests Queue"
                variant="secondary"
                onPress={() => router.push('/(app)/requests' as any)}
                style={{ width: '100%', marginBottom: spacing.sm }}
              />

              <Button
                label="Take Another Request"
                variant="secondary"
                onPress={handleResetForm}
                style={{ width: '100%' }}
              />
            </View>
          </Card>
        </ScrollView>
      </Screen>
    );
  }

  // MAIN REQUEST INTAKE WIZARD VIEW
  return (
    <Screen title="New Booking Request" showBack={true}>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        {submitError ? (
          <Banner message={submitError} type="error" style={{ marginBottom: spacing.md }} />
        ) : null}

        {/* Pre-selected Target Room Banner */}
        {targetRoomName && (
          <Card style={[styles.card, { marginBottom: spacing.md, backgroundColor: '#EFF6FF', borderColor: '#3B82F6' }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 10, color: '#1D4ED8', fontWeight: '800', letterSpacing: 0.5 }}>
                  🎯 PRE-SELECTED TARGET ROOM:
                </Text>
                <Text style={{ fontSize: typography.base, color: '#1E3A8A', fontWeight: '800', marginTop: 2 }}>
                  {targetRoomName} ({preferredType !== 'ANY' ? preferredType.replace('_', ' ') : 'Room'}){targetBedSlot ? ` · Bed ${targetBedSlot}` : ''}
                </Text>
                <Text style={{ fontSize: 11, color: '#2563EB', marginTop: 2 }}>
                  This room will be automatically chosen when you proceed to room allotment.
                </Text>
              </View>
              <Pressable
                onPress={() => {
                  setTargetRoomId(null);
                  setTargetRoomName(null);
                  setTargetBedSlot(null);
                }}
                style={{ padding: spacing.xs }}
              >
                <Badge label="Clear Target" variant="neutral" />
              </Pressable>
            </View>
          </Card>
        )}

        {/* Section 1: Stay Details */}
        <Card style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={[styles.sectionTitle, { color: colors.navy }]}>1. STAY DETAILS</Text>
            <Badge label="Step 1 of 2" variant="default" />
          </View>
          <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>
            Military Mess Policy: Check-in is at 12:00 PM (noon) and Check-out is at 12:00 PM (noon).
          </Text>

          <Select
            label="Visitor Category"
            value={category}
            onChange={(val: string) => setCategory(val as Category)}
            options={CATEGORY_OPTIONS}
          />

          <View style={{ marginTop: spacing.sm }}>
            <DateRange
              label="Stay Period (Check-In & Check-Out)"
              startDate={checkIn}
              endDate={checkOut}
              onStartDateChange={setCheckIn}
              onEndDateChange={setCheckOut}
            />
          </View>

          <View style={{ marginTop: spacing.sm }}>
            <Select
              label="Preferred Room Type (Optional)"
              value={preferredType}
              onChange={(val: string) => setPreferredType(val as RoomType | 'ANY')}
              options={ROOM_PREFERENCE_OPTIONS}
            />
          </View>

          <View style={{ marginTop: spacing.sm }}>
            <Checkbox
              label="Allow room sharing"
              hint="Unchecked: only fully vacant rooms are offered and this booking holds each room it uses for its own party. Checked: rooms with a free bed beside a compatible guest (same gender, any rank, and that booking allows sharing) are offered as well."
              checked={allowSharing}
              onChange={setAllowSharing}
            />
          </View>
        </Card>

        {/* Section 2: Guest Details (All Optional) */}
        <Card style={[styles.card, { marginTop: spacing.md }]}>
          <View style={styles.cardHeaderRow}>
            <Text style={[styles.sectionTitle, { color: colors.navy }]}>2. GUEST DETAILS</Text>
            <Badge label="All Fields Optional" variant="neutral" />
          </View>
          <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>
            Enter the guest information. None of these fields are mandatory.
          </Text>

          <Select
            label="Rank"
            value={currentRank}
            onChange={(val: string) => setCurrentRank(val as RankCode)}
            options={RANK_OPTIONS}
          />

          <View style={{ marginTop: spacing.sm }}>
            <Select
              label="Gender"
              value={currentGender}
              onChange={(val: string) => setCurrentGender(val as Gender)}
              options={GENDER_OPTIONS}
            />
          </View>

          <View style={{ marginTop: spacing.sm }}>
            <Field
              label="Guest Full Name (Optional)"
              placeholder="e.g. Wing Commander Abhinandan"
              value={currentName}
              onChangeText={setCurrentName}
            />
          </View>

          <View style={styles.rowFields}>
            <View style={{ flex: 1 }}>
              <Field
                label="Service Number (Optional)"
                placeholder="e.g. 27419-A"
                value={currentServiceNumber}
                onChangeText={setCurrentServiceNumber}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                label="Unit / Formation (Optional)"
                placeholder="e.g. 51 Squadron"
                value={currentUnit}
                onChangeText={setCurrentUnit}
              />
            </View>
          </View>

          <View style={{ marginTop: spacing.sm }}>
            <Field
              label="Contact Phone (Optional)"
              placeholder="e.g. 9876543210"
              value={currentPhone}
              onChangeText={setCurrentPhone}
              keyboardType="phone-pad"
            />
          </View>

          <View style={styles.rowFields}>
            <View style={{ flex: 1 }}>
              <Select
                label="ID Document Type"
                value={currentIdType}
                onChange={(val: string) => setCurrentIdType(val)}
                options={ID_TYPE_OPTIONS}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                label="ID Number (Optional)"
                placeholder="e.g. IAF-98231"
                value={currentIdNumber}
                onChangeText={setCurrentIdNumber}
              />
            </View>
          </View>

          <View style={{ marginTop: spacing.sm }}>
            <Field
              label="Special Requests / Remarks (Optional)"
              placeholder="e.g. Ground floor preferred, vegetarian meals"
              value={currentNotes}
              onChangeText={setCurrentNotes}
              multiline
              numberOfLines={2}
            />
          </View>
        </Card>

        {/* Section 3: Party (family / other service members) */}
        <Card style={[styles.card, { marginTop: spacing.md }]}>
          <View style={styles.cardHeaderRow}>
            <Text style={[styles.sectionTitle, { color: colors.navy }]}>
              3. TRAVELLING WITH ({companions.length})
            </Text>
            <Badge label="Optional" variant="neutral" />
          </View>
          <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>
            Add family members and other civilians, or further service members. Civilians need no
            rank and may share a room with anyone in this booking, but never with another booking's
            guests. Ranked guests share only with guests of the same gender. Every person takes one bed.
          </Text>

          {companions.map((c, idx) => {
            const civilian = !c.rankCode;
            return (
              <View key={idx} style={[styles.companionRow, { borderColor: colors.border }]}>
                <View style={styles.cardHeaderRow}>
                  <Text style={[styles.companionTitle, { color: colors.navy }]}>
                    Person {idx + 2}
                  </Text>
                  <Button
                    label="Remove"
                    variant="secondary"
                    accessibilityLabel={`Remove person ${idx + 2}`}
                    onPress={() => handleRemoveCompanion(idx)}
                  />
                </View>
                <Select
                  label="Relation"
                  value={c.relation}
                  onChange={(val: string) => handleChangeRelation(idx, val as GuestRelation)}
                  options={COMPANION_RELATION_OPTIONS}
                />
                <View style={{ marginTop: spacing.sm }}>
                  <Select
                    label="Gender"
                    value={c.gender}
                    onChange={(val: string) => handleUpdateCompanion(idx, { gender: val as Gender })}
                    options={GENDER_OPTIONS}
                  />
                </View>
                {!civilian && (
                  <View style={{ marginTop: spacing.sm }}>
                    <Select
                      label="Rank"
                      value={c.rankCode ?? currentRank}
                      onChange={(val: string) => handleUpdateCompanion(idx, { rankCode: val as RankCode })}
                      options={RANK_OPTIONS}
                    />
                  </View>
                )}
                <View style={{ marginTop: spacing.sm }}>
                  <Field
                    label={civilian ? 'Full Name' : 'Full Name (Optional)'}
                    placeholder="Name as on ID"
                    value={c.name}
                    onChangeText={(text) => handleUpdateCompanion(idx, { name: text })}
                    hint={civilian ? 'Can be completed later from Guest Details' : undefined}
                  />
                </View>
                <View style={{ marginTop: spacing.sm }}>
                  <Field
                    label="Contact Number (Optional)"
                    placeholder="e.g. 9876543210"
                    value={c.phone}
                    onChangeText={(text) => handleUpdateCompanion(idx, { phone: text })}
                    keyboardType="phone-pad"
                  />
                </View>
              </View>
            );
          })}

          {unnamedCivilians > 0 && (
            <Banner
              type="warning"
              message={`${unnamedCivilians} civilian guest${unnamedCivilians > 1 ? 's have' : ' has'} no name yet. You can add it later from Guest Details.`}
              style={{ marginTop: spacing.sm }}
            />
          )}

          <View style={styles.addRow}>
            <Button label="+ Add Family / Civilian" variant="secondary" onPress={handleAddCivilian} />
            <Button label="+ Add Service Member" variant="secondary" onPress={handleAddServiceMember} />
          </View>
        </Card>

        {/* Action Buttons */}
        <View style={styles.actionContainer}>
          <Button
            label="Save & Choose Room Now →"
            variant="primary"
            onPress={() => handleSaveRequest(true)}
            disabled={!datesValid || submitting}
            loading={submitting}
            style={{ width: '100%', marginBottom: spacing.sm }}
          />
          <Button
            label="Save for Later Allotment"
            variant="secondary"
            onPress={() => handleSaveRequest(false)}
            disabled={!datesValid || submitting}
            style={{ width: '100%' }}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingBottom: spacing.xxl,
  },
  card: {
    padding: spacing.md,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  sectionTitle: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
    letterSpacing: 0.5,
  },
  sectionSubtitle: {
    fontSize: typography.xs,
    marginBottom: spacing.md,
  },
  rowFields: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  companionRow: {
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  companionTitle: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
  },
  addRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  actionContainer: {
    marginTop: spacing.lg,
    marginBottom: spacing.xxl,
  },
  // Success Card Styles
  successCard: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
  successIconBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#10B981',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  successIconText: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: 'bold',
  },
  successTitle: {
    fontSize: typography.lg,
    fontWeight: typography.weights.bold,
    marginBottom: spacing.xs,
  },
  successSubtitle: {
    fontSize: typography.sm,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  detailsBox: {
    width: '100%',
    borderRadius: 12,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.xl,
    gap: spacing.sm,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  detailLabel: {
    fontSize: typography.xs,
    fontWeight: '600',
  },
  detailValue: {
    fontSize: typography.sm,
    fontWeight: typography.weights.medium,
  },
  successActions: {
    width: '100%',
  },
});
