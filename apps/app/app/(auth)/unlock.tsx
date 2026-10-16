import React, { useState } from 'react';
import { Text, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../src/state/themeStore';
import { Button } from '../../src/ui/primitives/Button';
import { Field } from '../../src/ui/primitives/Field';
import { Card } from '../../src/ui/primitives/Card';
import { Banner } from '../../src/ui/primitives/Banner';
import { AuthScreen } from '../../src/ui/primitives/AuthScreen';
import { layout, spacing, typography } from '../../src/ui/tokens';
import { unlockWithAccessCode } from '../../src/features/crypto-session/cryptoSession';
import { logAction } from '../../src/lib/activityLog';
import { completeUnlock, signOut } from '../../src/features/auth/authFlow';
import { DeviceRevokedError } from '../../src/features/auth/device';

/** Second login step: the access code an Administrator set for the current period. */
export default function UnlockScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);

  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUnlock = async () => {
    if (!code) {
      setError('Enter the access code');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await unlockWithAccessCode(code);
      setCode('');
      logAction('session.unlock', { meta: { method: 'access_code' } });
      await completeUnlock();
      router.replace('/');
    } catch (err: any) {
      setCode('');
      if (err instanceof DeviceRevokedError) {
        await signOut('device_revoked');
        router.replace('/(auth)/sign-in');
        return;
      }
      setError(err.message || 'Access code could not be verified.');
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    router.replace('/(auth)/sign-in');
  };

  return (
    <AuthScreen
      title="Enter Access Code"
      subtitle="Code set by your Administrator for this period"
      icon="lock"
    >
      <Card style={styles.card}>
        {error ? <Banner message={error} type="error" /> : null}

        <Field
          label="Access Code"
          value={code}
          onChangeText={(t) => setCode(t.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          secureTextEntry={true}
          maxLength={12}
          autoComplete="off"
          returnKeyType="go"
          onSubmitEditing={handleUnlock}
          placeholder="6–12 digits"
        />

        <Button label="Continue" onPress={handleUnlock} loading={loading} style={styles.button} />

        <Pressable onPress={handleSignOut} accessibilityRole="button" style={styles.link}>
          <Text style={[styles.linkText, { color: colors.muted }]}>Sign out / switch account</Text>
        </Pressable>
      </Card>
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.lg,
  },
  button: {
    marginTop: spacing.sm,
  },
  link: {
    minHeight: layout.minTouchTarget,
    marginTop: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkText: {
    fontSize: typography.xs,
    fontWeight: typography.weights.bold,
  },
});
