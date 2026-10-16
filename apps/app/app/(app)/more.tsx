import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../src/state/themeStore';
import { useSessionStore } from '../../src/state/sessionStore';
import { Screen } from '../../src/ui/primitives/Screen';
import { Card } from '../../src/ui/primitives/Card';
import { Button } from '../../src/ui/primitives/Button';
import { layout, spacing, typography } from '../../src/ui/tokens';
import { NAV_ITEMS, canSeeNavItem } from '../../src/ui/navigation';
import { signOut } from '../../src/features/auth/authFlow';
import { Icon } from '../../src/ui/primitives/Icon';

// Destinations already reachable from the phone tab bar.
const TAB_DESTINATIONS = new Set(['/', '/bookings/new', '/bookings', '/reports']);

/** Phone navigation hub: every screen that does not fit in the bottom tab bar. */
export default function MoreScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const userRole = useSessionStore((s) => s.userRole);
  const userPermissions = useSessionStore((s) => s.userPermissions);

  const items = NAV_ITEMS.filter(
    (item) => !TAB_DESTINATIONS.has(item.path) && canSeeNavItem(item, userRole, userPermissions),
  );

  const handleSignOut = async () => {
    await signOut();
    router.replace('/(auth)/sign-in');
  };

  return (
    <Screen title="More">
      <Card style={styles.card}>
        {items.map((item, index) => (
          <Pressable
            key={item.path}
            onPress={() => router.push(item.path as any)}
            accessibilityRole="link"
            accessibilityLabel={item.label}
            style={({ pressed }) => [
              styles.row,
              {
                borderBottomColor: colors.border,
                borderBottomWidth: index === items.length - 1 ? 0 : layout.borderWidth,
                backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
              },
            ]}
          >
            <View style={[styles.icon, { backgroundColor: colors.greySoft }]}>
              <Icon name={item.icon} size={18} color={colors.navy} />
            </View>
            <View style={styles.rowText}>
              <Text style={[styles.label, { color: colors.text }]}>{item.label}</Text>
              {item.description ? (
                <Text style={[styles.description, { color: colors.muted }]} numberOfLines={1}>
                  {item.description}
                </Text>
              ) : null}
            </View>
            <Icon name="chevron" size={18} color={colors.muted} />
          </Pressable>
        ))}
      </Card>

      <Button
        label="Sign out"
        variant="destructive"
        onPress={handleSignOut}
        style={{ marginTop: spacing.lg }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 0,
    overflow: 'hidden',
  },
  row: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    gap: spacing.md,
  },
  icon: {
    width: 34,
    height: 34,
    borderRadius: layout.borderRadius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
    paddingVertical: spacing.sm,
  },
  label: {
    fontSize: typography.base,
    fontWeight: typography.weights.medium,
  },
  description: {
    fontSize: typography.xs,
    marginTop: 2,
  },
});
