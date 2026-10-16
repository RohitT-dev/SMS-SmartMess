import React, { useCallback, useEffect, useRef } from 'react';
import {
  View,
  StyleSheet,
  useWindowDimensions,
  AppState,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, usePathname, useFocusEffect } from 'expo-router';
import { useThemeStore } from '../../state/themeStore';
import { useSessionStore } from '../../state/sessionStore';
import { layout, spacing } from '../tokens';
import { logAction } from '../../lib/activityLog';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';

export interface ScreenProps {
  title: string;
  showBack?: boolean;
  children: React.ReactNode;
  scrollable?: boolean;
}

export const Screen: React.FC<ScreenProps> = ({
  title,
  showBack = false,
  children,
  scrollable = true,
}) => {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const colors = useThemeStore((s) => s.colors);
  const { isUnlocked, autoLockMinutes, lastActivityAt, recordActivity, lockSession } =
    useSessionStore();

  const isDesktop = width >= layout.webBreakpoint;
  const isPhone = width < layout.phoneBreakpoint;
  const contentPadding = isPhone ? spacing.md : spacing.lg;

  // 1. Mobile background auto-lock
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState.match(/inactive|background/)) {
        if (isUnlocked) {
          logAction('session.auto_lock', { meta: { trigger: 'background' } });
          lockSession();
          router.replace('/(auth)/unlock');
        }
      }
    });
    return () => sub.remove();
  }, [isUnlocked, lockSession, router]);

  // Per-user activity log: one screen_view each time this screen gains focus
  // (stacked screens stay mounted underneath, so a plain effect would over-log).
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  useFocusEffect(
    useCallback(() => {
      logAction('screen_view', { meta: { path: pathnameRef.current, title } });
    }, [title]),
  );

  // Web: count mouse, keyboard and scroll activity too (onTouchStart only sees touch).
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    let last = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - last > 5000) {
        last = now;
        recordActivity();
      }
    };
    const events = ['pointerdown', 'keydown', 'wheel'] as const;
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, onActivity));
  }, [recordActivity]);

  // 2. Inactivity timer auto-lock
  useEffect(() => {
    if (!isUnlocked) return;
    const interval = setInterval(() => {
      const elapsedMinutes = (Date.now() - lastActivityAt) / (1000 * 60);
      if (elapsedMinutes >= autoLockMinutes) {
        logAction('session.auto_lock', {
          meta: { trigger: 'inactivity', minutes: autoLockMinutes },
        });
        lockSession();
        router.replace('/(auth)/unlock');
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [isUnlocked, lastActivityAt, autoLockMinutes, lockSession, router]);

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: colors.bg }]}
      // Bottom inset is applied by the TabBar on phones; desktop has no tab bar.
      edges={isDesktop ? ['top', 'bottom', 'left', 'right'] : ['top', 'left', 'right']}
      onTouchStart={recordActivity}
    >
      <View style={styles.layout}>
        {/* Web Sidebar >= 1024px */}
        {isDesktop ? <Sidebar /> : null}

        <View style={styles.main}>
          <TopBar title={title} showBack={showBack} />

          <KeyboardAvoidingView
            style={styles.contentWrapper}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            {scrollable ? (
              <ScrollView
                contentContainerStyle={[styles.scrollContent, { padding: contentPadding }]}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
              >
                {children}
              </ScrollView>
            ) : (
              <View style={[styles.content, { padding: contentPadding }]}>{children}</View>
            )}
          </KeyboardAvoidingView>

          {/* Mobile Bottom TabBar < 1024px */}
          {!isDesktop ? <TabBar /> : null}
        </View>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  layout: {
    flex: 1,
    flexDirection: 'row',
  },
  main: {
    flex: 1,
    height: '100%',
  },
  contentWrapper: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: spacing.xxl,
    maxWidth: 1200,
    width: '100%',
    alignSelf: 'center',
  },
  content: {
    flex: 1,
    maxWidth: 1200,
    width: '100%',
    alignSelf: 'center',
  },
});
