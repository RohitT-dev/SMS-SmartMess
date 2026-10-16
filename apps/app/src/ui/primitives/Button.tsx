import React from 'react';
import {
  Pressable,
  PressableStateCallbackType,
  Text,
  StyleSheet,
  ActivityIndicator,
  ViewStyle,
  StyleProp,
} from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'destructive';
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/** react-native-web adds hover/focus to the Pressable state; native only has `pressed`. */
export type InteractionState = PressableStateCallbackType & { hovered?: boolean; focused?: boolean };

export const Button: React.FC<ButtonProps> = ({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  accessibilityLabel,
  style,
}) => {
  const colors = useThemeStore((s) => s.colors);
  const inactive = disabled || loading;

  const getBackgroundColor = (active: boolean): string => {
    if (disabled) return colors.greySoft;
    if (variant === 'primary') return active ? colors.bluePressed : colors.blue;
    if (variant === 'destructive') return active ? colors.redPressed : colors.red;
    return active ? colors.surfaceAlt : colors.surface;
  };

  const textColor = disabled
    ? colors.muted
    : variant === 'secondary'
      ? colors.navy
      : colors.onAction;

  const borderColor =
    variant === 'secondary' ? colors.borderStrong : disabled ? colors.border : 'transparent';

  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessible={true}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      style={(state) => {
        const { pressed, hovered, focused } = state as InteractionState;
        return [
          styles.button,
          {
            backgroundColor: getBackgroundColor(!inactive && (pressed || !!hovered)),
            borderColor,
          },
          focused ? { outlineColor: colors.focus, outlineWidth: 2, outlineStyle: 'solid', outlineOffset: 2 } as ViewStyle : null,
          style,
        ];
      }}
    >
      {loading ? (
        <ActivityIndicator color={textColor} size="small" />
      ) : (
        <Text style={[styles.text, { color: textColor }]}>{label}</Text>
      )}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  button: {
    minHeight: layout.minTouchTarget,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
  },
  text: {
    fontSize: typography.base,
    fontWeight: typography.weights.semibold,
  },
});
