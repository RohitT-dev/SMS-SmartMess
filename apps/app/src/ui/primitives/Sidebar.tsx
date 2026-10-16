import React from 'react';
import { View, Text, StyleSheet, Pressable, ViewStyle } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useThemeStore } from '../../state/themeStore';
import { useSessionStore } from '../../state/sessionStore';
import { layout, spacing, typography } from '../tokens';
import { NAV_ITEMS, isNavActive, canSeeNavItem } from '../navigation';
import { Icon } from './Icon';
import type { InteractionState } from './Button';

// Admin-only destinations sit below a divider so daily work stays at the top.
const isAdminItem = (path: string) => path.startsWith('/admin') || path === '/suites';

export const Sidebar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const colors = useThemeStore((s) => s.colors);
  const userRole = useSessionStore((s) => s.userRole);
  const userPermissions = useSessionStore((s) => s.userPermissions);

  const visible = NAV_ITEMS.filter((item) => canSeeNavItem(item, userRole, userPermissions));
  const sections = [
    { key: 'daily', label: null, items: visible.filter((i) => !isAdminItem(i.path) && i.path !== '/settings') },
    { key: 'admin', label: 'Administration', items: visible.filter((i) => isAdminItem(i.path)) },
    { key: 'settings', label: null, items: visible.filter((i) => i.path === '/settings') },
  ].filter((s) => s.items.length > 0);

  return (
    <View style={[styles.sidebar, { backgroundColor: colors.chrome, borderRightColor: colors.border }]}>
      <View style={styles.brand}>
        <View style={[styles.brandMark, { backgroundColor: colors.saffron }]} />
        <View>
          <Text style={[styles.brandTitle, { color: colors.onChrome }]}>Smart Mess</Text>
          <Text style={[styles.brandSubtitle, { color: colors.chromeMuted }]}>
            Room allotment register
          </Text>
        </View>
      </View>

      {sections.map((section) => (
        <View
          key={section.key}
          style={[styles.section, section.key === 'settings' && styles.sectionBottom]}
        >
          {section.label ? (
            <Text style={[styles.sectionLabel, { color: colors.chromeMuted }]}>{section.label}</Text>
          ) : null}
          {section.items.map((item) => {
            const isActive = isNavActive(item.path, pathname);
            const fg = isActive ? colors.onChrome : colors.chromeMuted;

            return (
              <Pressable
                key={item.path}
                onPress={() => router.push(item.path as any)}
                accessible={true}
                accessibilityRole="link"
                accessibilityState={{ selected: isActive }}
                style={(state) => {
                  const { pressed, hovered, focused } = state as InteractionState;
                  return [
                    styles.navItem,
                    {
                      backgroundColor:
                        isActive || pressed || hovered ? colors.chromeRaised : 'transparent',
                    },
                    focused
                      ? ({ outlineColor: colors.saffron, outlineWidth: 2, outlineStyle: 'solid' } as ViewStyle)
                      : null,
                  ];
                }}
              >
                <View
                  style={[
                    styles.activeMark,
                    { backgroundColor: isActive ? colors.saffron : 'transparent' },
                  ]}
                />
                <Icon name={item.icon} size={18} color={fg} />
                <Text
                  numberOfLines={1}
                  style={[
                    styles.navText,
                    {
                      color: fg,
                      fontWeight: isActive ? typography.weights.semibold : typography.weights.regular,
                    },
                  ]}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  sidebar: {
    width: layout.sidebarWidth,
    height: '100%',
    borderRightWidth: layout.borderWidth,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.md,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.sm,
    minHeight: 59,
    marginBottom: spacing.md,
  },
  brandMark: {
    width: 4,
    height: 28,
    borderRadius: 1,
  },
  brandTitle: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
    letterSpacing: 0.2,
  },
  brandSubtitle: {
    fontSize: typography.xs,
    marginTop: 1,
  },
  section: {
    gap: 2,
    marginBottom: spacing.lg,
  },
  sectionBottom: {
    marginTop: 'auto',
    marginBottom: 0,
  },
  sectionLabel: {
    fontSize: typography.xs,
    fontWeight: typography.weights.semibold,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.xs,
  },
  navItem: {
    minHeight: 40,
    paddingRight: spacing.md,
    borderRadius: layout.borderRadius,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    overflow: 'hidden',
  },
  activeMark: {
    width: 3,
    alignSelf: 'stretch',
    marginRight: spacing.xs,
  },
  navText: {
    fontSize: typography.sm,
    flexShrink: 1,
  },
});
