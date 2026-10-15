import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { useSessionStore } from '../../state/sessionStore';
import { layout, spacing, typography } from '../tokens';

export interface MaskedValueProps {
  id?: string; // guestId
  label: string;
  fetchPlaintext?: () => Promise<string>;
  onReveal?: () => Promise<string>;
  fallbackMask?: string;
  maskedText?: string;
  canReveal?: boolean;
}

export const MaskedValue: React.FC<MaskedValueProps> = ({
  id,
  label,
  fetchPlaintext,
  onReveal,
  fallbackMask = '••••••••••••',
  maskedText,
  canReveal = true
}) => {
  const colors = useThemeStore((s) => s.colors);
  const { revealGuest, isGuestRevealed } = useSessionStore();
  const [revealedText, setRevealedText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState<number>(0);

  const guestId = id || 'masked-value';
  const isRevealed = isGuestRevealed(guestId) || !!revealedText;

  useEffect(() => {
    let timer: any;
    if (countdown > 0) {
      timer = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) {
            setRevealedText(null);
            return 0;
          }
          return c - 1;
        });
      }, 1000);
    } else {
      setRevealedText(null);
    }
    return () => clearInterval(timer);
  }, [countdown]);

  const handleReveal = async () => {
    if (!canReveal) return;
    try {
      setLoading(true);
      const fn = onReveal || fetchPlaintext;
      if (!fn) return;
      const plaintext = await fn();
      setRevealedText(plaintext);
      revealGuest(guestId, 15);
      setCountdown(15);
    } catch (err: any) {
      alert('Reveal error: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const displayText = maskedText || fallbackMask;

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>

      <View style={[styles.box, { backgroundColor: colors.bg, borderColor: colors.border }]}>
        <Text
          style={[
            styles.valueText,
            {
              color: revealedText ? colors.text : colors.muted,
              fontFamily: revealedText ? 'System' : 'monospace'
            }
          ]}
        >
          {revealedText ? revealedText : displayText}
        </Text>

        {revealedText ? (
          <View style={[styles.timerBadge, { backgroundColor: colors.saffron }]}>
            <Text style={styles.timerText}>Masking in {countdown}s</Text>
          </View>
        ) : canReveal ? (
          <Pressable
            onPress={handleReveal}
            disabled={loading}
            style={[styles.revealBtn, { backgroundColor: colors.navy }]}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel={`Reveal ${label}`}
          >
            {loading ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.revealBtnText}>Reveal (15s)</Text>
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginVertical: spacing.xs
  },
  label: {
    fontSize: typography.xs,
    textTransform: 'uppercase',
    marginBottom: 2
  },
  box: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderWidth: layout.borderWidth,
    borderRadius: layout.borderRadius,
    minHeight: layout.minTouchTarget
  },
  valueText: {
    fontSize: typography.sm,
    flex: 1
  },
  revealBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: layout.borderRadius
  },
  revealBtnText: {
    color: '#FFFFFF',
    fontSize: typography.xs,
    fontWeight: typography.weights.bold
  },
  timerBadge: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 4,
    borderRadius: layout.borderRadius
  },
  timerText: {
    color: '#12283F',
    fontSize: typography.xs,
    fontWeight: typography.weights.bold
  }
});
