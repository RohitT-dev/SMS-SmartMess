import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemeStore } from '../../src/state/themeStore';
import { useSessionStore } from '../../src/state/sessionStore';
import { Button } from '../../src/ui/primitives/Button';
import { Field } from '../../src/ui/primitives/Field';
import { Card } from '../../src/ui/primitives/Card';
import { Banner } from '../../src/ui/primitives/Banner';
import { spacing, typography } from '../../src/ui/tokens';
import { unlockWithPassphrase } from '../../src/features/crypto-session/cryptoSession';
import { supabase } from '../../src/lib/supabase';

export default function UnlockScreen() {
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const { setUserProfile } = useSessionStore();

  const [passphrase, setPassphrase] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Attempt biometric prompt on mobile if supported
    if (Platform.OS !== 'web') {
      tryBiometricUnlock();
    }
  }, []);

  const tryBiometricUnlock = async () => {
    try {
      const LocalAuth = await import('expo-local-authentication');
      const hasHardware = await LocalAuth.hasHardwareAsync();
      const isEnrolled = await LocalAuth.isEnrolledAsync();

      if (hasHardware && isEnrolled) {
        const result = await LocalAuth.authenticateAsync({
          promptMessage: 'Unlock Smart Mess System'
        });
        if (result.success) {
          // In biometric unlock, the device key in SecureStore retrieves the cached passphrase key
        }
      }
    } catch {
      // Non-fatal, fallback to manual passphrase entry
    }
  };

  const handleUnlock = async () => {
    if (!passphrase) {
      setError('Please enter your personal passphrase');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      await unlockWithPassphrase(passphrase);

      // Fetch user profile role and permissions
      const {
        data: { user }
      } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('role, permissions')
          .eq('id', user.id)
          .single();

        if (profile) {
          setUserProfile(profile.role, profile.permissions as any);
        }
      }

      router.replace('/');
    } catch (err: any) {
      if (err.message === 'WAITING_FOR_ADMIN_GRANT') {
        router.replace('/(auth)/waiting-for-access');
      } else {
        setError(err.message || 'Incorrect passphrase. Decryption failed.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={[styles.lockIcon]}>🔒</Text>
          <Text style={[styles.title, { color: colors.navy }]}>Unlock Device Key</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Zero-Knowledge Cryptographic Vault
          </Text>
        </View>

        <Card style={styles.card}>
          {error ? <Banner message={error} type="error" /> : null}

          <Field
            label="Personal Passphrase"
            value={passphrase}
            onChangeText={setPassphrase}
            secureTextEntry={true}
            placeholder="Enter passphrase to unwrap local keys"
          />

          <Button
            label="Unlock"
            onPress={handleUnlock}
            loading={loading}
            style={styles.button}
          />

          {/* Critical Security Notice as specified in Section 2.2 */}
          <View style={[styles.noticeBox, { backgroundColor: colors.bg, borderColor: colors.border }]}>
            <Text style={[styles.noticeText, { color: colors.muted }]}>
              ⚠️ <Text style={{ fontWeight: 'bold' }}>Forgotten passphrase cannot be reset by anyone.</Text>{' '}
              Your private key is protected with client-side Argon2id encryption. Supabase staff and Administrators do not hold your key. Only the master Recovery Code can restore access.
            </Text>
          </View>

          <Pressable
            onPress={() => router.push('/(auth)/recover')}
            style={styles.recoverLink}
          >
            <Text style={[styles.recoverText, { color: colors.blue }]}>
              Use 160-Bit Master Recovery Code →
            </Text>
          </Pressable>
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
  lockIcon: {
    fontSize: 40,
    marginBottom: spacing.xs
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
    marginTop: spacing.sm
  },
  noticeBox: {
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: 4,
    borderWidth: 1
  },
  noticeText: {
    fontSize: typography.xs,
    lineHeight: 18
  },
  recoverLink: {
    marginTop: spacing.lg,
    alignItems: 'center'
  },
  recoverText: {
    fontSize: typography.xs,
    fontWeight: typography.weights.bold
  }
});
