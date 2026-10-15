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
  style
}) => {
  const colors = useThemeStore((s) => s.colors);

  const getColors = () => {
    switch (type) {
      case 'success':
        return { bg: colors.green + '15', border: colors.green, text: colors.green };
      case 'warning':
        return { bg: colors.orange + '15', border: colors.orange, text: colors.orange };
      case 'error':
        return { bg: colors.red + '15', border: colors.red, text: colors.red };
      case 'offline':
        return { bg: colors.grey + '15', border: colors.grey, text: colors.text };
      default:
        return { bg: colors.blue + '15', border: colors.blue, text: colors.blue };
    }
  };

  const c = getColors();

  return (
    <View style={[styles.banner, { backgroundColor: c.bg, borderColor: c.border }, style]}>
      <Text style={[styles.message, { color: c.text }]}>{message}</Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} style={styles.action}>
          <Text style={[styles.actionText, { color: c.text }]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  banner: {
    padding: spacing.md,
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md
  },
  message: {
    fontSize: typography.sm,
    fontWeight: typography.weights.medium,
    flex: 1
  },
  action: {
    marginLeft: spacing.md
  },
  actionText: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
    textDecorationLine: 'underline'
  }
});
