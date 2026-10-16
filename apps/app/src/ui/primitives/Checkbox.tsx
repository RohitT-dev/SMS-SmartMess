import React from 'react';
import { Pressable, View, Text, StyleSheet } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';

export interface CheckboxProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export const Checkbox: React.FC<CheckboxProps> = ({ label, hint, checked, onChange, disabled = false }) => {
  const colors = useThemeStore((s) => s.colors);
  return (
    <Pressable
      onPress={() => !disabled && onChange(!checked)}
      disabled={disabled}
      accessible={true}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      style={[styles.row, disabled && { opacity: 0.5 }]}
    >
      <View
        style={[
          styles.box,
          {
            borderColor: checked ? colors.navy : colors.borderStrong,
            backgroundColor: checked ? colors.navy : colors.surface,
          },
        ]}
      >
        {checked ? <Text style={[styles.tick, { color: colors.onNavy }]}>✓</Text> : null}
      </View>
      <View style={styles.text}>
        <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
        {hint ? <Text style={[styles.hint, { color: colors.muted }]}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    minHeight: layout.minTouchTarget,
    paddingVertical: spacing.xs,
  },
  box: {
    width: 24,
    height: 24,
    borderRadius: layout.borderRadius,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  tick: { fontSize: typography.sm, fontWeight: typography.weights.bold },
  text: { flex: 1 },
  label: { fontSize: typography.sm, fontWeight: typography.weights.medium },
  hint: { fontSize: typography.xs, marginTop: 2 },
});
