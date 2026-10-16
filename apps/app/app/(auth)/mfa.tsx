import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../src/state/themeStore';
import { Button } from '../../src/ui/primitives/Button';
import { Field } from '../../src/ui/primitives/Field';
import { Card } from '../../src/ui/primitives/Card';
import { Banner } from '../../src/ui/primitives/Banner';
import { spacing, typography } from '../../src/ui/tokens';
import { AuthScreen } from '../../src/ui/primitives/AuthScreen';
import { supabase } from '../../src/lib/supabase';
import { logAction } from '../../src/lib/activityLog';
import { resolvePostAuthRoute, signOut } from '../../src/features/auth/authFlow';

export default function MfaScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);

  const [totpCode, setTotpCode] = useState('');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [totpSecret, setTotpSecret] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkMfaFactors();
  }, []);

  const checkMfaFactors = async () => {
    try {
      setInitializing(true);
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;

      const verifiedFactor = data.totp.find((f) => f.status === 'verified');
      if (verifiedFactor) {
        setFactorId(verifiedFactor.id);
        return;
      }

      // Abandoned enrollments count toward the factor limit; clear them first.
      for (const stale of data.all.filter(
        (f) => f.factor_type === 'totp' && f.status !== 'verified',
      )) {
        await supabase.auth.mfa.unenroll({ factorId: stale.id });
      }

      const { data: enrollData, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        issuer: 'SmartMessSystem',
        friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}`,
      });
      if (enrollError) throw enrollError;
      setFactorId(enrollData.id);
      setTotpSecret(enrollData.totp.secret);
      logAction('auth.mfa_enroll_started');
    } catch (err: any) {
      setError(err.message || 'Failed to initialize MFA');
    } finally {
      setInitializing(false);
    }
  };

  const handleVerify = async () => {
    const code = totpCode.replace(/\s/g, '');
    if (!factorId || !/^\d{6}$/.test(code)) {
      setError('Please enter a valid 6-digit authenticator code');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const verify = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
      if (verify.error) {
        logAction('auth.mfa_failed');
        throw verify.error;
      }

      logAction(totpSecret ? 'auth.mfa_enrolled' : 'auth.mfa_verified');
      router.replace(await resolvePostAuthRoute());
    } catch (err: any) {
      setError(err.message || 'Invalid MFA Code');
      setTotpCode('');
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    router.replace('/(auth)/sign-in');
  };

  return (
    <AuthScreen title="Two-Factor Authentication" subtitle="Mandatory AAL2 Compliance Protocol">
      <Card style={styles.card}>
        {error ? <Banner message={error} type="error" /> : null}

        {totpSecret ? (
          <View style={styles.enrollBox}>
            <Text style={[styles.enrollLabel, { color: colors.text }]}>
              Add this key in your authenticator app (Google Authenticator, Microsoft Authenticator,
              1Password…), then enter the 6-digit code it shows:
            </Text>
            <Text
              selectable={true}
              style={[styles.secretText, { color: colors.navy, backgroundColor: colors.bg }]}
            >
              {totpSecret.replace(/(.{4})/g, '$1 ').trim()}
            </Text>
          </View>
        ) : null}

        <Field
          label="6-Digit Authenticator Code"
          value={totpCode}
          onChangeText={(t) => setTotpCode(t.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          maxLength={6}
          returnKeyType="go"
          onSubmitEditing={handleVerify}
          placeholder="123456"
        />

        <Button
          label="Verify & Continue"
          onPress={handleVerify}
          loading={loading || initializing}
          disabled={!factorId}
          style={styles.button}
        />
        <Button
          label="Sign Out"
          variant="secondary"
          onPress={handleSignOut}
          style={[styles.button, { marginTop: spacing.sm }]}
        />
      </Card>
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.lg,
  },
  enrollBox: {
    marginBottom: spacing.md,
  },
  enrollLabel: {
    fontSize: typography.xs,
    fontWeight: typography.weights.medium,
    marginBottom: spacing.xs,
  },
  secretText: {
    fontSize: typography.sm,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    padding: spacing.sm,
    borderRadius: 4,
    textAlign: 'center',
  },
  button: {
    marginTop: spacing.md,
  },
});
