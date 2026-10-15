import React, { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { useSessionStore } from '../../src/state/sessionStore';

export default function AppLayout() {
  const router = useRouter();
  const isUnlocked = useSessionStore((s) => s.isUnlocked);

  useEffect(() => {
    if (!isUnlocked) {
      router.replace('/(auth)/unlock');
    }
  }, [isUnlocked, router]);

  return (
    <Stack screenOptions={{ headerShown: false }} />
  );
}
