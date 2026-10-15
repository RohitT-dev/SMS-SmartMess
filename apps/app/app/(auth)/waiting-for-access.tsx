import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../src/state/themeStore';
import { Button } from '../../src/ui/primitives/Button';
import { Card } from '../../src/ui/primitives/Card';
import { spacing, typography } from '../../src/ui/tokens';

export default function WaitingForAccessScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const [checking, setChecking] = useState(false);

  const handleRecheck = () => {
    setChecking(true);
    setTimeout(() => {
      setChecking(false);
      router.replace('/(auth)/unlock');
    }, 1000);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.icon}>⏳</Text>
          <Text style={[styles.title, { color: colors.navy }]}>Waiting for Admin to Grant Access</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Zero-Knowledge Public Key Exchange Pending
          </Text>
        </View>

        <Card style={styles.card}>
          <Text style={[styles.bodyText, { color: colors.text }]}>
            Your user account and cryptographic key pair have been registered. To maintain strict end-to-end security, an active Administrator must authorize your device by sealing the team master key to your public key.
          </Text>

          <Button
            label="Check Authorization Status"
            onPress={handleRecheck}
            loading={checking}
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
    maxWidth: 440
  },
  header: {
    marginBottom: spacing.xl,
    alignItems: 'center'
  },
  icon: {
    fontSize: 40,
    marginBottom: spacing.sm
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
  bodyText: {
    fontSize: typography.sm,
    lineHeight: 22,
    marginBottom: spacing.lg
  },
  button: {
    marginTop: spacing.sm
  }
});
