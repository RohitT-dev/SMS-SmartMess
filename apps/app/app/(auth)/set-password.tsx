import React, { useState } from 'react';
import { StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuthStore } from '../../src/state/authStore';
import { Button } from '../../src/ui/primitives/Button';
import { Field } from '../../src/ui/primitives/Field';
import { Card } from '../../src/ui/primitives/Card';
import { Banner } from '../../src/ui/primitives/Banner';
import { AuthScreen } from '../../src/ui/primitives/AuthScreen';
import { spacing } from '../../src/ui/tokens';
import { supabase } from '../../src/lib/supabase';
import { logAction } from '../../src/lib/activityLog';
import { resolvePostAuthRoute } from '../../src/features/auth/authFlow';

const MIN_PASSWORD_LENGTH = 12;

/**
 * Reached from an invite email or a password-reset email. Supabase has already
 * signed the user in from the link; they must choose a password before continuing.
 */
export default function SetPasswordScreen() {
  const router = useRouter();
  const { session, setNeedsPasswordSet } = useAuthStore();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }

    try {
      setLoading(true);
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;

      logAction('auth.password_set');
      setNeedsPasswordSet(false);
      if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location.hash) {
        // Drop the one-time tokens from the address bar.
        window.history.replaceState(null, '', window.location.pathname);
      }
      router.replace(await resolvePostAuthRoute());
    } catch (err: any) {
      setError(err.message || 'Could not update password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthScreen
      title="Set Your Password"
      subtitle="Choose a password for your Smart Mess System account"
      icon="key"
      maxWidth={420}
    >
      <Card style={styles.card}>
        {!session ? (
          <Banner
            type="warning"
            message="This link has expired or was already used. Request a new one from the sign-in screen."
          />
        ) : null}
        {error ? <Banner message={error} type="error" /> : null}

        <Field
          label="New Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry={true}
          autoComplete="new-password"
          textContentType="newPassword"
          placeholder={`Minimum ${MIN_PASSWORD_LENGTH} characters`}
        />
        <Field
          label="Confirm Password"
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry={true}
          autoComplete="new-password"
          textContentType="newPassword"
          returnKeyType="go"
          onSubmitEditing={handleSave}
          placeholder="Re-type password"
        />

        <Button
          label="Save Password & Continue"
          onPress={handleSave}
          loading={loading}
          disabled={!session}
          style={styles.button}
        />
        <Button
          label="Back to Sign In"
          variant="secondary"
          onPress={() => {
            setNeedsPasswordSet(false);
            router.replace('/(auth)/sign-in');
          }}
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
  button: {
    marginTop: spacing.sm,
  },
});
