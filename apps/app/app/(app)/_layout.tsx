import React from 'react';
import { Redirect, Stack } from 'expo-router';
import { useSessionStore } from '../../src/state/sessionStore';

export default function AppLayout() {
  const isUnlocked = useSessionStore((s) => s.isUnlocked);

  if (!isUnlocked) {
    return <Redirect href="/(auth)/unlock" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }} />
  );
}
