import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
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
import { logAction } from '../../../../src/lib/activityLog';
import { userErrorMessage } from '../../../../src/lib/userError';
import {
  encryptGuestPii,
  computeIdBlindIndex,
  getActiveKeyVersion,
} from '../../../../src/features/crypto-session/cryptoSession';
import { CivilianPiiSchema, GuestPiiSchema, type GuestPii } from '@sms/core';
import { describeGuest } from '../../../../src/features/bookings/party';
import { guestHasName, guestName } from '../../../../src/features/bookings/guestDisplay';
import { savePlainGuestDetails } from '../../../../src/features/bookings/plainGuestDetails';

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
    notes: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const EMPTY_FORM: Partial<GuestPii> = {
    name: '',
    serviceNumber: '',
    idNumber: '',
    phone: '',
    unit: '',
    notes: '',
  };

  const goToGuest = (idx: number) => {
    setCurrentIdx(idx);
    setFormData(EMPTY_FORM);
    setFieldErrors({});
    setErrorMsg(null);
  };

  // Fetch booking guests
  const { data: guests } = useQuery({
    queryKey: ['booking_guests_to_fill', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('booking_guests')
        .select('*')
        .eq('booking_id', id)
        .order('seq');
      if (error) throw error;
      return data || [];
    },
  });

  const guestList = guests || [];
  const currentGuest = guestList[currentIdx];
  const filledCount = guestList.filter((g: any) => g.details === 'COMPLETE').length;
  // Civilians (no rank) need only a name; ID and phone are optional, service fields don't apply.
  const isCivilian = Boolean(currentGuest && !currentGuest.rank_code);

  const handleSaveCurrentGuest = async () => {
    if (!currentGuest) return;
    setSubmitting(true);
    setErrorMsg(null);
    setFieldErrors({});

    const parsed = (isCivilian ? CivilianPiiSchema : GuestPiiSchema).safeParse(formData);
    if (!parsed.success) {
      const byField: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        if (key && !byField[key]) byField[key] = issue.message;
      }
      setFieldErrors(byField);
      if (Object.keys(byField).length === 0) setErrorMsg('Please check the details and try again.');
      setSubmitting(false);
      return;
    }

    try {
      const pii = parsed.data;

      // Name, unit, service number and phone are stored as readable text (what every screen shows
      // and search matches). Saved first: if it fails nothing else is written and the error is shown.
      // The form replaces the whole record, so a blank field clears the stored value.
      const plain = await savePlainGuestDetails(supabase, currentGuest.id, {
        name: pii.name,
        unit: pii.unit ?? '',
        serviceNumber: pii.serviceNumber ?? '',
        phone: pii.phone ?? '',
      });
      if (!plain.ok) throw new Error(plain.message);

      const cipherEnc = encryptGuestPii(currentGuest.id, pii);
      const blindIndex = pii.idNumber
        ? computeIdBlindIndex(pii.idNumber)
        : computeIdBlindIndex(`NO_ID_${currentGuest.id}`);

      const { error } = await supabase.rpc('set_guest_pii', {
        p_guest_id: currentGuest.id,
        p_pii_enc: cipherEnc,
        p_blind: blindIndex,
        p_key_version: getActiveKeyVersion(),
      });

      if (error) throw error;

      logAction('guests.details_saved', {
        entity: 'booking_guests',
        entityId: currentGuest.id,
        meta: { booking_id: id },
      });

      queryClient.invalidateQueries({ queryKey: ['booking_guests_to_fill', id] });
      queryClient.invalidateQueries({ queryKey: ['booking_record', id] });
      queryClient.invalidateQueries({ queryKey: ['bookings_ledger'] });
      queryClient.invalidateQueries({ queryKey: ['guest_pii_for_requests'] });
      queryClient.invalidateQueries({ queryKey: ['guest_pii_for_ledger'] });
      queryClient.invalidateQueries({ queryKey: ['guest_pii_for_past_bookings'] });
      queryClient.invalidateQueries({ queryKey: ['past_bookings_list'] });

      // Move to next guest or finish
      if (currentIdx < guestList.length - 1) {
        goToGuest(currentIdx + 1);
      } else {
        router.replace(`/(app)/bookings/${id}` as any);
      }
    } catch (err: unknown) {
      setErrorMsg(userErrorMessage(err, 'Failed to save guest details'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen title="Guest Details" showBack={true}>
      <View style={styles.container}>
        <Card>
          <View style={styles.progressRow}>
            <Text style={[styles.progressText, { color: colors.navy }]}>
              Progress: {filledCount} of {guestList.length} filled
            </Text>
            <Badge label={`Guest ${currentIdx + 1} of ${guestList.length}`} variant="default" />
          </View>

          <Text style={[styles.securityNotice, { color: colors.muted }]}>
            Name, unit, service number and phone are saved as readable text so they show and can be
            searched everywhere. The ID number and notes are encrypted on this device before upload;
            the database and hosting staff only store ciphertext for them.
          </Text>

          {currentGuest && (
            <View style={styles.formSection}>
              <View style={[styles.badgeStrip, { backgroundColor: colors.bg }]}>
                <Text style={[styles.badgeStripText, { color: colors.text }]}>
                  {guestHasName(currentGuest) ? (
                    <Text style={{ fontWeight: 'bold', color: colors.navy }}>{guestName(currentGuest)} • </Text>
                  ) : null}
                  Guest ID: <Text style={{ fontWeight: 'bold', color: colors.blue }}>{currentGuest.guest_code || 'GST-…'}</Text> •
                  <Text style={{ fontWeight: 'bold' }}>{describeGuest(currentGuest)}</Text> •
                  Status: <Text style={{ fontWeight: 'bold' }}>{currentGuest.details}</Text>
                </Text>
              </View>

              {currentGuest.details === 'COMPLETE' && (
                <Banner
                  type="info"
                  message="Details are already saved for this guest. Saving again replaces them."
                />
              )}

              <Field
                label="Full Official Name *"
                value={formData.name || ''}
                onChangeText={(text) => setFormData({ ...formData, name: text })}
                placeholder={isCivilian ? 'Full name' : 'Rank & Full Name'}
                error={fieldErrors.name}
              />

              {!isCivilian && (
                <Field
                  label="Service Number"
                  value={formData.serviceNumber || ''}
                  onChangeText={(text) => setFormData({ ...formData, serviceNumber: text })}
                  placeholder="e.g. 29482-K"
                />
              )}

              <Field
                label={isCivilian ? 'ID / Aadhaar / Passport Number (optional)' : 'Official ID / Aadhaar / Passport Number *'}
                value={formData.idNumber || ''}
                onChangeText={(text) => setFormData({ ...formData, idNumber: text })}
                placeholder="Optional (Aadhaar, Passport, Voter ID...)"
                hint="Optional reference number (stored encrypted)"
                error={fieldErrors.idNumber}
              />

              <Field
                label={isCivilian ? 'Phone / Mobile Number (optional)' : 'Phone / Mobile Number *'}
                value={formData.phone || ''}
                onChangeText={(text) => setFormData({ ...formData, phone: text })}
                placeholder="+91 XXXXX XXXXX"
                keyboardType="phone-pad"
                error={fieldErrors.phone}
              />

              {!isCivilian && (
                <Field
                  label="Parent Unit / Formation"
                  value={formData.unit || ''}
                  onChangeText={(text) => setFormData({ ...formData, unit: text })}
                  placeholder="e.g. 12 Wing, AF Stn..."
                />
              )}

              <Field
                label="Special Dietary / Protocol Notes"
                value={formData.notes || ''}
                onChangeText={(text) => setFormData({ ...formData, notes: text })}
                placeholder="Free text notes (encrypted)"
                multiline={true}
              />

              {errorMsg && (
                <Banner type="error" message={errorMsg} style={{ marginBottom: spacing.md }} />
              )}

              <View style={styles.buttonsRow}>
                {currentIdx > 0 && (
                  <Button
                    label="← Previous Guest"
                    variant="secondary"
                    onPress={() => goToGuest(currentIdx - 1)}
                  />
                )}
                <Button
                  label={currentIdx === guestList.length - 1 ? 'Finish Later' : 'Skip for Now →'}
                  variant="secondary"
                  onPress={() =>
                    currentIdx === guestList.length - 1
                      ? router.replace(`/(app)/bookings/${id}` as any)
                      : goToGuest(currentIdx + 1)
                  }
                />
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
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  progressText: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold,
  },
  securityNotice: {
    fontSize: typography.xs,
    marginBottom: spacing.md,
  },
  formSection: {
    marginTop: spacing.sm,
  },
  badgeStrip: {
    padding: spacing.sm,
    borderRadius: 4,
    marginBottom: spacing.md,
  },
  badgeStripText: {
    fontSize: typography.sm,
  },
  buttonsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
});
