import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
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
import { exportReportPdf } from '../../../src/features/reports/pdfGenerator';
import { reportInsights, type ReportDailyRow } from '@sms/core';

export default function ReportsScreen() {
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
  const insights = reportInsights(dailyRows || [], totalBeds);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await exportReportPdf({
        periodLabel,
        insights,
        dailyRows: dailyRows || [],
        denials: denials || [],
      });
      logAction('reports.export_pdf', { meta: { period: periodLabel } });
    } catch (err: any) {
      setExportError(userErrorMessage(err, 'PDF export failed.'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Screen title="Occupancy & Insights Reports" showBack={false}>
      <View style={styles.container}>
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

        {exportError && <Banner type="error" message={exportError} style={{ marginTop: spacing.md }} />}

        {/* Headline Numbers Strip */}
        <View style={styles.statsStrip}>
          <Stat label="Total Guest-Days" value={insights.totalGuestDays} />
          <Stat label="Daily Average" value={insights.dailyAverage} />
          <Stat
            label="Peak Day"
            value={insights.peakDay ? `${insights.peakCount} (${insights.peakDay})` : 'N/A'}
          />
          <Stat label="Priority Share" value={`${insights.msaPiSharePercentage}%`} />
          <Stat label="Peak Occupancy" value={`${insights.peakOccupancyPercentage}%`} />
        </View>

        {/* Stacked Chart Card */}
        <Card style={{ marginTop: spacing.md }}>
          <View style={styles.chartHeader}>
            <Text style={[styles.cardTitle, { color: colors.navy }]}>
              DATE VS PEOPLE OCCUPANCY (BY CATEGORY)
            </Text>
            <Button
              label="Export PDF Report"
              variant="primary"
              onPress={handleExport}
              loading={exporting}
            />
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
