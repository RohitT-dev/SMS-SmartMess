import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, TextInputProps, Platform } from 'react-native';
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
  onFocus,
  onBlur,
  ...props
}) => {
  const colors = useThemeStore((s) => s.colors);
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        style={[
          styles.input,
          {
            backgroundColor: colors.surface,
            borderColor: error ? colors.red : focused ? colors.focus : colors.borderStrong,
            borderWidth: focused ? 2 : layout.borderWidth,
            paddingHorizontal: focused ? spacing.md - 1 : spacing.md,
            color: colors.text
          },
          style
        ]}
        accessibilityLabel={label}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
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
    fontSize: typography.base,
    // The 2px focus border replaces the browser's default focus outline.
    ...(Platform.OS === 'web' ? ({ outlineWidth: 0 } as object) : {})
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
