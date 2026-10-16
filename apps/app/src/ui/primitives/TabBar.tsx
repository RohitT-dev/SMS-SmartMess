import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeStore } from '../../state/themeStore';
import { layout, typography } from '../tokens';
import { NAV_ITEMS, isNavActive } from '../navigation';
import { Icon, IconName } from './Icon';

interface TabItem {
  label: string;
  icon: IconName;
  path: string;
}

const TABS: TabItem[] = [
  { label: 'Rooms', icon: 'bed', path: '/' },
  { label: 'Book', icon: 'plus', path: '/bookings/new' },
  { label: 'Ledger', icon: 'ledger', path: '/bookings' },
  { label: 'Reports', icon: 'chart', path: '/reports' },
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
            <Icon
              name={tab.icon}
              size={22}
              color={isActive ? colors.navy : colors.muted}
              strokeWidth={isActive ? 2 : 1.75}
            />
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
});
