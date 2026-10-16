import React, { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { Stack, useRouter, useSegments, useRootNavigationState } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useThemeStore } from '../src/state/themeStore';
import { useAuthStore } from '../src/state/authStore';
import { useSessionStore } from '../src/state/sessionStore';
import { supabase } from '../src/lib/supabase';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5000,
    },
  },
});

// Auth screens a signed-out user may stay on.
const PUBLIC_AUTH_SCREENS = new Set(['sign-in', 'set-password']);

function isInviteOrRecoveryLink(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  const hash = window.location.hash || '';
  return /type=(invite|recovery)/.test(hash);
}

/** Keeps the Supabase session in sync and redirects signed-out users to sign-in. */
function useSupabaseAuth() {
  const router = useRouter();
  const segments = useSegments();
  const navState = useRootNavigationState();
  const { ready, session, needsPasswordSet, setSession, setReady, setNeedsPasswordSet } =
    useAuthStore();

  useEffect(() => {
    if (isInviteOrRecoveryLink()) setNeedsPasswordSet(true);

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady();
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      if (event === 'PASSWORD_RECOVERY') {
        setNeedsPasswordSet(true);
      }
      if (event === 'SIGNED_OUT') {
        useSessionStore.getState().lockSession();
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [setSession, setReady, setNeedsPasswordSet]);

  const inAuthGroup = segments[0] === '(auth)';
  const screen = segments[1] as string | undefined;
  const lastRedirect = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || !navState?.key) return;

    let target: '/(auth)/set-password' | '/(auth)/sign-in' | null = null;
    if (session && needsPasswordSet && screen !== 'set-password') {
      target = '/(auth)/set-password';
    } else if (!session && (!inAuthGroup || !screen || !PUBLIC_AUTH_SCREENS.has(screen))) {
      target = '/(auth)/sign-in';
    }

    // Redirect once per destination; navigation state updates re-run this effect.
    if (target && lastRedirect.current !== target) {
      lastRedirect.current = target;
      router.replace(target);
    } else if (!target) {
      lastRedirect.current = null;
    }
  }, [ready, navState?.key, session, needsPasswordSet, inAuthGroup, screen, router]);
}

function AppShell() {
  const isDark = useThemeStore((s) => s.isDark);
  useSupabaseAuth();

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AppShell />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
