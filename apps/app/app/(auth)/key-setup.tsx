import React, { useState } from 'react';
import { Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../src/state/themeStore';
import { Button } from '../../src/ui/primitives/Button';
import { Field } from '../../src/ui/primitives/Field';
import { Card } from '../../src/ui/primitives/Card';
import { Banner } from '../../src/ui/primitives/Banner';
import { AuthScreen } from '../../src/ui/primitives/AuthScreen';
import { spacing, typography } from '../../src/ui/tokens';
import {
  ACCESS_CODE_PATTERN,
  initializeWithAccessCode,
} from '../../src/features/crypto-session/cryptoSession';
import { logAction } from '../../src/lib/activityLog';
import { completeUnlock, signOut } from '../../src/features/auth/authFlow';
import { parseValidUntil } from '../../src/features/auth/accessCode';

/** First run only: the first Administrator sets the first access code. */
export default function AccessCodeSetupScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);

  const [code, setCode] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    setError(null);
    if (!ACCESS_CODE_PATTERN.test(code)) {
      setError('Access code must be 6 to 12 digits');
      return;
    }
    if (code !== confirmCode) {
      setError('Codes do not match');
      return;
    }

    try {
      setLoading(true);
      await initializeWithAccessCode(code, parseValidUntil(validUntil));
      logAction('access_code.bootstrap', { meta: { has_expiry: !!validUntil } });
      setCode('');
      setConfirmCode('');
      await completeUnlock();
      router.replace('/');
    } catch (err: any) {
      setError(err.message || 'Setup failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    router.replace('/(auth)/sign-in');
  };

  return (
    <AuthScreen title="Set the First Access Code" subtitle="Administrator first-time setup">
      <Card style={styles.card}>
        {error ? <Banner message={error} type="error" /> : null}

        <Text style={[styles.note, { color: colors.text }]}>
          Staff sign in with their email and password, then enter this code. Share it with your team
          and change it whenever you like under More → Access Code. Use 8 or more digits; if every
          Administrator forgets the current code, encrypted data cannot be recovered.
        </Text>

        <Field
          label="Access Code"
          value={code}
          onChangeText={(t) => setCode(t.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          secureTextEntry={true}
          maxLength={12}
          placeholder="6–12 digits"
        />
        <Field
          label="Confirm Access Code"
          value={confirmCode}
          onChangeText={(t) => setConfirmCode(t.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          secureTextEntry={true}
          maxLength={12}
          placeholder="Re-type code"
        />
        <Field
          label="Valid Until (optional)"
          value={validUntil}
          onChangeText={setValidUntil}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="YYYY-MM-DD — leave blank for no expiry"
          hint="The code stops working at the end of this day."
          returnKeyType="go"
          onSubmitEditing={handleCreate}
        />

        <Button
          label="Save Code & Continue"
          onPress={handleCreate}
          loading={loading}
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
  note: {
    fontSize: typography.sm,
    lineHeight: 20,
    marginBottom: spacing.md,
  },
  button: {
    marginTop: spacing.sm,
  },
});
