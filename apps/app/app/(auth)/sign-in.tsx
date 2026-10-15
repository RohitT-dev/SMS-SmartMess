import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../src/state/themeStore';
import { Button } from '../../src/ui/primitives/Button';
import { Field } from '../../src/ui/primitives/Field';
import { Card } from '../../src/ui/primitives/Card';
import { Banner } from '../../src/ui/primitives/Banner';
import { layout, spacing, typography } from '../../src/ui/tokens';
import { supabase } from '../../src/lib/supabase';

export default function SignInScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    setError(null);
    if (!email || !password) {
      setError('Email and password are required');
      return;
    }
    if (password.length < 12) {
      setError('Password must be at least 12 characters');
      return;
    }

    try {
      setLoading(true);
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password
      });

      if (authError) {
        setError(authError.message);
        return;
      }

      // Check MFA requirement (AAL2 is mandatory)
      const { data: mfaData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (mfaData && mfaData.currentLevel !== 'aal2') {
        router.push('/(auth)/mfa');
      } else {
        router.push('/(auth)/unlock');
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.saffronAccent, { backgroundColor: colors.saffron }]} />

      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.navy }]}>Smart Mess System</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Authorized Personnel Only • Secure Access
          </Text>
        </View>

        <Card style={styles.card}>
          {error ? <Banner message={error} type="error" /> : null}

          <Field
            label="Service Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="officer@service.gov"
          />

          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry={true}
            placeholder="Minimum 12 characters"
          />

          <Button
            label="Sign In"
            onPress={handleSignIn}
            loading={loading}
            style={styles.button}
          />
        </Card>

        <Text style={[styles.footerNotice, { color: colors.muted }]}>
          Signups are disabled. Access is granted strictly via Administrator invitation.
        </Text>
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
  saffronAccent: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 4
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
  button: {
    marginTop: spacing.md
  },
  footerNotice: {
    fontSize: typography.xs,
    textAlign: 'center',
    marginTop: spacing.lg
  }
});
