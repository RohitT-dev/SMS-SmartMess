import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../state/themeStore';
import { useSessionStore } from '../../state/sessionStore';
import { layout, spacing, typography } from '../tokens';
import { Badge } from './Badge';

export interface TopBarProps {
  title: string;
  showBack?: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({ title, showBack = false }) => {
  const router = useRouter();
  const { colors, isDark, toggleTheme } = useThemeStore();
  const { userRole, lockSession } = useSessionStore();

  const handleLock = () => {
    lockSession();
    router.replace('/(auth)/unlock');
  };

  return (
    <View style={styles.wrapper}>
      <View style={[styles.container, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <View style={styles.left}>
          {showBack ? (
            <Pressable
              onPress={() => router.back()}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Go back"
              style={styles.backButton}
            >
              <Text style={[styles.backText, { color: colors.blue }]}>← Back</Text>
            </Pressable>
          ) : null}
          <Text style={[styles.title, { color: colors.navy }]}>{title}</Text>
        </View>

        <View style={styles.right}>
          <Badge
            label={userRole === 'admin' ? 'ADMIN' : 'CLERK'}
            variant={userRole === 'admin' ? 'saffron' : 'default'}
          />

          <Pressable
            onPress={toggleTheme}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="Toggle color theme"
            style={[styles.iconButton, { borderColor: colors.border }]}
          >
            <Text style={{ color: colors.text, fontSize: 12 }}>{isDark ? '☀️' : '🌙'}</Text>
          </Pressable>

          <Pressable
            onPress={handleLock}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="Lock application"
            style={[styles.lockButton, { backgroundColor: colors.bg, borderColor: colors.border }]}
          >
            <Text style={[styles.lockText, { color: colors.navy }]}>🔒 Lock</Text>
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
    zIndex: 10
  },
  container: {
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: layout.borderWidth
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  backButton: {
    minHeight: layout.minTouchTarget,
    justifyContent: 'center',
    marginRight: spacing.md
  },
  backText: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold
  },
  title: {
    fontSize: typography.lg,
    fontWeight: typography.weights.bold
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    justifyContent: 'center',
    alignItems: 'center'
  },
  lockButton: {
    paddingHorizontal: spacing.sm,
    height: 36,
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    justifyContent: 'center',
    alignItems: 'center'
  },
  lockText: {
    fontSize: typography.xs,
    fontWeight: typography.weights.bold
  },
  saffronLine: {
    height: layout.saffronBarHeight,
    width: '100%'
  }
});
