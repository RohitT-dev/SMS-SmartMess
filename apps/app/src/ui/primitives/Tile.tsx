import React from 'react';
import { Pressable, View, Text, StyleSheet } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';
import type { RoomAvailabilityStatus } from '@sms/core';

export interface TileProps {
  roomName: string;
  roomType: string;
  status: RoomAvailabilityStatus;
  occupantSummary?: string;
  onPress: () => void;
}

export const Tile: React.FC<TileProps> = ({
  roomName,
  roomType,
  status,
  occupantSummary,
  onPress
}) => {
  const colors = useThemeStore((s) => s.colors);

  const getStatusColor = (): string => {
    switch (status) {
      case 'free':
        return colors.green;
      case 'one_bed_free':
        return colors.blue;
      case 'full':
        return colors.orange;
      case 'out_of_service':
        return colors.grey;
      default:
        return colors.border;
    }
  };

  const getStatusLabel = (): string => {
    switch (status) {
      case 'free':
        return 'Free';
      case 'one_bed_free':
        return '1 bed free';
      case 'full':
        return 'Full';
      case 'out_of_service':
        return 'Out of service';
    }
  };

  const statusColor = getStatusColor();
  const statusLabel = getStatusLabel();
  const a11yLabel = `${roomName}, ${statusLabel}${occupantSummary ? `, ${occupantSummary}` : ''}`;

  return (
    <Pressable
      onPress={onPress}
      accessible={true}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      style={({ pressed }) => [
        styles.tile,
        {
          backgroundColor: pressed ? colors.bg : colors.surface,
          borderColor: colors.border
        }
      ]}
    >
      {/* 4px left edge in status colour */}
      <View style={[styles.statusStrip, { backgroundColor: statusColor }]} />

      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={[styles.roomName, { color: colors.text }]}>{roomName}</Text>
          <Text style={[styles.roomType, { color: colors.muted }]}>{roomType}</Text>
        </View>

        <View style={styles.footer}>
          {/* Status is NEVER colour alone: explicitly renders text label */}
          <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
          {occupantSummary ? (
            <Text style={[styles.occupantText, { color: colors.muted }]}>
              {occupantSummary}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  tile: {
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    flexDirection: 'row',
    overflow: 'hidden',
    minHeight: 72,
    marginBottom: spacing.sm,
    flex: 1,
    minWidth: 160
  },
  statusStrip: {
    width: 4
  },
  content: {
    padding: spacing.md,
    flex: 1,
    justifyContent: 'space-between'
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  roomName: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold
  },
  roomType: {
    fontSize: typography.xs,
    fontWeight: typography.weights.medium
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.xs
  },
  statusText: {
    fontSize: typography.sm,
    fontWeight: typography.weights.medium
  },
  occupantText: {
    fontSize: typography.xs
  }
});
