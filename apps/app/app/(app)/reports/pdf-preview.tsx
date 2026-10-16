import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useThemeStore } from '../../../src/state/themeStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Button } from '../../../src/ui/primitives/Button';
import { spacing } from '../../../src/ui/tokens';
import { exportReportPdf } from '../../../src/features/reports/pdfGenerator';
import { logAction } from '../../../src/lib/activityLog';
import type { ReportDailyRow, ReportInsights } from '@sms/core';

export default function PdfPreviewScreen() {
  const { payload } = useLocalSearchParams<{ payload: string }>();
  const colors = useThemeStore((s) => s.colors);

  const parsed = payload ? JSON.parse(payload) : null;
  const { periodLabel, insights, dailyRows, denials } = parsed || {
    periodLabel: 'Current Period',
    insights: {
      totalPeopleDays: 0,
      totalGuestDays: 0,
      dailyAverage: 0,
      peakDay: 'N/A',
      peakCount: 0,
      peakOccupancyPercentage: 0,
      msaPiSharePercentage: 0,
      bedsTotal: 92,
      denialCount: 0,
      writtenInsights: [],
    } as ReportInsights,
    dailyRows: [] as ReportDailyRow[],
    denials: [],
  };

  const handlePrint = async () => {
    await exportReportPdf({
      periodLabel,
      insights,
      dailyRows,
      denials,
    });
    logAction('reports.print_pdf', { meta: { period: periodLabel } });
  };

  return (
    <Screen title="PDF A4 Report Preview" showBack={true}>
      <View style={styles.container}>
        <View style={styles.topActions}>
          <Button label="Print / Download PDF" variant="primary" onPress={handlePrint} />
        </View>

        {/* A4 Sheet Simulation */}
        <View style={[styles.a4Sheet, { backgroundColor: '#FFFFFF', borderColor: colors.border }]}>
          <View style={styles.sheetHeader}>
            <View>
              <Text style={styles.sheetTitle}>SMART MESS SYSTEM (SMS)</Text>
              <Text style={styles.sheetSubtitle}>
                RESIDENTIAL OCCUPANCY & CAPACITY LEDGER REPORT
              </Text>
            </View>
            <View style={styles.sheetMeta}>
              <Text style={styles.metaText}>Period: {periodLabel}</Text>
              <Text style={styles.metaText}>Generated: {new Date().toLocaleDateString()}</Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.statGrid}>
            <View style={styles.statBox}>
              <Text style={styles.statLabel}>TOTAL GUEST-DAYS</Text>
              <Text style={styles.statVal}>{insights.totalGuestDays}</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statLabel}>DAILY AVERAGE</Text>
              <Text style={styles.statVal}>{insights.dailyAverage}</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statLabel}>PEAK OCCUPANCY</Text>
              <Text style={styles.statVal}>
                {insights.peakCount} ({insights.peakOccupancyPercentage}%)
              </Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statLabel}>PRIORITY SHARE (MFA+PI)</Text>
              <Text style={styles.statVal}>{insights.msaPiSharePercentage}%</Text>
            </View>
          </View>

          <View style={styles.divider} />

          <Text style={styles.sectionTitle}>OPERATIONAL INSIGHTS</Text>
          {insights.writtenInsights?.map((line: string, i: number) => (
            <Text key={i} style={styles.insightItem}>
              • {line}
            </Text>
          ))}

          <View style={styles.divider} />

          <View style={styles.footer}>
            <Text style={styles.footerText}>
              CONFIDENTIAL • NO GUEST IDENTIFIERS OR PII INCLUDED • OFFICIAL RECORDS
            </Text>
          </View>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    alignItems: 'center',
  },
  topActions: {
    width: '100%',
    maxWidth: 760,
    marginBottom: spacing.md,
  },
  a4Sheet: {
    width: '100%',
    maxWidth: 760,
    minHeight: 900,
    borderWidth: 1,
    padding: spacing.xl,
    shadowColor: '#000000',
    shadowOpacity: 0.05,
    shadowRadius: 8,
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#12283F',
  },
  sheetSubtitle: {
    fontSize: 12,
    color: '#5B6877',
    marginTop: 2,
  },
  sheetMeta: {
    alignItems: 'flex-end',
  },
  metaText: {
    fontSize: 11,
    color: '#5B6877',
  },
  divider: {
    height: 1,
    backgroundColor: '#DDE2E8',
    marginVertical: spacing.md,
  },
  statGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  statBox: {
    flex: 1,
    padding: spacing.sm,
    backgroundColor: '#F4F6F8',
    borderRadius: 4,
  },
  statLabel: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#5B6877',
  },
  statVal: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#12283F',
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#12283F',
    marginBottom: spacing.xs,
  },
  insightItem: {
    fontSize: 12,
    color: '#1B2733',
    lineHeight: 18,
    marginBottom: 4,
  },
  footer: {
    marginTop: spacing.xl,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderColor: '#DDE2E8',
    alignItems: 'center',
  },
  footerText: {
    fontSize: 10,
    color: '#8795A5',
    letterSpacing: 0.5,
  },
});
