import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';

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
}

export function Table<T>({
  columns,
  data,
  keyExtractor,
  emptyText = 'No records found'
}: TableProps<T>) {
  const colors = useThemeStore((s) => s.colors);

  return (
    <View style={[styles.container, { borderColor: colors.border }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.tableInner}>
          {/* Header Row */}
          <View style={[styles.headerRow, { backgroundColor: colors.bg, borderBottomColor: colors.border }]}>
            {columns.map((col) => (
              <View
                key={col.key}
                style={[
                  styles.headerCell,
                  col.width ? { width: col.width as any } : { flex: col.flex || 1 }
                ]}
              >
                <Text
                  style={[
                    styles.headerText,
                    {
                      color: colors.navy,
                      textAlign: col.align || 'left'
                    }
                  ]}
                >
                  {col.header}
                </Text>
              </View>
            ))}
          </View>

          {/* Rows */}
          {data.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyText, { color: colors.muted }]}>{emptyText}</Text>
            </View>
          ) : (
            data.map((item, rowIndex) => (
              <View
                key={keyExtractor(item, rowIndex)}
                style={[
                  styles.row,
                  {
                    backgroundColor: rowIndex % 2 === 1 ? colors.bg : colors.surface,
                    borderBottomColor: colors.border
                  }
                ]}
              >
                {columns.map((col) => (
                  <View
                    key={col.key}
                    style={[
                      styles.cell,
                      col.width ? { width: col.width as any } : { flex: col.flex || 1 }
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
                            textAlign: col.align || 'left'
                          }
                        ]}
                      >
                        {String((item as any)[col.key] ?? '')}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: layout.borderWidth,
    borderRadius: layout.borderRadius,
    overflow: 'hidden'
  },
  tableInner: {
    minWidth: '100%'
  },
  headerRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md
  },
  headerCell: {
    paddingHorizontal: spacing.xs,
    justifyContent: 'center'
  },
  headerText: {
    fontSize: typography.xs,
    fontWeight: typography.weights.bold,
    textTransform: 'uppercase'
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: 'center'
  },
  cell: {
    paddingHorizontal: spacing.xs,
    justifyContent: 'center'
  },
  cellText: {
    fontSize: typography.sm
  },
  emptyContainer: {
    padding: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyText: {
    fontSize: typography.sm
  }
});
