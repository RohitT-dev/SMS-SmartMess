import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useThemeStore } from '../../state/themeStore';
import { useSessionStore } from '../../state/sessionStore';
import { layout, spacing, typography } from '../tokens';

interface NavItem {
  label: string;
  path: string;
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Room Inventory', path: '/' },
  { label: 'New Booking', path: '/bookings/new' },
  { label: 'Bookings & Ledger', path: '/bookings' },
  { label: 'Reports & Insights', path: '/reports' },
  { label: 'VVIP Suites', path: '/suites', adminOnly: true },
  { label: 'User Directory', path: '/admin/users', adminOnly: true },
  { label: 'Rooms & Data', path: '/admin/data', adminOnly: true },
  { label: 'Audit Trail', path: '/admin/audit', adminOnly: true },
  { label: 'Key Management', path: '/admin/keys', adminOnly: true },
  { label: 'Settings', path: '/settings' }
];

export const Sidebar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const colors = useThemeStore((s) => s.colors);
  const userRole = useSessionStore((s) => s.userRole);

  const filteredItems = NAV_ITEMS.filter((item) => !item.adminOnly || userRole === 'admin');

  return (
    <View
      style={[
        styles.sidebar,
        {
          backgroundColor: colors.surface,
          borderRightColor: colors.border
        }
      ]}
    >
      <View style={styles.brand}>
        <Text style={[styles.brandTitle, { color: colors.navy }]}>Smart Mess System</Text>
        <Text style={[styles.brandSubtitle, { color: colors.muted }]}>Room Inventory v1.0</Text>
      </View>

      <View style={styles.nav}>
        {filteredItems.map((item) => {
          const isActive =
            item.path === '/'
              ? pathname === '/'
              : pathname.startsWith(item.path);

          return (
            <Pressable
              key={item.path}
              onPress={() => router.push(item.path as any)}
              accessible={true}
              accessibilityRole="link"
              accessibilityState={{ selected: isActive }}
              style={({ pressed }) => [
                styles.navItem,
                {
                  backgroundColor: isActive
                    ? colors.navy
                    : pressed
                    ? colors.bg
                    : 'transparent'
                }
              ]}
            >
              <Text
                style={[
                  styles.navText,
                  {
                    color: isActive ? '#FFFFFF' : colors.text,
                    fontWeight: isActive ? typography.weights.bold : typography.weights.medium
                  }
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  sidebar: {
    width: layout.sidebarWidth,
    borderRightWidth: layout.borderWidth,
    height: '100%',
    padding: spacing.md
  },
  brand: {
    paddingVertical: spacing.md,
    borderBottomWidth: layout.borderWidth,
    borderBottomColor: '#DDE2E8',
    marginBottom: spacing.md
  },
  brandTitle: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold
  },
  brandSubtitle: {
    fontSize: typography.xs,
    marginTop: 2
  },
  nav: {
    gap: spacing.xs
  },
  navItem: {
    minHeight: layout.minTouchTarget,
    paddingHorizontal: spacing.md,
    borderRadius: layout.borderRadius,
    justifyContent: 'center'
  },
  navText: {
    fontSize: typography.sm
  }
});
