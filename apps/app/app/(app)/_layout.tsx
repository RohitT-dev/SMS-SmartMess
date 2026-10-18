import React from 'react';
import { Redirect, Stack } from 'expo-router';
import { useSessionStore } from '../../src/state/sessionStore';
import { useAuthStore } from '../../src/state/authStore';

export default function AppLayout() {
  const isUnlocked = useSessionStore((s) => s.isUnlocked);
  const { ready, session } = useAuthStore();

  // Signed-out users are sent to sign-in by the root layout's auth gate.
  if (!ready || !session) {
    return null;
  }

  if (!isUnlocked) {
    return <Redirect href="/(auth)/unlock" />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
