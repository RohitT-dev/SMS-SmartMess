import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeStore } from '../../state/themeStore';
import { layout, typography } from '../tokens';
import { NAV_ITEMS, isNavActive } from '../navigation';
import { Icon, IconName } from './Icon';

import { useQuery } from '@tanstack/react-query';
import { fetchPendingAllotment } from '../../features/bookings/pendingRequests';

interface TabItem {
  label: string;
  icon: IconName;
  path: string;
}

const TABS: TabItem[] = [
  { label: 'Rooms', icon: 'bed', path: '/' },
  { label: 'New', icon: 'plus', path: '/bookings/new' },
  { label: 'Requests', icon: 'clipboard', path: '/requests' },
  { label: 'Ledger', icon: 'ledger', path: '/bookings' },
  { label: 'More', icon: 'menu', path: '/more' },
];

const TAB_PATHS = TABS.filter((t) => t.path !== '/more').map((t) => t.path);
// Every other destination (admin pages, settings, suites) lives under "More".
const MORE_PATHS = ['/more', ...NAV_ITEMS.map((n) => n.path).filter((p) => !TAB_PATHS.includes(p))];

export const TabBar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const colors = useThemeStore((s) => s.colors);

  // Live count of pending requests for the badge
  const { data: pendingCount } = useQuery({
    queryKey: ['tabbar_pending_requests_count'],
    queryFn: async () => {
      try {
        const pending = await fetchPendingAllotment<{ id: string; status: string; allocations: Array<{ status: string }> }>(
          'id, status',
        );
        return pending.length;
      } catch {
        return 0;
      }
    },
    refetchInterval: 5000,
  });

  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.tabBar,
        {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          paddingBottom: insets.bottom,
          height: 60 + insets.bottom,
        },
      ]}
    >
      {TABS.map((tab) => {
        const isActive =
          tab.path === '/more'
            ? MORE_PATHS.some((p) => isNavActive(p, pathname))
            : isNavActive(tab.path, pathname);

        return (
          <Pressable
            key={tab.path}
            onPress={() => {
              if (!isActive) router.navigate(tab.path as any);
            }}
            accessible={true}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={tab.label}
            style={({ pressed }) => [styles.tabButton, pressed && { opacity: 0.6 }]}
          >
            {isActive ? (
              <View style={[styles.activeIndicator, { backgroundColor: colors.saffron }]} />
            ) : null}
            <View style={{ position: 'relative' }}>
              <Icon
                name={tab.icon}
                size={22}
                color={isActive ? colors.navy : colors.muted}
                strokeWidth={isActive ? 2 : 1.75}
              />
              {tab.path === '/requests' && (pendingCount ?? 0) > 0 ? (
                <View style={[styles.badgeContainer, { backgroundColor: colors.saffron }]}>
                  <Text style={styles.badgeText}>
                    {(pendingCount ?? 0) > 99 ? '99+' : pendingCount}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              numberOfLines={1}
              style={[
                styles.tabLabel,
                {
                  color: isActive ? colors.navy : colors.muted,
                  fontWeight: isActive ? typography.weights.semibold : typography.weights.regular,
                },
              ]}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  tabBar: {
    borderTopWidth: layout.borderWidth,
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'space-around',
  },
  tabButton: {
    flex: 1,
    height: 60,
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: layout.minTouchTarget,
  },
  activeIndicator: {
    position: 'absolute',
    top: 0,
    left: '20%',
    right: '20%',
    height: 3,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
  },
  tabLabel: {
    fontSize: 11,
    marginTop: 3,
  },
  badgeContainer: {
    position: 'absolute',
    top: -4,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: 'bold',
  },
});
