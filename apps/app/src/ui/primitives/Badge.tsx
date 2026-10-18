import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';

export interface BadgeProps {
  label: string;
  variant?: 'default' | 'success' | 'warning' | 'error' | 'saffron' | 'navy' | 'neutral' | 'green';
}

export const Badge: React.FC<BadgeProps> = ({ label, variant = 'default' }) => {
  const colors = useThemeStore((s) => s.colors);

  const getBadgeColors = () => {
    switch (variant) {
      case 'success':
      case 'green':
        return { bg: colors.greenSoft, text: colors.green };
      case 'warning':
        return { bg: colors.orangeSoft, text: colors.orange };
      case 'error':
        return { bg: colors.redSoft, text: colors.red };
      case 'saffron':
        return { bg: colors.saffronSoft, text: colors.saffronInk };
      case 'navy':
        return { bg: `${colors.navy}18`, text: colors.navy };
      case 'neutral':
      default:
        return { bg: colors.greySoft, text: colors.text };
    }
  };

  const c = getBadgeColors();

  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={[styles.text, { color: c.text }]}>{label}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: layout.borderRadius,
    alignSelf: 'flex-start',
    marginRight: spacing.xs,
  },
  text: {
    fontSize: typography.xs,
    fontWeight: typography.weights.semibold,
  },
});
