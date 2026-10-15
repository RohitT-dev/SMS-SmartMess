import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';

export interface SelectOption<T = string> {
  label: string;
  value: T;
}

export interface SelectProps<T = string> {
  label: string;
  options: SelectOption<T>[];
  selectedValue?: T;
  onValueChange?: (value: T) => void;
  value?: T;
  onChange?: (value: T) => void;
  error?: string;
}

export function Select<T = string>({
  label,
  options,
  selectedValue,
  onValueChange,
  value,
  onChange,
  error
}: SelectProps<T>): React.ReactElement {
  const colors = useThemeStore((s) => s.colors);
  const activeVal = value !== undefined ? value : selectedValue;
  const triggerChange = (val: T) => {
    if (onChange) onChange(val);
    if (onValueChange) onValueChange(val);
  };

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <View style={styles.optionsRow}>
        {options.map((opt, idx) => {
          const isSelected = opt.value === activeVal;
          return (
            <Pressable
              key={idx}
              onPress={() => triggerChange(opt.value)}
              accessible={true}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected }}
              style={[
                styles.optionButton,
                {
                  backgroundColor: isSelected ? colors.navy : colors.surface,
                  borderColor: isSelected ? colors.navy : colors.border
                }
              ]}
            >
              <Text
                style={[
                  styles.optionText,
                  { color: isSelected ? '#FFFFFF' : colors.text }
                ]}
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error ? <Text style={[styles.error, { color: colors.red }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md
  },
  label: {
    fontSize: typography.sm,
    fontWeight: typography.weights.medium,
    marginBottom: spacing.xs
  },
  optionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm
  },
  optionButton: {
    minHeight: layout.minTouchTarget,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    justifyContent: 'center',
    alignItems: 'center'
  },
  optionText: {
    fontSize: typography.sm,
    fontWeight: typography.weights.medium
  },
  error: {
    fontSize: typography.xs,
    marginTop: spacing.xs
  }
});
