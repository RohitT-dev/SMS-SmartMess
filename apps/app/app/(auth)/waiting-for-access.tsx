import React, { useState } from 'react';
import { Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../src/state/themeStore';
import { Button } from '../../src/ui/primitives/Button';
import { Card } from '../../src/ui/primitives/Card';
import { Banner } from '../../src/ui/primitives/Banner';
import { AuthScreen } from '../../src/ui/primitives/AuthScreen';
import { spacing, typography } from '../../src/ui/tokens';
import { logAction } from '../../src/lib/activityLog';
import { resolvePostAuthRoute, signOut } from '../../src/features/auth/authFlow';

export default function WaitingForAccessScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRecheck = async () => {
    setChecking(true);
    setMessage(null);
    setError(null);
    try {
      logAction('keys.access_recheck');
      const next = await resolvePostAuthRoute();
      if (next.pathname === '/(auth)/waiting-for-access') {
        setMessage('No access code has been set yet. Ask an Administrator to set one.');
      } else {
        router.replace(next);
      }
    } catch (err: any) {
      setError(err.message || 'Could not check authorization status');
    } finally {
      setChecking(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    router.replace('/(auth)/sign-in');
  };

  return (
    <AuthScreen
      title="Waiting for an Access Code"
      subtitle="Your Administrator has not set one yet"
      icon="hourglass"
    >
      <Card style={styles.card}>
        {error ? <Banner message={error} type="error" /> : null}
        {message ? <Banner message={message} type="info" /> : null}

        <Text style={[styles.bodyText, { color: colors.text }]}>
          Your account is ready. After signing in, everyone enters an access code set by an
          Administrator for the current period. None has been set yet. Ask an Administrator, then
          check again.
        </Text>

        <Button
          label="Check Again"
          onPress={handleRecheck}
          loading={checking}
          style={styles.button}
        />
        <Button
          label="Sign Out"
          variant="secondary"
          onPress={handleSignOut}
          style={styles.button}
        />
      </Card>
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.lg,
  },
  bodyText: {
    fontSize: typography.sm,
    lineHeight: 22,
    marginBottom: spacing.md,
  },
  button: {
    marginTop: spacing.sm,
  },
});
