import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { spacing, typography } from '../../ui/tokens';
import type { ReportDocument } from './reportDocument';

/**
 * Native preview. There is no HTML view on native, so this shows the report's headline figures
 * and findings; the full A4 layout is rendered by expo-print when the PDF is shared or printed.
 */
export function ReportFrame({ doc }: { doc: ReportDocument }) {
  const colors = useThemeStore((s) => s.colors);
  return (
    <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.title, { color: colors.navy }]}>{doc.title}</Text>
      <Text style={[styles.meta, { color: colors.muted }]}>
        {doc.pageCount} page{doc.pageCount === 1 ? '' : 's'} - A4 {doc.orientation}
      </Text>
      <View style={styles.kpis}>
        {doc.summary.kpis.map((k) => (
          <View key={k.label} style={[styles.kpi, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
            <Text style={[styles.kpiLabel, { color: colors.muted }]}>{k.label}</Text>
            <Text style={[styles.kpiValue, { color: colors.navy }]}>{k.value}</Text>
          </View>
        ))}
      </View>
      {doc.summary.lines.map((line, i) => (
        <Text key={i} style={[styles.line, { color: colors.text }]}>
          {'•'} {line}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { width: '100%', borderWidth: 1, borderRadius: 6, padding: spacing.md, gap: spacing.sm },
  title: { fontSize: typography.md, fontWeight: '800' },
  meta: { fontSize: typography.xs },
  kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  kpi: { borderWidth: 1, borderRadius: 4, padding: spacing.sm, minWidth: 120 },
  kpiLabel: { fontSize: 10, fontWeight: '700' },
  kpiValue: { fontSize: typography.md, fontWeight: '800', marginTop: 2 },
  line: { fontSize: typography.sm, lineHeight: 20 },
});
