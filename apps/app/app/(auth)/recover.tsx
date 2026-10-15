import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../src/state/themeStore';
import { Button } from '../../src/ui/primitives/Button';
import { Field } from '../../src/ui/primitives/Field';
import { Card } from '../../src/ui/primitives/Card';
import { Banner } from '../../src/ui/primitives/Banner';
import { spacing, typography } from '../../src/ui/tokens';
import { recoverWithRecoveryCode } from '../../src/features/crypto-session/cryptoSession';

export default function RecoverScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);

  const [recoveryCode, setRecoveryCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRecover = async () => {
    if (!recoveryCode.trim()) {
      setError('Please enter your 160-bit master recovery code');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await recoverWithRecoveryCode(recoveryCode.trim());
      router.replace('/');
    } catch (err: any) {
      setError(err.message || 'Recovery failed. Invalid recovery code.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.navy }]}>Master Key Recovery</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Restore Vault Access via Master Recovery Code
          </Text>
        </View>

        <Card style={styles.card}>
          {error ? <Banner message={error} type="error" /> : null}

          <Field
            label="160-Bit Master Recovery Code"
            value={recoveryCode}
            onChangeText={setRecoveryCode}
            autoCapitalize="characters"
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            hint="Case and dashes are handled automatically"
          />

          <Button
            label="Restore Access"
            onPress={handleRecover}
            loading={loading}
            style={styles.button}
          />

          <Button
            label="Back to Passphrase Unlock"
            variant="secondary"
            onPress={() => router.back()}
            style={[styles.button, { marginTop: spacing.sm }]}
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
    maxWidth: 440
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
  }
});
