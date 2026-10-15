import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useThemeStore } from '../../../src/state/themeStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Card } from '../../../src/ui/primitives/Card';
import { Stat } from '../../../src/ui/primitives/Stat';
import { Button } from '../../../src/ui/primitives/Button';
import { Segmented } from '../../../src/ui/primitives/Segmented';
import { DateRange } from '../../../src/ui/primitives/DateRange';
import { Banner } from '../../../src/ui/primitives/Banner';
import { Table } from '../../../src/ui/primitives/Table';
import { spacing, typography } from '../../../src/ui/tokens';
import { supabase } from '../../../src/lib/supabase';
import { ChartSvg } from '../../../src/features/reports/chartSvg';
import { exportReportPdf } from '../../../src/features/reports/pdfGenerator';
import {
  reportInsights,
  type ReportDailyRow
} from '@sms/core';

export default function ReportsScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);

  const [rangePreset, setRangePreset] = useState<'this_month' | 'last_month' | 'custom'>('this_month');
  
  // Compute initial dates
  const now = new Date();
  const firstDayThisMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const lastDayThisMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
  
  const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
  const lastDayLastMonth = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];

  const [customFrom, setCustomFrom] = useState(firstDayThisMonth);
  const [customTo, setCustomTo] = useState(lastDayThisMonth);

  const fromDate =
    rangePreset === 'this_month'
      ? firstDayThisMonth
      : rangePreset === 'last_month'
      ? firstDayLastMonth
      : customFrom;

  const toDate =
    rangePreset === 'this_month'
      ? lastDayThisMonth
      : rangePreset === 'last_month'
      ? lastDayLastMonth
      : customTo;

  const periodLabel =
    rangePreset === 'this_month'
      ? 'This Month'
      : rangePreset === 'last_month'
      ? 'Last Month'
      : `${fromDate} to ${toDate}`;

  // 1. Fetch daily report data
  const { data: dailyRows, isLoading } = useQuery({
    queryKey: ['report_daily', fromDate, toDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('report_daily', {
        p_from: fromDate,
        p_to: toDate
      });
      if (error) throw error;
      return (data || []).map((row: any) => ({
        day: row.day,
        category: row.category,
        roomType: row.room_type,
        people: Number(row.people)
      })) as ReportDailyRow[];
    }
  });

  // 2. Fetch denials report
  const { data: denials } = useQuery({
    queryKey: ['report_denials', fromDate, toDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('report_denials', {
        p_from: fromDate,
        p_to: toDate
      });
      if (error) throw error;
      return (data || []).map((d: any) => ({
        category: d.category,
        count: Number(d.count)
      }));
    }
  });

  // Total active non-suite beds (50 rooms * 2 = 100 beds approx)
  const totalBeds = 92;
  const insights = reportInsights(dailyRows || [], totalBeds);

  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      await exportReportPdf({
        periodLabel,
        insights,
        dailyRows: dailyRows || [],
        denials: denials || []
      });
    } catch (err: any) {
      alert('PDF export error: ' + err.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Screen title="Occupancy & Insights Reports" showBack={false}>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Preset Selector */}
        <Card>
          <Text style={[styles.cardTitle, { color: colors.navy }]}>REPORTING PERIOD</Text>
          <Segmented
            value={rangePreset}
            onChange={(val) => setRangePreset(val as any)}
            options={[
              { label: 'This Month', value: 'this_month' },
              { label: 'Last Month', value: 'last_month' },
              { label: 'Custom Range', value: 'custom' }
            ]}
          />

          {rangePreset === 'custom' && (
            <View style={{ marginTop: spacing.md }}>
              <DateRange
                label="Custom Report Range"
                startDate={customFrom}
                endDate={customTo}
                onStartDateChange={setCustomFrom}
                onEndDateChange={setCustomTo}
              />
            </View>
          )}
        </Card>

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
            Stacked breakdown: Navy = MSA • Blue = PI • Green = LEAVE • Orange = TD • Saffron = Suite
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
          <Text style={[styles.cardTitle, { color: colors.navy }]}>OPERATIONAL INSIGHTS</Text>
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
          <Text style={[styles.cardTitle, { color: colors.navy }]}>DENIALS SUMMARY</Text>
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
                    {item.category === 'MSA' || item.category === 'PI'
                      ? 'Protected - Never Denied'
                      : 'Low Priority - Permitted with Written Reason'}
                  </Text>
                )
              }
            ]}
            data={
              denials && denials.length > 0
                ? denials
                : [
                    { category: 'LEAVE', count: 0 },
                    { category: 'TD', count: 0 },
                    { category: 'MSA', count: 0 },
                    { category: 'PI', count: 0 }
                  ]
            }
            keyExtractor={(item) => item.category}
          />
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.md
  },
  cardTitle: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
    marginBottom: spacing.sm
  },
  statsStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md
  },
  chartHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs
  },
  chartNotice: {
    fontSize: typography.xs,
    marginBottom: spacing.md
  },
  emptyText: {
    padding: spacing.xl,
    textAlign: 'center',
    fontStyle: 'italic'
  },
  insightsList: {
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  insightItem: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start'
  },
  bullet: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold
  },
  insightText: {
    flex: 1,
    fontSize: typography.sm,
    lineHeight: 20
  }
});
