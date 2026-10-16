import React from 'react';
import { View, Text, StyleSheet, Pressable, StyleProp, ViewStyle } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';

export interface BannerProps {
  message: string;
  type?: 'info' | 'warning' | 'error' | 'offline' | 'success';
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}

export const Banner: React.FC<BannerProps> = ({
  message,
  type = 'info',
  actionLabel,
  onAction,
  style,
}) => {
  const colors = useThemeStore((s) => s.colors);

  const getColors = () => {
    switch (type) {
      case 'success':
        return { bg: colors.greenSoft, accent: colors.green };
      case 'warning':
        return { bg: colors.orangeSoft, accent: colors.orange };
      case 'error':
        return { bg: colors.redSoft, accent: colors.red };
      case 'offline':
        return { bg: colors.greySoft, accent: colors.grey };
      default:
        return { bg: colors.blueSoft, accent: colors.blue };
    }
  };

  const c = getColors();

  return (
    <View
      accessibilityRole={type === 'error' ? 'alert' : undefined}
      style={[styles.banner, { backgroundColor: c.bg, borderLeftColor: c.accent }, style]}
    >
      <Text style={[styles.message, { color: colors.text }]}>{message}</Text>
      {actionLabel && onAction ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          hitSlop={8}
          style={styles.action}
        >
          <Text style={[styles.actionText, { color: c.accent }]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  banner: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: layout.borderRadius,
    borderLeftWidth: 3,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  message: {
    fontSize: typography.sm,
    lineHeight: 20,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 220,
  },
  action: {
    minHeight: 28,
    justifyContent: 'center',
  },
  actionText: {
    fontSize: typography.sm,
    fontWeight: typography.weights.semibold,
    textDecorationLine: 'underline',
  },
});
