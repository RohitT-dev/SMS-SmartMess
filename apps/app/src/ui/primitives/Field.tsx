import React from 'react';
import { View, Text, TextInput, StyleSheet, TextInputProps } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';

export interface FieldProps extends TextInputProps {
  label: string;
  error?: string;
  hint?: string;
}

export const Field: React.FC<FieldProps> = ({
  label,
  error,
  hint,
  style,
  ...props
}) => {
  const colors = useThemeStore((s) => s.colors);

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        style={[
          styles.input,
          {
            backgroundColor: colors.surface,
            borderColor: error ? colors.red : colors.border,
            color: colors.text
          },
          style
        ]}
        accessibilityLabel={label}
        {...props}
      />
      {error ? (
        <Text style={[styles.error, { color: colors.red }]}>{error}</Text>
      ) : hint ? (
        <Text style={[styles.hint, { color: colors.muted }]}>{hint}</Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md
  },
  label: {
    fontSize: typography.sm,
    fontWeight: typography.weights.medium,
    marginBottom: spacing.xs
  },
  input: {
    minHeight: layout.minTouchTarget,
    borderWidth: layout.borderWidth,
    borderRadius: layout.borderRadius,
    paddingHorizontal: spacing.md,
    fontSize: typography.base
  },
  error: {
    fontSize: typography.xs,
    marginTop: spacing.xs
  },
  hint: {
    fontSize: typography.xs,
    marginTop: spacing.xs
  }
});
