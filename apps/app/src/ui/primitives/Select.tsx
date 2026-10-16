import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Modal, ScrollView } from 'react-native';
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
  disabled?: boolean;
  /**
   * 'auto' (default) shows tappable chips for up to 4 options and a dropdown list beyond that,
   * so long lists (e.g. the 10 ranks) don't push the rest of the form off screen.
   */
  variant?: 'auto' | 'chips' | 'dropdown';
}

const MAX_CHIP_OPTIONS = 4;

export function Select<T = string>({
  label,
  options,
  selectedValue,
  onValueChange,
  value,
  onChange,
  error,
  disabled = false,
  variant = 'auto'
}: SelectProps<T>): React.ReactElement {
  const colors = useThemeStore((s) => s.colors);
  const [open, setOpen] = useState(false);
  const activeVal = value !== undefined ? value : selectedValue;
  const triggerChange = (val: T) => {
    if (disabled) return;
    if (onChange) onChange(val);
    if (onValueChange) onValueChange(val);
  };

  const asDropdown =
    variant === 'dropdown' || (variant === 'auto' && options.length > MAX_CHIP_OPTIONS);

  if (asDropdown) {
    const selected = options.find((o) => o.value === activeVal);
    return (
      <View style={[styles.container, disabled && styles.disabled]}>
        <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
        <Pressable
          onPress={() => !disabled && setOpen(true)}
          disabled={disabled}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${selected?.label ?? 'none selected'}. Tap to change`}
          style={[
            styles.dropdownTrigger,
            { backgroundColor: colors.surface, borderColor: error ? colors.red : colors.borderStrong }
          ]}
        >
          <Text
            numberOfLines={1}
            style={[styles.dropdownValue, { color: selected ? colors.text : colors.muted }]}
          >
            {selected?.label ?? 'Select…'}
          </Text>
          <Text style={[styles.chevron, { color: colors.muted }]}>▾</Text>
        </Pressable>
        {error ? <Text style={[styles.error, { color: colors.red }]}>{error}</Text> : null}

        <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
          <Pressable style={styles.overlay} onPress={() => setOpen(false)}>
            <Pressable
              onPress={() => undefined}
              style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}
            >
              <Text style={[styles.sheetTitle, { color: colors.navy }]}>{label}</Text>
              <ScrollView>
                {options.map((opt, idx) => {
                  const isSelected = opt.value === activeVal;
                  return (
                    <Pressable
                      key={idx}
                      onPress={() => {
                        triggerChange(opt.value);
                        setOpen(false);
                      }}
                      accessibilityRole="radio"
                      accessibilityLabel={opt.label}
                      accessibilityState={{ selected: isSelected }}
                      style={[
                        styles.sheetRow,
                        {
                          borderColor: colors.border,
                          backgroundColor: isSelected ? colors.navy : 'transparent'
                        }
                      ]}
                    >
                      <Text
                        style={[styles.optionText, { color: isSelected ? colors.onNavy : colors.text }]}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>
      </View>
    );
  }

  return (
    <View style={[styles.container, disabled && styles.disabled]}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <View style={styles.optionsRow}>
        {options.map((opt, idx) => {
          const isSelected = opt.value === activeVal;
          return (
            <Pressable
              key={idx}
              onPress={() => triggerChange(opt.value)}
              disabled={disabled}
              accessible={true}
              accessibilityRole="radio"
              accessibilityLabel={`${label}: ${opt.label}`}
              accessibilityState={{ selected: isSelected, disabled }}
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
                  { color: isSelected ? colors.onNavy : colors.text }
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
  disabled: {
    opacity: 0.5
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
  },
  dropdownTrigger: {
    minHeight: layout.minTouchTarget,
    paddingHorizontal: spacing.md,
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  dropdownValue: {
    flex: 1,
    fontSize: typography.sm,
    fontWeight: typography.weights.medium
  },
  chevron: {
    fontSize: typography.base
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.md
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '80%',
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    padding: spacing.md
  },
  sheetTitle: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
    marginBottom: spacing.sm
  },
  sheetRow: {
    minHeight: layout.minTouchTarget,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    borderBottomWidth: layout.borderWidth,
    borderRadius: layout.borderRadius
  }
});
