import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing } from '../tokens';

export interface CardProps {
  children: React.ReactNode;
  style?: ViewStyle;
}

export const Card: React.FC<CardProps> = ({ children, style }) => {
  const colors = useThemeStore((s) => s.colors);

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border
        },
        style
      ]}
    >
      {children}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    padding: spacing.lg,
    marginBottom: spacing.md
  }
});
