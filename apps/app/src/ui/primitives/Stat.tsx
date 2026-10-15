import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';

export interface StatProps {
  label: string;
  value: string | number;
  indicatorColor?: string;
}

export const Stat: React.FC<StatProps> = ({ label, value, indicatorColor }) => {
  const colors = useThemeStore((s) => s.colors);

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border
        }
      ]}
    >
      <View style={styles.header}>
        {indicatorColor ? (
          <View style={[styles.indicator, { backgroundColor: indicatorColor }]} />
        ) : null}
        <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
      </View>
      <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: spacing.md,
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    flex: 1,
    minWidth: 120
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs
  },
  indicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.xs
  },
  label: {
    fontSize: typography.xs,
    fontWeight: typography.weights.medium,
    textTransform: 'uppercase'
  },
  value: {
    fontSize: typography.xl,
    fontWeight: typography.weights.bold
  }
});
