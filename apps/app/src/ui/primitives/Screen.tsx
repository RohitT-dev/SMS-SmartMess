import React, { useEffect } from 'react';
import {
  View,
  StyleSheet,
  useWindowDimensions,
  AppState,
  ScrollView,
  SafeAreaView
} from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../state/themeStore';
import { useSessionStore } from '../../state/sessionStore';
import { layout } from '../tokens';
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
  scrollable = true
}) => {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const colors = useThemeStore((s) => s.colors);
  const { isUnlocked, autoLockMinutes, lastActivityAt, recordActivity, lockSession } =
    useSessionStore();

  const isDesktop = width >= layout.webBreakpoint;

  // 1. Mobile background auto-lock
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState.match(/inactive|background/)) {
        if (isUnlocked) {
          lockSession();
          router.replace('/(auth)/unlock');
        }
      }
    });
    return () => sub.remove();
  }, [isUnlocked, lockSession, router]);

  // 2. Inactivity timer auto-lock
  useEffect(() => {
    if (!isUnlocked) return;
    const interval = setInterval(() => {
      const elapsedMinutes = (Date.now() - lastActivityAt) / (1000 * 60);
      if (elapsedMinutes >= autoLockMinutes) {
        lockSession();
        router.replace('/(auth)/unlock');
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [isUnlocked, lastActivityAt, autoLockMinutes, lockSession, router]);

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: colors.bg }]}
      onTouchStart={recordActivity}
    >
      <View style={styles.layout}>
        {/* Web Sidebar >= 1024px */}
        {isDesktop ? <Sidebar /> : null}

        <View style={styles.main}>
          <TopBar title={title} showBack={showBack} />

          <View style={styles.contentWrapper}>
            {scrollable ? (
              <ScrollView
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
              >
                {children}
              </ScrollView>
            ) : (
              <View style={styles.content}>{children}</View>
            )}
          </View>

          {/* Mobile Bottom TabBar < 1024px */}
          {!isDesktop ? <TabBar /> : null}
        </View>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1
  },
  layout: {
    flex: 1,
    flexDirection: 'row'
  },
  main: {
    flex: 1,
    height: '100%'
  },
  contentWrapper: {
    flex: 1
  },
  scrollContent: {
    padding: 16,
    maxWidth: 1200,
    width: '100%',
    alignSelf: 'center'
  },
  content: {
    flex: 1,
    padding: 16,
    maxWidth: 1200,
    width: '100%',
    alignSelf: 'center'
  }
});
