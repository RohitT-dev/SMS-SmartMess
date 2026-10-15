import React, { useState } from 'react';
import { View, Text, Modal, StyleSheet, TextInput, ScrollView } from 'react-native';
import { useThemeStore } from '../../state/themeStore';
import { layout, spacing, typography } from '../tokens';
import { Button } from './Button';

export interface DialogProps {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  confirmVariant?: 'primary' | 'secondary' | 'destructive';
  requireTypedWord?: string; // e.g. "CONFIRM"
  requireReasonMinLength?: number; // e.g. 10
  disabled?: boolean;
  loading?: boolean;
  children?: React.ReactNode;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
}

export const Dialog: React.FC<DialogProps> = ({
  visible,
  title,
  message,
  confirmLabel = 'Confirm',
  confirmVariant = 'destructive',
  requireTypedWord,
  requireReasonMinLength = 0,
  disabled = false,
  loading = false,
  children,
  onConfirm,
  onCancel
}) => {
  const colors = useThemeStore((s) => s.colors);
  const [typedWord, setTypedWord] = useState('');
  const [reason, setReason] = useState('');

  const wordMatch = !requireTypedWord || typedWord.trim() === requireTypedWord;
  const reasonValid = reason.trim().length >= requireReasonMinLength;
  const canConfirm = wordMatch && reasonValid && !disabled;

  const handleConfirm = () => {
    if (canConfirm) {
      onConfirm(reason.trim());
      setTypedWord('');
      setReason('');
    }
  };

  const handleCancel = () => {
    setTypedWord('');
    setReason('');
    onCancel();
  };

  return (
    <Modal visible={visible} transparent={true} animationType="fade" onRequestClose={handleCancel}>
      <View style={styles.overlay}>
        <View
          style={[
            styles.dialog,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border
            }
          ]}
        >
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
            {message ? <Text style={[styles.message, { color: colors.muted }]}>{message}</Text> : null}

            {children ? <View style={styles.childrenContainer}>{children}</View> : null}

            {requireReasonMinLength > 0 ? (
              <View style={styles.inputSection}>
                <Text style={[styles.inputLabel, { color: colors.text }]}>
                  Reason (minimum {requireReasonMinLength} characters):
                </Text>
                <TextInput
                  style={[
                    styles.textArea,
                    {
                      backgroundColor: colors.bg,
                      borderColor: colors.border,
                      color: colors.text
                    }
                  ]}
                  multiline={true}
                  numberOfLines={3}
                  placeholder="Enter formal justification..."
                  placeholderTextColor={colors.muted}
                  value={reason}
                  onChangeText={setReason}
                />
                <Text style={[styles.charCount, { color: colors.muted }]}>
                  {reason.trim().length} / {requireReasonMinLength}
                </Text>
              </View>
            ) : null}

            {requireTypedWord ? (
              <View style={styles.inputSection}>
                <Text style={[styles.inputLabel, { color: colors.text }]}>
                  Type <Text style={{ fontWeight: 'bold' }}>{requireTypedWord}</Text> to confirm:
                </Text>
                <TextInput
                  style={[
                    styles.input,
                    {
                      backgroundColor: colors.bg,
                      borderColor: colors.border,
                      color: colors.text
                    }
                  ]}
                  placeholder={requireTypedWord}
                  placeholderTextColor={colors.muted}
                  value={typedWord}
                  onChangeText={setTypedWord}
                  autoCapitalize="characters"
                />
              </View>
            ) : null}

            <View style={styles.actions}>
              <Button
                label="Cancel"
                variant="secondary"
                onPress={handleCancel}
                style={{ flex: 1, marginRight: spacing.sm }}
              />
              <Button
                label={confirmLabel}
                variant={confirmVariant}
                disabled={!canConfirm || loading}
                loading={loading}
                onPress={handleConfirm}
                style={{ flex: 1, marginLeft: spacing.sm }}
              />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg
  },
  dialog: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '90%',
    borderRadius: layout.borderRadius,
    borderWidth: layout.borderWidth,
    padding: spacing.lg
  },
  scrollContent: {
    paddingVertical: spacing.xs
  },
  title: {
    fontSize: typography.lg,
    fontWeight: typography.weights.bold,
    marginBottom: spacing.xs
  },
  message: {
    fontSize: typography.sm,
    marginBottom: spacing.md
  },
  childrenContainer: {
    marginBottom: spacing.md
  },
  inputSection: {
    marginBottom: spacing.md
  },
  inputLabel: {
    fontSize: typography.xs,
    fontWeight: typography.weights.medium,
    marginBottom: spacing.xs
  },
  input: {
    minHeight: layout.minTouchTarget,
    borderWidth: layout.borderWidth,
    borderRadius: layout.borderRadius,
    paddingHorizontal: spacing.md,
    fontSize: typography.base
  },
  textArea: {
    minHeight: 80,
    borderWidth: layout.borderWidth,
    borderRadius: layout.borderRadius,
    padding: spacing.md,
    fontSize: typography.base,
    textAlignVertical: 'top'
  },
  charCount: {
    fontSize: typography.xs,
    alignSelf: 'flex-end',
    marginTop: spacing.xs
  },
  actions: {
    flexDirection: 'row',
    marginTop: spacing.md
  }
});
