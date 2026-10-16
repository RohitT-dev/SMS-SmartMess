import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';
import { Skeleton } from './Skeleton';

export interface TableColumn<T> {
  key: string;
  header: string;
  width?: number | `${number}%`;
  flex?: number;
  align?: 'left' | 'center' | 'right';
  render?: (item: T, index: number) => React.ReactNode;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  emptyText?: string;
  onRowPress?: (item: T) => void;
  loading?: boolean;
}

export function Table<T>({
  columns,
  data,
  keyExtractor,
  emptyText = 'No records found',
  onRowPress,
  loading = false,
}: TableProps<T>) {
  const colors = useThemeStore((s) => s.colors);

  // Flex columns collapse to nothing inside a horizontal ScrollView on narrow
  // phones; give each a floor so the table scrolls sideways instead of squashing.
  const minTableWidth = columns.reduce(
    (sum, col) => sum + (typeof col.width === 'number' ? col.width : MIN_FLEX_COLUMN_WIDTH),
    spacing.md * 2,
  );

  return (
    <View style={[styles.container, { borderColor: colors.border }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={true}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={[styles.tableInner, { minWidth: minTableWidth }]}>
          {/* Header Row */}
          <View
            style={[
              styles.headerRow,
              { backgroundColor: colors.bg, borderBottomColor: colors.border },
            ]}
          >
            {columns.map((col) => (
              <View
                key={col.key}
                style={[
                  styles.headerCell,
                  col.width
                    ? { width: col.width as any }
                    : { flex: col.flex || 1, minWidth: MIN_FLEX_COLUMN_WIDTH },
                ]}
              >
                <Text
                  style={[
                    styles.headerText,
                    {
                      color: colors.navy,
                      textAlign: col.align || 'left',
                    },
                  ]}
                >
                  {col.header}
                </Text>
              </View>
            ))}
          </View>

          {/* Rows */}
          {loading
            ? null
            : data.map((item, rowIndex) => (
            <Pressable
              key={keyExtractor(item, rowIndex)}
              disabled={!onRowPress}
              onPress={onRowPress ? () => onRowPress(item) : undefined}
              accessibilityRole={onRowPress ? 'button' : undefined}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor:
                    pressed && onRowPress
                      ? colors.border
                      : rowIndex % 2 === 1
                        ? colors.bg
                        : colors.surface,
                  borderBottomColor: colors.border,
                },
              ]}
            >
              {columns.map((col) => (
                <View
                  key={col.key}
                  style={[
                    styles.cell,
                    col.width
                      ? { width: col.width as any }
                      : { flex: col.flex || 1, minWidth: MIN_FLEX_COLUMN_WIDTH },
                  ]}
                >
                  {col.render ? (
                    col.render(item, rowIndex)
                  ) : (
                    <Text
                      style={[
                        styles.cellText,
                        {
                          color: colors.text,
                          textAlign: col.align || 'left',
                        },
                      ]}
                    >
                      {String((item as any)[col.key] ?? '')}
                    </Text>
                  )}
                </View>
              ))}
            </Pressable>
          ))}

          {loading &&
            Array.from({ length: 4 }).map((_, i) => (
              <View
                key={i}
                style={[styles.row, { borderBottomColor: colors.border }]}
              >
                <Skeleton height={16} />
              </View>
            ))}
        </View>
      </ScrollView>
      {/* Outside the horizontal scroller so it stays centered on narrow screens. */}
      {!loading && data.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyText, { color: colors.muted }]}>{emptyText}</Text>
        </View>
      ) : null}
    </View>
  );
}

const MIN_FLEX_COLUMN_WIDTH = 140;

const styles = StyleSheet.create({
  scrollContent: {
    flexGrow: 1,
  },
  container: {
    borderWidth: layout.borderWidth,
    borderRadius: layout.borderRadius,
    overflow: 'hidden',
  },
  tableInner: {
    flexGrow: 1,
  },
  headerRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  headerCell: {
    paddingHorizontal: spacing.xs,
    justifyContent: 'center',
  },
  headerText: {
    fontSize: typography.xs,
    fontWeight: typography.weights.semibold,
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    minHeight: layout.minTouchTarget,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  cell: {
    paddingHorizontal: spacing.xs,
    justifyContent: 'center',
  },
  cellText: {
    fontSize: typography.sm,
  },
  emptyContainer: {
    padding: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    fontSize: typography.sm,
  },
});
