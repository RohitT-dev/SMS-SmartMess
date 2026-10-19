import React, { useState } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../../src/state/themeStore';
import { Screen } from '../../../src/ui/primitives/Screen';
import { Button } from '../../../src/ui/primitives/Button';
import { Banner } from '../../../src/ui/primitives/Banner';
import { EmptyState } from '../../../src/ui/primitives/EmptyState';
import { spacing, typography } from '../../../src/ui/tokens';
import { userErrorMessage } from '../../../src/lib/userError';
import { useReportPreviewStore } from '../../../src/features/reports/reportPreviewStore';
import { ReportFrame } from '../../../src/features/reports/ReportFrame';
import {
  exportReportDocument,
  type ReportAction,
} from '../../../src/features/reports/exportReport';

/**
 * Shows the report document itself (an isolated A4 render on web, a summary on native) with
 * Print / Save / Share. Nothing here prints the app page.
 */
export default function PdfPreviewScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const doc = useReportPreviewStore((s) => s.doc);
  const [busy, setBusy] = useState<ReportAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isWeb = Platform.OS === 'web';

  if (!doc) {
    return (
      <Screen title="Report Preview" showBack={true}>
        <EmptyState
          title="No report to preview"
          description="Open a report from Reports & Insights, the Guest Report or the Room Grid and choose its PDF button."
        />
        <View style={{ marginTop: spacing.md }}>
          <Button label="Back to reports" variant="secondary" onPress={() => router.replace('/(app)/reports' as any)} />
        </View>
      </Screen>
    );
  }

  const run = async (action: ReportAction) => {
    setBusy(action);
    setError(null);
    try {
      await exportReportDocument(doc, action);
    } catch (err) {
      setError(userErrorMessage(err, 'Could not export the report.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen title="Report Preview" showBack={true}>
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={{ flex: 1, minWidth: 220 }}>
            <Text style={[styles.title, { color: colors.navy }]}>{doc.title}</Text>
            <Text style={[styles.meta, { color: colors.muted }]}>
              {doc.pageCount} page{doc.pageCount === 1 ? '' : 's'} - A4 {doc.orientation} - {doc.fileName}.pdf
            </Text>
          </View>
          <View style={styles.actions}>
            {isWeb ? (
              <>
                <Button
                  label="Print / Save as PDF"
                  variant="primary"
                  loading={busy === 'save'}
                  disabled={busy !== null}
                  onPress={() => run('save')}
                />
                <Button
                  label="Open in new tab"
                  variant="secondary"
                  loading={busy === 'open'}
                  disabled={busy !== null}
                  onPress={() => run('open')}
                />
              </>
            ) : (
              <>
                <Button
                  label="Download / Share PDF"
                  variant="primary"
                  loading={busy === 'share'}
                  disabled={busy !== null}
                  onPress={() => run('share')}
                />
                <Button
                  label="Print"
                  variant="secondary"
                  loading={busy === 'print'}
                  disabled={busy !== null}
                  onPress={() => run('print')}
                />
              </>
            )}
          </View>
        </View>

        {isWeb && (
          <Text style={[styles.hint, { color: colors.muted }]}>
            Only this report is printed. In the print dialog choose "Save as PDF" as the destination to download a file.
          </Text>
        )}
        {error && <Banner type="error" message={error} />}

        <ReportFrame doc={doc} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', gap: spacing.md },
  header: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  title: { fontSize: typography.lg, fontWeight: '800' },
  meta: { fontSize: typography.xs, marginTop: 2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  hint: { fontSize: typography.xs },
});
