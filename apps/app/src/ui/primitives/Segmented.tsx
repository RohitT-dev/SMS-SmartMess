import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';

export interface SegmentOption<T extends string = string> {
  label: string;
  value: T;
  count?: number;
}

export interface SegmentedProps<T extends string = string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel?: string;
}

export function Segmented<T extends string = string>({
  options,
  value,
  onChange,
  accessibilityLabel
}: SegmentedProps<T>) {
  const colors = useThemeStore((s) => s.colors);

  return (
    <View
      style={[styles.container, { backgroundColor: colors.bg, borderColor: colors.border }]}
      accessibilityRole="tablist"
      aria-label={accessibilityLabel}
    >
      {options.map((opt) => {
        const isSelected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            accessible={true}
            accessibilityRole="tab"
            accessibilityState={{ selected: isSelected }}
            accessibilityLabel={`${opt.label}${opt.count !== undefined ? `, ${opt.count}` : ''}`}
            style={[
              styles.item,
              {
                backgroundColor: isSelected ? colors.surface : 'transparent',
                borderColor: isSelected ? colors.border : 'transparent'
              }
            ]}
          >
            <Text
              style={[
                styles.label,
                {
                  color: isSelected ? colors.navy : colors.muted,
                  fontWeight: isSelected ? typography.weights.bold : typography.weights.medium
                }
              ]}
            >
              {opt.label}
            </Text>
            {opt.count !== undefined && (
              <View
                style={[
                  styles.badge,
                  {
                    backgroundColor: isSelected ? colors.navy : colors.border
                  }
                ]}
              >
                <Text
                  style={[
                    styles.badgeText,
                    {
                      color: isSelected ? colors.onNavy : colors.text
                    }
                  ]}
                >
                  {opt.count}
                </Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    padding: 2,
    alignItems: 'center'
  },
  item: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: layout.minTouchTarget - 8,
    paddingHorizontal: spacing.sm,
    borderRadius: layout.borderRadius,
    borderWidth: 1,
    gap: spacing.xs
  },
  label: {
    fontSize: typography.sm
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10
  },
  badgeText: {
    fontSize: typography.xs,
    fontWeight: typography.weights.bold
  }
});
