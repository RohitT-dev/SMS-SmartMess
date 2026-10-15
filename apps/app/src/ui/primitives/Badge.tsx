import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';

export interface BadgeProps {
  label: string;
  variant?: 'default' | 'success' | 'warning' | 'error' | 'saffron';
}

export const Badge: React.FC<BadgeProps> = ({ label, variant = 'default' }) => {
  const colors = useThemeStore((s) => s.colors);

  const getBadgeColors = () => {
    switch (variant) {
      case 'success':
        return { bg: colors.green + '20', text: colors.green, border: colors.green };
      case 'warning':
        return { bg: colors.orange + '20', text: colors.orange, border: colors.orange };
      case 'error':
        return { bg: colors.red + '20', text: colors.red, border: colors.red };
      case 'saffron':
        return { bg: colors.saffron + '20', text: colors.saffron, border: colors.saffron };
      default:
        return { bg: colors.surface, text: colors.text, border: colors.border };
    }
  };

  const c = getBadgeColors();

  return (
    <View style={[styles.badge, { backgroundColor: c.bg, borderColor: c.border }]}>
      <Text style={[styles.text, { color: c.text }]}>{label}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    alignSelf: 'flex-start',
    marginRight: spacing.xs
  },
  text: {
    fontSize: typography.xs,
    fontWeight: typography.weights.medium
  }
});
