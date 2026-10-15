import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';

interface TabItem {
  label: string;
  icon: string;
  path: string;
}

const TABS: TabItem[] = [
  { label: 'Rooms', icon: '🛏️', path: '/' },
  { label: 'Book', icon: '📝', path: '/bookings/new' },
  { label: 'Report', icon: '📊', path: '/reports' },
  { label: 'More', icon: '⚙️', path: '/settings' }
];

export const TabBar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const colors = useThemeStore((s) => s.colors);

  return (
    <View
      style={[
        styles.tabBar,
        {
          backgroundColor: colors.surface,
          borderTopColor: colors.border
        }
      ]}
    >
      {TABS.map((tab) => {
        const isActive =
          tab.path === '/'
            ? pathname === '/'
            : pathname.startsWith(tab.path);

        return (
          <Pressable
            key={tab.path}
            onPress={() => router.push(tab.path as any)}
            accessible={true}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={tab.label}
            style={styles.tabButton}
          >
            {/* Active tab saffron indicator */}
            {isActive ? (
              <View style={[styles.activeIndicator, { backgroundColor: colors.saffron }]} />
            ) : null}
            <Text style={{ fontSize: 18 }}>{tab.icon}</Text>
            <Text
              style={[
                styles.tabLabel,
                {
                  color: isActive ? colors.navy : colors.muted,
                  fontWeight: isActive ? typography.weights.bold : typography.weights.medium
                }
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
    height: 60,
    borderTopWidth: layout.borderWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    position: 'relative'
  },
  tabButton: {
    flex: 1,
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: layout.minTouchTarget
  },
  activeIndicator: {
    position: 'absolute',
    top: 0,
    left: '20%',
    right: '20%',
    height: 3,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2
  },
  tabLabel: {
    fontSize: typography.xs,
    marginTop: 2
  }
});
