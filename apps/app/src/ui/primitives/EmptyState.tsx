import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { spacing, typography } from '../tokens';
import { Button } from './Button';

export interface EmptyStateProps {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  actionLabel,
  onAction
}) => {
  const colors = useThemeStore((s) => s.colors);

  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.description, { color: colors.muted }]}>{description}</Text>
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} style={styles.button} />
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: spacing.xxl,
    alignItems: 'center',
    justifyContent: 'center'
  },
  title: {
    fontSize: typography.lg,
    fontWeight: typography.weights.bold,
    marginBottom: spacing.xs,
    textAlign: 'center'
  },
  description: {
    fontSize: typography.sm,
    textAlign: 'center',
    marginBottom: spacing.lg,
    maxWidth: 360
  },
  button: {
    marginTop: spacing.sm
  }
});
