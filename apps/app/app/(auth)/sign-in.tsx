import React, { useEffect, useState } from 'react';
import { Text, StyleSheet, Pressable, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../src/state/themeStore';
import { useAuthStore } from '../../src/state/authStore';
import { Button } from '../../src/ui/primitives/Button';
import { Field } from '../../src/ui/primitives/Field';
import { Card } from '../../src/ui/primitives/Card';
import { Banner } from '../../src/ui/primitives/Banner';
import { AuthScreen } from '../../src/ui/primitives/AuthScreen';
import { layout, spacing, typography } from '../../src/ui/tokens';
import { supabase, isSupabaseConfigured } from '../../src/lib/supabase';
import { logAction } from '../../src/lib/activityLog';
import { resolvePostAuthRoute, signOut } from '../../src/features/auth/authFlow';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignInScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const session = useAuthStore((s) => s.session);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const continueSignedIn = async () => {
    try {
      const next = await resolvePostAuthRoute();
      router.replace(next);
    } catch (err: any) {
      setError(err.message || 'Unable to verify account access');
      await signOut('inactive');
    }
  };

  // A persisted session skips the password step.
  useEffect(() => {
    if (session) {
      continueSignedIn();
    }
    // Only on mount: handleSignIn routes explicitly after a fresh sign-in.
  }, []);

  const handleSignIn = async () => {
    setError(null);
    setNotice(null);
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !password) {
      setError('Email and password are required');
      return;
    }
    if (!EMAIL_RE.test(trimmedEmail)) {
      setError('Enter a valid email address');
      return;
    }

    try {
      setLoading(true);
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });

      if (authError) {
        setError(authError.message);
        return;
      }

      setPassword('');
      logAction('auth.sign_in', { meta: { method: 'password' } });
      await continueSignedIn();
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    setError(null);
    setNotice(null);
    const trimmedEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(trimmedEmail)) {
      setError('Enter your service email above, then tap "Forgot password" again.');
      return;
    }
    try {
      setResetting(true);
      const redirectTo =
        Platform.OS === 'web' && typeof window !== 'undefined'
          ? `${window.location.origin}/set-password`
          : 'smartmess://set-password';
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(trimmedEmail, {
        redirectTo,
      });
      if (resetError) throw resetError;
      // Same message whether or not the account exists, to avoid account enumeration.
      setNotice('If that account exists, a password reset link has been sent.');
    } catch (err: any) {
      setError(err.message || 'Could not send reset email');
    } finally {
      setResetting(false);
    }
  };

  return (
    <AuthScreen
      title="Smart Mess System"
      subtitle="Authorized Personnel Only • Secure Access"
      maxWidth={420}
      footer={
        <Text style={[styles.footerNotice, { color: colors.muted }]}>
          Signups are disabled. Access is granted strictly via Administrator invitation.
        </Text>
      }
    >
      <Card style={styles.card}>
        {!isSupabaseConfigured ? (
          <Banner
            type="warning"
            message="Supabase is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in .env."
          />
        ) : null}
        {error ? <Banner message={error} type="error" /> : null}
        {notice ? <Banner message={notice} type="success" /> : null}

        <Field
          label="Service Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="username"
          keyboardType="email-address"
          returnKeyType="next"
          placeholder="officer@service.gov"
        />

        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry={true}
          autoComplete="password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={handleSignIn}
          placeholder="Your account password"
        />

        <Button label="Sign In" onPress={handleSignIn} loading={loading} style={styles.button} />

        <Pressable
          onPress={handleForgotPassword}
          disabled={resetting}
          accessibilityRole="button"
          style={styles.link}
        >
          <Text style={[styles.linkText, { color: colors.blue }]}>
            {resetting ? 'Sending reset link…' : 'Forgot password?'}
          </Text>
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
    marginTop: spacing.md,
  },
  link: {
    minHeight: layout.minTouchTarget,
    marginTop: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkText: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold,
  },
  footerNotice: {
    fontSize: typography.xs,
    textAlign: 'center',
    marginTop: spacing.lg,
  },
});
