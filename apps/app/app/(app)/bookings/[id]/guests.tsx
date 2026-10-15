import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useThemeStore } from '../../../../src/state/themeStore';
import { Screen } from '../../../../src/ui/primitives/Screen';
import { Card } from '../../../../src/ui/primitives/Card';
import { Button } from '../../../../src/ui/primitives/Button';
import { Field } from '../../../../src/ui/primitives/Field';
import { Badge } from '../../../../src/ui/primitives/Badge';
import { Banner } from '../../../../src/ui/primitives/Banner';
import { spacing, typography } from '../../../../src/ui/tokens';
import { supabase } from '../../../../src/lib/supabase';
import {
  encryptGuestPii,
  computeIdBlindIndex
} from '../../../../src/features/crypto-session/cryptoSession';
import { GuestPiiSchema, type GuestPii } from '@sms/core';

export default function GuestDetailsBackfillScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);
  const queryClient = useQueryClient();

  const [currentIdx, setCurrentIdx] = useState(0);
  const [formData, setFormData] = useState<Partial<GuestPii>>({
    name: '',
    serviceNumber: '',
    idNumber: '',
    phone: '',
    unit: '',
    notes: ''
  });
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Fetch booking guests
  const { data: guests, isLoading } = useQuery({
    queryKey: ['booking_guests_to_fill', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('booking_guests')
        .select('*')
        .eq('booking_id', id)
        .order('seq');
      if (error) throw error;
      return data || [];
    }
  });

  const guestList = guests || [];
  const currentGuest = guestList[currentIdx];
  const filledCount = guestList.filter((g: any) => g.details === 'COMPLETE').length;

  const handleSaveCurrentGuest = async () => {
    if (!currentGuest) return;
    setSubmitting(true);
    setErrorMsg(null);

    // Validate with zod
    const parsed = GuestPiiSchema.safeParse(formData);
    if (!parsed.success) {
      setErrorMsg(parsed.error.message || 'Validation error');
      setSubmitting(false);
      return;
    }

    try {
      const pii = parsed.data;
      const cipherEnc = encryptGuestPii(currentGuest.id, pii);
      const blindIndex = pii.idNumber ? computeIdBlindIndex(pii.idNumber) : null;

      const { error } = await supabase.rpc('set_guest_pii', {
        p_guest_id: currentGuest.id,
        p_pii_enc: cipherEnc,
        p_blind: blindIndex,
        p_key_version: 1
      });

      if (error) throw error;

      queryClient.invalidateQueries({ queryKey: ['booking_guests_to_fill', id] });
      queryClient.invalidateQueries({ queryKey: ['booking_record', id] });

      // Move to next guest or finish
      if (currentIdx < guestList.length - 1) {
        setCurrentIdx(currentIdx + 1);
        setFormData({
          name: '',
          serviceNumber: '',
          idNumber: '',
          phone: '',
          unit: '',
          notes: ''
        });
      } else {
        router.replace(`/(app)/bookings/${id}` as any);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to save encrypted guest details');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen title="Guest Details" showBack={true}>
      <ScrollView contentContainerStyle={styles.container}>
        <Card>
          <View style={styles.progressRow}>
            <Text style={[styles.progressText, { color: colors.navy }]}>
              Progress: {filledCount} of {guestList.length} filled
            </Text>
            <Badge
              label={`Guest ${currentIdx + 1} of ${guestList.length}`}
              variant="default"
            />
          </View>

          <Text style={[styles.securityNotice, { color: colors.muted }]}>
            All fields below are encrypted client-side on this device before upload. The Supabase database and hosting staff only store ciphertext.
          </Text>

          {currentGuest && (
            <View style={styles.formSection}>
              <View style={[styles.badgeStrip, { backgroundColor: colors.bg }]}>
                <Text style={[styles.badgeStripText, { color: colors.text }]}>
                  Rank: <Text style={{ fontWeight: 'bold' }}>{currentGuest.rank_code}</Text> • Gender:{' '}
                  <Text style={{ fontWeight: 'bold' }}>{currentGuest.gender}</Text> • Status:{' '}
                  <Text style={{ fontWeight: 'bold' }}>{currentGuest.details}</Text>
                </Text>
              </View>

              <Field
                label="Full Official Name *"
                value={formData.name || ''}
                onChangeText={(text) => setFormData({ ...formData, name: text })}
                placeholder="Rank & Full Name"
              />

              <Field
                label="Service Number"
                value={formData.serviceNumber || ''}
                onChangeText={(text) => setFormData({ ...formData, serviceNumber: text })}
                placeholder="e.g. 29482-K"
              />

              <Field
                label="Official ID / Aadhaar / Passport Number"
                value={formData.idNumber || ''}
                onChangeText={(text) => setFormData({ ...formData, idNumber: text })}
                placeholder="Required for exact blind index lookup"
                hint="Used to derive exact-match blind search index"
              />

              <Field
                label="Phone / Mobile Number *"
                value={formData.phone || ''}
                onChangeText={(text) => setFormData({ ...formData, phone: text })}
                placeholder="+91 XXXXX XXXXX"
                keyboardType="phone-pad"
              />

              <Field
                label="Parent Unit / Formation"
                value={formData.unit || ''}
                onChangeText={(text) => setFormData({ ...formData, unit: text })}
                placeholder="e.g. 12 Wing, AF Stn..."
              />

              <Field
                label="Special Dietary / Protocol Notes"
                value={formData.notes || ''}
                onChangeText={(text) => setFormData({ ...formData, notes: text })}
                placeholder="Free text notes (encrypted)"
                multiline={true}
              />

              {errorMsg && (
                <Banner
                  type="error"
                  message={errorMsg}
                  style={{ marginBottom: spacing.md }}
                />
              )}

              <View style={styles.buttonsRow}>
                {currentIdx > 0 && (
                  <Button
                    label="← Previous Guest"
                    variant="secondary"
                    onPress={() => setCurrentIdx(currentIdx - 1)}
                  />
                )}
                <Button
                  label={
                    currentIdx === guestList.length - 1
                      ? 'Save & Complete All'
                      : 'Save & Next Guest →'
                  }
                  variant="primary"
                  loading={submitting}
                  onPress={handleSaveCurrentGuest}
                />
              </View>
            </View>
          )}
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.md
  },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs
  },
  progressText: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold
  },
  securityNotice: {
    fontSize: typography.xs,
    marginBottom: spacing.md
  },
  formSection: {
    marginTop: spacing.sm
  },
  badgeStrip: {
    padding: spacing.sm,
    borderRadius: 4,
    marginBottom: spacing.md
  },
  badgeStripText: {
    fontSize: typography.sm
  },
  buttonsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md
  }
});
