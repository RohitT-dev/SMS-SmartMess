import React from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';

export interface DateRangeProps {
  label?: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  onStartDateChange?: (date: string) => void;
  onEndDateChange?: (date: string) => void;
  disabled?: boolean;
  error?: string;
}

export const DateRange: React.FC<DateRangeProps> = ({
  label,
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  disabled = false,
  error
}) => {
  const colors = useThemeStore((s) => s.colors);

  return (
    <View style={styles.container}>
      {label && <Text style={[styles.label, { color: colors.navy }]}>{label}</Text>}
      <View style={styles.inputsRow}>
        <View style={styles.inputWrapper}>
          <Text style={[styles.subLabel, { color: colors.muted }]}>Check-In</Text>
          <TextInput
            value={startDate}
            onChangeText={onStartDateChange}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.muted}
            editable={!disabled && !!onStartDateChange}
            accessibilityLabel="Check-in date YYYY-MM-DD"
            style={[
              styles.input,
              {
                backgroundColor: disabled ? colors.bg : colors.surface,
                borderColor: error ? colors.red : colors.border,
                color: colors.text
              }
            ]}
          />
        </View>

        <Text style={[styles.toSeparator, { color: colors.muted }]}>to</Text>

        <View style={styles.inputWrapper}>
          <Text style={[styles.subLabel, { color: colors.muted }]}>Check-Out</Text>
          <TextInput
            value={endDate}
            onChangeText={onEndDateChange}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.muted}
            editable={!disabled && !!onEndDateChange}
            accessibilityLabel="Check-out date YYYY-MM-DD"
            style={[
              styles.input,
              {
                backgroundColor: disabled ? colors.bg : colors.surface,
                borderColor: error ? colors.red : colors.border,
                color: colors.text
              }
            ]}
          />
        </View>
      </View>
      {error && <Text style={[styles.error, { color: colors.red }]}>{error}</Text>}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md
  },
  label: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
    marginBottom: spacing.xs
  },
  inputsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  inputWrapper: {
    flex: 1
  },
  subLabel: {
    fontSize: typography.xs,
    marginBottom: 2
  },
  toSeparator: {
    fontSize: typography.sm,
    fontWeight: typography.weights.medium,
    marginTop: 14
  },
  input: {
    height: layout.minTouchTarget,
    borderWidth: layout.borderWidth,
    borderRadius: layout.borderRadius,
    paddingHorizontal: spacing.sm,
    fontSize: typography.sm
  },
  error: {
    fontSize: typography.xs,
    marginTop: spacing.xs
  }
});
