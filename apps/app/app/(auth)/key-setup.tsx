import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../src/state/themeStore';
import { Button } from '../../src/ui/primitives/Button';
import { Field } from '../../src/ui/primitives/Field';
import { Card } from '../../src/ui/primitives/Card';
import { Banner } from '../../src/ui/primitives/Banner';
import { spacing, typography } from '../../src/ui/tokens';
import { initializeTeamKeySetup } from '../../src/features/crypto-session/cryptoSession';

export default function KeySetupScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);

  const [step, setStep] = useState<'passphrase' | 'recovery' | 'confirm'>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [generatedCode, setGeneratedCode] = useState('');
  const [confirmGroup2, setConfirmGroup2] = useState('');
  const [confirmGroup4, setConfirmGroup4] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreateKeys = async () => {
    if (passphrase.length < 12) {
      setError('Passphrase must be at least 12 characters');
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setError('Passphrases do not match');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const { recoveryCode } = await initializeTeamKeySetup(passphrase);
      setGeneratedCode(recoveryCode);
      setStep('recovery');
    } catch (err: any) {
      setError(err.message || 'Key initialization failed');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyConfirmation = () => {
    setError(null);
    const groups = generatedCode.split('-');
    const expectedGroup2 = groups[1];
    const expectedGroup4 = groups[3];

    if (
      confirmGroup2.trim().toUpperCase() !== expectedGroup2 ||
      confirmGroup4.trim().toUpperCase() !== expectedGroup4
    ) {
      setError('Verification failed. Re-entered groups do not match.');
      return;
    }

    router.replace('/');
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.navy }]}>First-Time Master Key Setup</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Administrator Cryptographic Initialization
          </Text>
        </View>

        <Card style={styles.card}>
          {error ? <Banner message={error} type="error" /> : null}

          {step === 'passphrase' ? (
            <>
              <Field
                label="Master Passphrase"
                value={passphrase}
                onChangeText={setPassphrase}
                secureTextEntry={true}
                placeholder="Choose a strong, memorable passphrase"
              />
              <Field
                label="Confirm Master Passphrase"
                value={confirmPassphrase}
                onChangeText={setConfirmPassphrase}
                secureTextEntry={true}
                placeholder="Re-type passphrase"
              />
              <Button
                label="Generate Master Vault Keys"
                onPress={handleCreateKeys}
                loading={loading}
                style={styles.button}
              />
            </>
          ) : step === 'recovery' ? (
            <>
              <Banner
                message="SAVE THIS RECOVERY CODE NOW. It will never be displayed again. If you lose your passphrase and this code, your encrypted data cannot be recovered by anyone."
                type="warning"
              />
              <View style={[styles.codeBox, { backgroundColor: colors.bg, borderColor: colors.saffron }]}>
                <Text style={[styles.codeText, { color: colors.navy }]}>{generatedCode}</Text>
              </View>
              <Button
                label="I Have Written Down My Recovery Code"
                onPress={() => setStep('confirm')}
                style={styles.button}
              />
            </>
          ) : (
            <>
              <Text style={[styles.confirmPrompt, { color: colors.text }]}>
                To verify your backup, re-enter groups #2 and #4 of your recovery code:
              </Text>
              <Field
                label="Group #2 (e.g. M9XA)"
                value={confirmGroup2}
                onChangeText={setConfirmGroup2}
                autoCapitalize="characters"
                maxLength={4}
              />
              <Field
                label="Group #4 (e.g. B82R)"
                value={confirmGroup4}
                onChangeText={setConfirmGroup4}
                autoCapitalize="characters"
                maxLength={4}
              />
              <Button
                label="Confirm & Launch System"
                onPress={handleVerifyConfirmation}
                style={styles.button}
              />
            </>
          )}
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
    maxWidth: 480
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
  codeBox: {
    padding: spacing.lg,
    borderRadius: 4,
    borderWidth: 2,
    marginVertical: spacing.md,
    alignItems: 'center'
  },
  codeText: {
    fontSize: typography.base,
    fontFamily: 'monospace',
    fontWeight: typography.weights.bold,
    textAlign: 'center',
    lineHeight: 28
  },
  confirmPrompt: {
    fontSize: typography.sm,
    marginBottom: spacing.md
  }
});
