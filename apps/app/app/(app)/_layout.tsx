import React from 'react';
import { Redirect, Stack } from 'expo-router';
import { useSessionStore } from '../../src/state/sessionStore';
import { useAuthStore } from '../../src/state/authStore';
import { useGuestDetailsBackfill } from '../../src/features/bookings/useGuestDetailsBackfill';

export default function AppLayout() {
  const isUnlocked = useSessionStore((s) => s.isUnlocked);
  const { ready, session } = useAuthStore();
  // Admin only, once per session, after unlock: copies names out of encrypted records. See the hook.
  useGuestDetailsBackfill();

  // Signed-out users are sent to sign-in by the root layout's auth gate.
  if (!ready || !session) {
    return null;
  }

  if (!isUnlocked) {
    return <Redirect href="/(auth)/unlock" />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
