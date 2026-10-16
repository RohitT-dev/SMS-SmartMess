import React from 'react';
import { View, Text, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../state/themeStore';
import { useSessionStore } from '../../state/sessionStore';
import { layout, spacing, typography } from '../tokens';
import { Badge } from './Badge';
import { Icon } from './Icon';
import { logAction } from '../../lib/activityLog';

export interface TopBarProps {
  title: string;
  showBack?: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({ title, showBack = false }) => {
  const router = useRouter();
  const { colors, isDark, toggleTheme } = useThemeStore();
  const { userRole, lockSession } = useSessionStore();
  const { width } = useWindowDimensions();
  const isPhone = width < layout.phoneBreakpoint;

  const handleLock = () => {
    logAction('session.lock', { meta: { trigger: 'top_bar' } });
    lockSession();
    router.replace('/(auth)/unlock');
  };

  return (
    <View style={styles.wrapper}>
      <View
        style={[
          styles.container,
          {
            backgroundColor: colors.surface,
            borderBottomColor: colors.border,
            paddingHorizontal: isPhone ? spacing.sm : spacing.lg,
          },
        ]}
      >
        <View style={styles.left}>
          {showBack ? (
            <Pressable
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Go back"
              style={styles.backButton}
            >
              <Icon name="back" size={22} color={colors.blue} />
              {!isPhone ? (
                <Text style={[styles.backText, { color: colors.blue }]}>Back</Text>
              ) : null}
            </Pressable>
          ) : null}
          <Text
            numberOfLines={1}
            accessibilityRole="header"
            style={[
              styles.title,
              { color: colors.navy, fontSize: isPhone ? typography.base + 1 : typography.lg },
            ]}
          >
            {title}
          </Text>
        </View>

        <View style={styles.right}>
          {!isPhone ? (
            <View style={styles.roleBadge}>
              <Badge
                label={userRole === 'admin' ? 'Admin' : 'Clerk'}
                variant={userRole === 'admin' ? 'saffron' : 'default'}
              />
            </View>
          ) : null}

          <Pressable
            onPress={() => {
              toggleTheme();
              logAction('settings.theme_toggle', { meta: { to: isDark ? 'light' : 'dark' } });
            }}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            style={[styles.iconButton, { borderColor: colors.borderStrong }]}
          >
            <Icon name={isDark ? 'sun' : 'moon'} size={18} color={colors.text} />
          </Pressable>

          <Pressable
            onPress={handleLock}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="Lock application"
            style={[styles.lockButton, { borderColor: colors.borderStrong }]}
          >
            <Icon name="lock" size={18} color={colors.navy} />
            {!isPhone ? <Text style={[styles.lockText, { color: colors.navy }]}>Lock</Text> : null}
          </Pressable>
        </View>
      </View>

      {/* 3 px saffron accent line directly underneath the top bar */}
      <View style={[styles.saffronLine, { backgroundColor: colors.saffron }]} />
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    zIndex: 10,
  },
  container: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: layout.borderWidth,
  },
  left: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: spacing.sm,
  },
  backButton: {
    minHeight: layout.minTouchTarget,
    minWidth: layout.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: spacing.sm,
    marginLeft: -spacing.xs,
  },
  backText: {
    fontSize: typography.sm,
    fontWeight: typography.weights.semibold,
  },
  title: {
    flexShrink: 1,
    fontWeight: typography.weights.bold,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  roleBadge: {
    justifyContent: 'center',
  },
  iconButton: {
    width: layout.minTouchTarget,
    height: layout.minTouchTarget,
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    justifyContent: 'center',
    alignItems: 'center',
  },
  lockButton: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    minWidth: layout.minTouchTarget,
    height: layout.minTouchTarget,
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    justifyContent: 'center',
    alignItems: 'center',
  },
  lockText: {
    fontSize: typography.sm,
    fontWeight: typography.weights.semibold,
  },
  saffronLine: {
    height: layout.saffronBarHeight,
    width: '100%',
  },
});
