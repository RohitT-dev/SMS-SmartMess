import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../src/state/themeStore';
import { Button } from '../../src/ui/primitives/Button';
import { Field } from '../../src/ui/primitives/Field';
import { Card } from '../../src/ui/primitives/Card';
import { Banner } from '../../src/ui/primitives/Banner';
import { spacing, typography } from '../../src/ui/tokens';
import { supabase } from '../../src/lib/supabase';

export default function MfaScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);

  const [totpCode, setTotpCode] = useState('');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [totpSecret, setTotpSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkMfaFactors();
  }, []);

  const checkMfaFactors = async () => {
    try {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;

      const verifiedFactor = data.totp.find((f) => f.status === 'verified');
      if (verifiedFactor) {
        setFactorId(verifiedFactor.id);
      } else {
        // Enroll new TOTP factor
        const { data: enrollData, error: enrollError } = await supabase.auth.mfa.enroll({
          factorType: 'totp',
          issuer: 'SmartMessSystem'
        });
        if (enrollError) throw enrollError;
        setFactorId(enrollData.id);
        setTotpUri(enrollData.totp.uri);
        setTotpSecret(enrollData.totp.secret);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to initialize MFA');
    }
  };

  const handleVerify = async () => {
    if (!factorId || totpCode.trim().length !== 6) {
      setError('Please enter a valid 6-digit authenticator code');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const challenge = await supabase.auth.mfa.challenge({ factorId });
      if (challenge.error) throw challenge.error;

      const verify = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.data.id,
        code: totpCode.trim()
      });
      if (verify.error) throw verify.error;

      // Check if user is first-time Admin needing key setup
      const { data: teamKeys } = await supabase.from('team_key_versions').select('version').limit(1);
      if (!teamKeys || teamKeys.length === 0) {
        router.push('/(auth)/key-setup');
      } else {
        router.push('/(auth)/unlock');
      }
    } catch (err: any) {
      setError(err.message || 'Invalid MFA Code');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.navy }]}>Two-Factor Authentication</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Mandatory AAL2 Compliance Protocol
          </Text>
        </View>

        <Card style={styles.card}>
          {error ? <Banner message={error} type="error" /> : null}

          {totpSecret ? (
            <View style={styles.enrollBox}>
              <Text style={[styles.enrollLabel, { color: colors.text }]}>
                Scan in Authenticator App (or enter manual key):
              </Text>
              <Text style={[styles.secretText, { color: colors.navy, backgroundColor: colors.bg }]}>
                {totpSecret}
              </Text>
            </View>
          ) : null}

          <Field
            label="6-Digit Authenticator Code"
            value={totpCode}
            onChangeText={setTotpCode}
            keyboardType="number-pad"
            maxLength={6}
            placeholder="123456"
          />

          <Button
            label="Verify & Continue"
            onPress={handleVerify}
            loading={loading}
            style={styles.button}
          />
        </Card>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg
  },
  content: {
    width: '100%',
    maxWidth: 420
  },
  header: {
    marginBottom: spacing.xl,
    alignItems: 'center'
  },
  title: {
    fontSize: typography.xl,
    fontWeight: typography.weights.bold,
    textAlign: 'center'
  },
  subtitle: {
    fontSize: typography.sm,
    marginTop: spacing.xs,
    textAlign: 'center'
  },
  card: {
    padding: spacing.xl
  },
  enrollBox: {
    marginBottom: spacing.md
  },
  enrollLabel: {
    fontSize: typography.xs,
    fontWeight: typography.weights.medium,
    marginBottom: spacing.xs
  },
  secretText: {
    fontSize: typography.sm,
    fontFamily: 'monospace',
    padding: spacing.sm,
    borderRadius: 4,
    textAlign: 'center'
  },
  button: {
    marginTop: spacing.md
  }
});
