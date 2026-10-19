import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { RANKS, type Category, type Gender, type RankCode, type RoomType } from '@sms/core';
import { useThemeStore } from '../../../src/state/themeStore';
import { useSessionStore } from '../../../src/state/sessionStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Card } from '../../../src/ui/primitives/Card';
import { Button } from '../../../src/ui/primitives/Button';
import { Segmented } from '../../../src/ui/primitives/Segmented';
import { DateInput, DateRange } from '../../../src/ui/primitives/DateRange';
import { Field } from '../../../src/ui/primitives/Field';
import { Select } from '../../../src/ui/primitives/Select';
import { Table } from '../../../src/ui/primitives/Table';
import { Banner } from '../../../src/ui/primitives/Banner';
import { layout, spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';
import { logAction } from '../../../src/lib/activityLog';
import { userErrorMessage } from '../../../src/lib/userError';
import { addDaysToDateString, isValidDateString, localDateString } from '../../../src/lib/dates';
import { decryptRoomName } from '../../../src/features/crypto-session/cryptoSession';
import {
  ROOM_TYPE_LABELS,
  STAY_STATUS_LABELS,
  describeGuestReportFilters,
  filterGuestReportRows,
  periodFetchWindow,
  type GuestReportFilters,
  type GuestReportPeriod,
  type GuestReportRow,
  type ReportRoom,
  type StayStatus,
} from '../../../src/features/reports/guestReport';
import { fetchGuestReportRows } from '../../../src/features/reports/reportData';
import { previewGuestReport } from '../../../src/features/reports/guestReportPdfGenerator';

type PeriodMode = GuestReportPeriod['mode'];

const CATEGORY_CODES: Category[] = ['MFA', 'PI', 'LEAVE', 'TD'];
const STATUS_OPTIONS: StayStatus[] = ['UPCOMING', 'CURRENT', 'COMPLETED', 'CANCELLED', 'DISPLACED'];
/** Rows shown on screen; the printed report lists every match. */
const ON_SCREEN_LIMIT = 100;

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function Chips<T extends string>({
  label,
  options,
  selected,
  onChange,
  hint,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  selected: T[];
  onChange: (next: T[]) => void;
  hint?: string;
}) {
  const colors = useThemeStore((s) => s.colors);
  return (
    <View style={styles.filterBlock}>
      <Text style={[styles.filterLabel, { color: colors.text }]}>
        {label}
        <Text style={{ color: colors.muted, fontWeight: '400' }}>{hint ?? (selected.length === 0 ? '  (any)' : '')}</Text>
      </Text>
      <View style={styles.chipRow}>
        {options.map((o) => {
          const on = selected.includes(o.value);
          return (
            <Pressable
              key={o.value}
              onPress={() => onChange(toggle(selected, o.value))}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${label}: ${o.label}`}
              style={[
                styles.chip,
                {
                  backgroundColor: on ? colors.navy : colors.surface,
                  borderColor: on ? colors.navy : colors.borderStrong,
                },
              ]}
            >
              <Text style={{ color: on ? '#FFFFFF' : colors.text, fontSize: typography.sm, fontWeight: '600' }}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Rooms with decrypted names and their type (suites only come back for admins, per RLS). */
function useReportRooms() {
  return useQuery({
    queryKey: ['report_rooms'],
    queryFn: async () => {
      const { data, error } = await supabase.from('rooms').select('id, name_enc, room_type');
      if (error) throw error;
      const rooms: Record<string, ReportRoom> = {};
      for (const r of data || []) rooms[r.id] = { name: decryptRoomName(r.id, r.name_enc), type: r.room_type };
      return rooms;
    },
    staleTime: 60_000,
  });
}

/**
 * Custom guest report: pick any mix of room type, category, unit, dates, status, gender and rank,
 * check the live count and list, then open the A4 report to print, save or share.
 */
export default function GuestReportScreen() {
  const colors = useThemeStore((s) => s.colors);
  const isAdmin = useSessionStore((s) => s.userRole === 'admin');
  const today = localDateString();
  // ?preset=past (from Past Bookings) opens on completed stays; ?category=MFA preselects one.
  const params = useLocalSearchParams<{ preset?: string; category?: string }>();
  const fromPast = params.preset === 'past';
  const presetCategory = CATEGORY_CODES.find((c) => c === params.category);

  const [mode, setMode] = useState<PeriodMode>(fromPast ? 'all' : 'day');
  const [day, setDay] = useState(today);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDaysToDateString(today, 30));
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([]);
  const [categories, setCategories] = useState<Category[]>(presetCategory ? [presetCategory] : []);
  const [unit, setUnit] = useState('');
  // Cancelled and displaced stays are left out unless asked for.
  const [statuses, setStatuses] = useState<StayStatus[]>(
    fromPast ? ['COMPLETED'] : ['UPCOMING', 'CURRENT', 'COMPLETED'],
  );
  const [gender, setGender] = useState<Gender | 'ANY'>('ANY');
  const [rank, setRank] = useState<RankCode | 'ANY'>('ANY');
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const period: GuestReportPeriod | null =
    mode === 'day'
      ? isValidDateString(day)
        ? { mode: 'day', day }
        : null
      : mode === 'range'
        ? isValidDateString(from) && isValidDateString(to) && to >= from
          ? { mode: 'range', from, to }
          : null
        : { mode: 'all' };

  const filters: GuestReportFilters | null = period && {
    period,
    roomTypes,
    categories,
    unit,
    statuses,
    gender: gender === 'ANY' ? null : gender,
    rankCodes: rank === 'ANY' ? [] : [rank],
  };

  const { data: rooms, error: roomsError } = useReportRooms();
  const fetchWindow = period ? periodFetchWindow(period, addDaysToDateString) : null;
  const dayForBeds = period?.mode === 'day' ? period.day : undefined;

  const {
    data: allRows,
    isLoading,
    error: rowsError,
  } = useQuery({
    queryKey: ['guest_report_rows', today, fetchWindow?.from ?? null, fetchWindow?.toExclusive ?? null, dayForBeds ?? null],
    enabled: !!period && !!rooms,
    queryFn: () =>
      fetchGuestReportRows({
        today,
        from: fetchWindow?.from,
        toExclusive: fetchWindow?.toExclusive,
        rooms,
        day: dayForBeds,
      }),
  });

  const rows = allRows && filters ? filterGuestReportRows(allRows, filters) : [];

  const roomTypeOptions = (['VIP', 'SEMI_VIP', 'NORMAL', 'SUITE'] as RoomType[])
    .filter((t) => t !== 'SUITE' || isAdmin)
    .map((t) => ({ value: t, label: ROOM_TYPE_LABELS[t] }));

  const openReport = () => {
    if (!filters || opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      previewGuestReport({ rows, filters: describeGuestReportFilters(filters) });
      // Filter names only: the unit text is left out of the activity log.
      logAction('reports.open_preview', {
        meta: { report: 'guest_report', filters: describeGuestReportFilters(filters).map((f) => f.label).join(', ') },
      });
    } catch (err) {
      setOpenError(userErrorMessage(err, 'Could not prepare the report.'));
    } finally {
      setOpening(false);
    }
  };

  const reset = () => {
    setMode('day');
    setDay(today);
    setRoomTypes([]);
    setCategories([]);
    setUnit('');
    setStatuses(['UPCOMING', 'CURRENT', 'COMPLETED']);
    setGender('ANY');
    setRank('ANY');
  };

  const loadError = roomsError || rowsError;

  return (
    <Screen title="Guest Report" showBack={true}>
      <View style={styles.container}>
        <Card>
          <Text style={[styles.cardTitle, { color: colors.navy }]}>Who is in the report</Text>
          <Text style={[styles.help, { color: colors.muted }]}>
            Combine any filters. Examples: everyone in VIP rooms today; all MFA guests; all guests from one unit.
            ID numbers are never printed.
          </Text>

          <View style={styles.filterBlock}>
            <Text style={[styles.filterLabel, { color: colors.text }]}>Dates</Text>
            <Segmented
              value={mode}
              onChange={(v) => setMode(v as PeriodMode)}
              options={[
                { label: 'In house on a day', value: 'day' },
                { label: 'Stays in a date range', value: 'range' },
                { label: 'All dates', value: 'all' },
              ]}
            />
            <View style={{ marginTop: spacing.sm }}>
              {mode === 'day' && (
                <View style={styles.dayRow}>
                  <View style={{ flex: 1, maxWidth: 220 }}>
                    <DateInput
                      value={day}
                      onChange={setDay}
                      accessibilityLabel="In house on"
                      disabled={false}
                      hasError={!isValidDateString(day)}
                    />
                  </View>
                  {day !== today && <Button label="Today" variant="secondary" onPress={() => setDay(today)} />}
                </View>
              )}
              {mode === 'range' && (
                <DateRange
                  startLabel="From"
                  endLabel="To"
                  inclusive
                  hideNights
                  startDate={from}
                  endDate={to}
                  onStartDateChange={setFrom}
                  onEndDateChange={setTo}
                />
              )}
            </View>
          </View>

          <Chips label="Room type" options={roomTypeOptions} selected={roomTypes} onChange={setRoomTypes} />
          <Chips
            label="Booking category"
            options={CATEGORY_CODES.map((c) => ({ value: c, label: c }))}
            selected={categories}
            onChange={setCategories}
          />
          {mode === 'day' ? (
            <Text style={[styles.help, { color: colors.muted }]}>
              Status: only guests actually in house on that day (cancelled stays are left out).
            </Text>
          ) : (
            <Chips
              label="Status"
              options={STATUS_OPTIONS.map((s) => ({ value: s, label: STAY_STATUS_LABELS[s] }))}
              selected={statuses}
              onChange={setStatuses}
            />
          )}

          <View style={styles.row}>
            <View style={{ flex: 2, minWidth: 220 }}>
              <Field label="Unit (contains)" value={unit} onChangeText={setUnit} placeholder="e.g. 12 Wing" />
            </View>
            <View style={{ flex: 1, minWidth: 180 }}>
              <Select
                label="Gender"
                value={gender}
                onChange={(v) => setGender(v as Gender | 'ANY')}
                options={[
                  { label: 'Any', value: 'ANY' },
                  { label: 'Male', value: 'M' },
                  { label: 'Female', value: 'F' },
                ]}
              />
            </View>
            <View style={{ flex: 1, minWidth: 200 }}>
              <Select
                label="Rank"
                variant="dropdown"
                value={rank}
                onChange={(v) => setRank(v as RankCode | 'ANY')}
                options={[{ label: 'Any rank', value: 'ANY' }, ...RANKS.map((r) => ({ label: r.label, value: r.code }))]}
              />
            </View>
          </View>

          <View style={styles.actions}>
            <Button
              label={`Preview / print (${rows.length} guest${rows.length === 1 ? '' : 's'})`}
              variant="primary"
              onPress={openReport}
              loading={opening}
              disabled={!filters || isLoading || !allRows}
            />
            <Button label="Clear filters" variant="secondary" onPress={reset} />
          </View>
        </Card>

        {!period && <Banner type="error" message="Enter valid dates (the end date can’t be before the start)." />}
        {loadError && <Banner type="error" message={userErrorMessage(loadError, 'Could not load guests.')} />}
        {openError && <Banner type="error" message={openError} />}

        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.cardTitle, { color: colors.navy }]}>
            {isLoading ? 'Loading guests...' : `${rows.length} guest${rows.length === 1 ? '' : 's'} match`}
          </Text>
          {filters && (
            <Text style={[styles.help, { color: colors.muted }]}>
              {describeGuestReportFilters(filters)
                .map((f) => `${f.label}: ${f.value}`)
                .join('  ·  ')}
            </Text>
          )}
          <Table<GuestReportRow>
            loading={isLoading}
            emptyText="No guests match these filters."
            data={rows.slice(0, ON_SCREEN_LIMIT)}
            keyExtractor={(r) => r.guestId}
            columns={[
              { key: 'name', header: 'Name', width: 170 },
              { key: 'rank', header: 'Rank / Relation', width: 140 },
              { key: 'unit', header: 'Unit', width: 130 },
              { key: 'serviceNumber', header: 'Service No.', width: 100 },
              { key: 'phone', header: 'Phone', width: 110 },
              {
                key: 'room',
                header: 'Room / Bed',
                width: 130,
                render: (r) => (
                  <Text style={{ color: r.room ? colors.text : colors.muted, fontSize: typography.sm }}>
                    {r.room ? `${r.room}${r.bed ? ` (Bed ${r.bed})` : ''}` : 'Not allotted'}
                  </Text>
                ),
              },
              {
                key: 'roomType',
                header: 'Room type',
                width: 90,
                render: (r) => (
                  <Text style={{ color: colors.text, fontSize: typography.sm }}>
                    {r.roomType ? (ROOM_TYPE_LABELS[r.roomType as RoomType] ?? r.roomType) : ''}
                  </Text>
                ),
              },
              { key: 'category', header: 'Category', width: 80 },
              { key: 'checkIn', header: 'Check-in', width: 100 },
              { key: 'checkOut', header: 'Check-out', width: 100 },
              {
                key: 'status',
                header: 'Status',
                width: 100,
                render: (r) => (
                  <Text style={{ color: colors.text, fontSize: typography.sm }}>{STAY_STATUS_LABELS[r.status]}</Text>
                ),
              },
            ]}
          />
          {rows.length > ON_SCREEN_LIMIT && (
            <Text style={[styles.help, { color: colors.muted, marginTop: spacing.sm }]}>
              Showing the first {ON_SCREEN_LIMIT}. The printed report lists all {rows.length}.
            </Text>
          )}
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    gap: spacing.md,
  },
  cardTitle: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
    marginBottom: spacing.sm,
  },
  help: {
    fontSize: typography.xs,
    marginBottom: spacing.sm,
  },
  filterBlock: {
    marginBottom: spacing.md,
  },
  filterLabel: {
    fontSize: typography.sm,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chip: {
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    justifyContent: 'center',
  },
  dayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
});
