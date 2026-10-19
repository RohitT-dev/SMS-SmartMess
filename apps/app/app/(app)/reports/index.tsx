import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useThemeStore } from '../../../src/state/themeStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Card } from '../../../src/ui/primitives/Card';
import { Stat } from '../../../src/ui/primitives/Stat';
import { Button } from '../../../src/ui/primitives/Button';
import { Segmented } from '../../../src/ui/primitives/Segmented';
import { DateRange } from '../../../src/ui/primitives/DateRange';
import { Table } from '../../../src/ui/primitives/Table';
import { Banner } from '../../../src/ui/primitives/Banner';
import { userErrorMessage } from '../../../src/lib/userError';
import { spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';
import { logAction } from '../../../src/lib/activityLog';
import { addDaysToDateString, isValidDateString, localDateString } from '../../../src/lib/dates';
import { ChartSvg } from '../../../src/features/reports/chartSvg';
import {
  previewInsightsReport,
  previewOccupancyReport,
} from '../../../src/features/reports/pdfGenerator';
import { reportInsights, type ReportDailyRow } from '@sms/core';

export default function ReportsScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);

  const [rangePreset, setRangePreset] = useState<'this_month' | 'last_month' | 'custom'>(
    'this_month',
  );

  // Month boundaries as local calendar dates (toISOString() would shift them a day in IST).
  const now = new Date();
  const firstDayThisMonth = localDateString(new Date(now.getFullYear(), now.getMonth(), 1));
  const lastDayThisMonth = localDateString(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  const firstDayLastMonth = localDateString(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const lastDayLastMonth = localDateString(new Date(now.getFullYear(), now.getMonth(), 0));

  const [customFrom, setCustomFrom] = useState(firstDayThisMonth);
  const [customTo, setCustomTo] = useState(lastDayThisMonth);

  // Shown dates are inclusive; the report RPCs take an exclusive upper bound.
  const fromDate =
    rangePreset === 'this_month'
      ? firstDayThisMonth
      : rangePreset === 'last_month'
        ? firstDayLastMonth
        : customFrom;

  const toDateInclusive =
    rangePreset === 'this_month'
      ? lastDayThisMonth
      : rangePreset === 'last_month'
        ? lastDayLastMonth
        : customTo;

  const rangeValid =
    isValidDateString(fromDate) && isValidDateString(toDateInclusive) && toDateInclusive >= fromDate;
  const toDate = rangeValid ? addDaysToDateString(toDateInclusive, 1) : toDateInclusive;

  const periodLabel =
    rangePreset === 'this_month'
      ? 'This Month'
      : rangePreset === 'last_month'
        ? 'Last Month'
        : `${fromDate} to ${toDateInclusive}`;

  // 1. Fetch daily report data
  const { data: dailyRows, isLoading } = useQuery({
    queryKey: ['report_daily', fromDate, toDate],
    enabled: rangeValid,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('report_daily', {
        p_from: fromDate,
        p_to: toDate,
      });
      if (error) throw error;
      return (data || []).map((row: any) => ({
        day: row.day,
        category: row.category,
        roomType: row.room_type,
        people: Number(row.people),
      })) as ReportDailyRow[];
    },
  });

  // 2. Fetch denials report
  const { data: denials } = useQuery({
    queryKey: ['report_denials', fromDate, toDate],
    enabled: rangeValid,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('report_denials', {
        p_from: fromDate,
        p_to: toDate,
      });
      if (error) throw error;
      return (data || []).map((d: any) => ({
        category: d.category,
        count: Number(d.count),
      }));
    },
  });

  // Occupancy % is measured against the real inventory: two beds per active non-suite room.
  const { data: totalBeds = 0 } = useQuery({
    queryKey: ['report_total_beds'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rooms')
        .select('id, room_type, is_active')
        .neq('room_type', 'SUITE')
        .eq('is_active', true);
      if (error) throw error;
      return (data || []).length * 2;
    },
  });
  const denialCount = (denials || []).reduce((sum: number, d: { count: number }) => sum + d.count, 0);
  const insights = reportInsights(dailyRows || [], totalBeds, denialCount);

  const [exporting, setExporting] = useState<'occupancy' | 'insights' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Printed documents state the actual dates, not just "This Month".
  const printedPeriod =
    rangePreset === 'custom' ? periodLabel : `${periodLabel} (${fromDate} to ${toDateInclusive})`;

  const runExport = async (kind: 'occupancy' | 'insights') => {
    if (!rangeValid) return;
    setExporting(kind);
    setExportError(null);
    try {
      const options = {
        periodLabel: printedPeriod,
        insights,
        dailyRows: dailyRows || [],
        denials: denials || [],
      };
      if (kind === 'occupancy') previewOccupancyReport(options);
      else previewInsightsReport(options);
      logAction('reports.open_preview', { meta: { report: kind, period: periodLabel } });
    } catch (err: any) {
      setExportError(userErrorMessage(err, 'Could not prepare the report.'));
    } finally {
      setExporting(null);
    }
  };

  return (
    <Screen title="Occupancy & Insights Reports" showBack={false}>
      <View style={styles.container}>
        {/* Navigation to Grid Matrix */}
        <View style={{ marginBottom: spacing.sm, flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Button
            label="Room Occupancy Grid (custom dates & PDF)"
            variant="secondary"
            onPress={() => router.push('/(app)/reports/grid' as any)}
          />
        </View>

        {/* Preset Selector */}
        <Card>
          <Text style={[styles.cardTitle, { color: colors.navy }]}>Reporting period</Text>
          <Segmented
            value={rangePreset}
            onChange={(val) => setRangePreset(val as any)}
            options={[
              { label: 'This Month', value: 'this_month' },
              { label: 'Last Month', value: 'last_month' },
              { label: 'Custom Range', value: 'custom' },
            ]}
          />

          {rangePreset === 'custom' && (
            <View style={{ marginTop: spacing.md }}>
              <DateRange
                label="Custom Report Range (both dates included)"
                startLabel="From"
                endLabel="To"
                inclusive
                startDate={customFrom}
                endDate={customTo}
                onStartDateChange={setCustomFrom}
                onEndDateChange={setCustomTo}
              />
            </View>
          )}
        </Card>

        {/* Export: every report opens the A4 preview, from where it is printed / saved / shared */}
        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.cardTitle, { color: colors.navy }]}>Export reports (PDF)</Text>
          <Text style={[styles.chartNotice, { color: colors.muted }]}>
            Each report opens a preview of the A4 document for the period above, then prints, saves or
            shares it. The guest report has its own filters (room type, category, unit, dates, status)
            and lists names, ranks, units, service numbers, phones and rooms.
          </Text>
          <View style={styles.exportRow}>
            <Button
              label="Occupancy report"
              variant="primary"
              onPress={() => runExport('occupancy')}
              loading={exporting === 'occupancy'}
              disabled={!rangeValid || exporting !== null || isLoading}
            />
            <Button
              label="Insights summary"
              variant="primary"
              onPress={() => runExport('insights')}
              loading={exporting === 'insights'}
              disabled={!rangeValid || exporting !== null || isLoading}
            />
            <Button
              label="Guest report (custom filters)"
              variant="primary"
              onPress={() => router.push('/(app)/reports/guests' as any)}
            />
          </View>
        </Card>

        {exportError && <Banner type="error" message={exportError} style={{ marginTop: spacing.md }} />}

        {/* Headline Numbers Strip */}
        <View style={styles.statsStrip}>
          <Stat label="Total Guest-Days" value={insights.totalGuestDays} />
          <Stat label="Daily Average" value={insights.dailyAverage} />
          <Stat
            label="Peak Day"
            value={insights.peakDay ? `${insights.peakCount} (${insights.peakDay})` : 'N/A'}
          />
          <Stat label="Priority Share" value={`${insights.mfaPiSharePercentage}%`} />
          <Stat label="Peak Occupancy" value={`${insights.peakOccupancyPercentage}%`} />
        </View>

        {/* Stacked Chart Card */}
        <Card style={{ marginTop: spacing.md }}>
          <View style={styles.chartHeader}>
            <Text style={[styles.cardTitle, { color: colors.navy }]}>
              DATE VS PEOPLE OCCUPANCY (BY CATEGORY)
            </Text>
          </View>
          <Text style={[styles.chartNotice, { color: colors.muted }]}>
            Stacked breakdown: Navy = MFA • Blue = PI • Green = LEAVE • Orange = TD • Saffron =
            Suite
          </Text>

          {dailyRows && dailyRows.length > 0 ? (
            <ChartSvg data={dailyRows} width={680} height={260} />
          ) : (
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              {isLoading ? 'Loading report data...' : 'No occupancy records in this range.'}
            </Text>
          )}
        </Card>

        {/* Operational Insights */}
        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.cardTitle, { color: colors.navy }]}>Operational insights</Text>
          <View style={styles.insightsList}>
            {insights.writtenInsights.map((insight, idx) => (
              <View key={idx} style={styles.insightItem}>
                <Text style={[styles.bullet, { color: colors.blue }]}>•</Text>
                <Text style={[styles.insightText, { color: colors.text }]}>{insight}</Text>
              </View>
            ))}
          </View>
        </Card>

        {/* Denials Table */}
        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.cardTitle, { color: colors.navy }]}>Denials summary</Text>
          <Table
            columns={[
              { key: 'category', header: 'Visitor Category', width: 180 },
              { key: 'count', header: 'Recorded Denials', width: 140 },
              {
                key: 'policy',
                header: 'Policy Rule',
                flex: 1,
                render: (item: any) => (
                  <Text style={{ color: colors.muted, fontSize: typography.xs }}>
                    {item.category === 'MFA' || item.category === 'PI'
                      ? 'Protected - Never Denied'
                      : 'Low Priority - Permitted with Written Reason'}
                  </Text>
                ),
              },
            ]}
            data={
              denials && denials.length > 0
                ? denials
                : [
                    { category: 'LEAVE', count: 0 },
                    { category: 'TD', count: 0 },
                    { category: 'MFA', count: 0 },
                    { category: 'PI', count: 0 },
                  ]
            }
            keyExtractor={(item) => item.category}
          />
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  cardTitle: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
    marginBottom: spacing.sm,
  },
  exportRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  statsStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  chartHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  chartNotice: {
    fontSize: typography.xs,
    marginBottom: spacing.md,
  },
  emptyText: {
    padding: spacing.xl,
    textAlign: 'center',
    fontStyle: 'italic',
  },
  insightsList: {
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  insightItem: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  bullet: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
  },
  insightText: {
    flex: 1,
    fontSize: typography.sm,
    lineHeight: 20,
  },
});
