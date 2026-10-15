import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useThemeStore } from '../../../../src/state/themeStore';
import { Screen } from '../../../../src/ui/primitives/Screen';
import { Card } from '../../../../src/ui/primitives/Card';
import { Button } from '../../../../src/ui/primitives/Button';
import { Field } from '../../../../src/ui/primitives/Field';
import { Banner } from '../../../../src/ui/primitives/Banner';
import { Dialog } from '../../../../src/ui/primitives/Dialog';
import { spacing, typography } from '../../../../src/ui/tokens';
import { supabase } from '../../../../src/lib/supabase';
import { encryptReason } from '../../../../src/features/crypto-session/cryptoSession';
import type { Category, GuestDemand } from '@sms/core';

interface ParsedPayload {
  category: Category;
  checkIn: string;
  checkOut: string;
  guests: GuestDemand[];
  plan?: {
    kind: string;
    windows?: Array<{ checkIn: string; checkOut: string; roomsFree: number }>;
  };
}

export default function BookingAlternatesScreen() {
  const { payload } = useLocalSearchParams<{ payload: string }>();
  const router = useRouter();
  const colors = useThemeStore((s) => s.colors);

  const parsed: ParsedPayload = payload ? JSON.parse(payload) : null;
  const { category, checkIn, checkOut, guests, plan } = parsed || {
    category: 'LEAVE' as Category,
    checkIn: '',
    checkOut: '',
    guests: [],
    plan: { kind: 'NONE', windows: [] }
  };

  const windows = plan?.windows || [];
  const isPriority = category === 'MSA' || category === 'PI';

  // Denial state
  const [showDenyDialog, setShowDenyDialog] = useState(false);
  const [denyReason, setDenyReason] = useState('');
  const [denying, setDenying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleOpenEviction = () => {
    router.push({
      pathname: '/(app)/bookings/new/eviction',
      params: {
        payload: JSON.stringify({
          category,
          checkIn,
          checkOut,
          guests
        })
      }
    } as any);
  };

  const handleConfirmDenial = async () => {
    if (!denyReason.trim()) return;
    setDenying(true);
    setErrorMessage(null);
    try {
      const denialId = crypto.randomUUID();
      const reasonEnc = encryptReason('denials', 'reason_enc', denialId, denyReason.trim());

      const { error } = await supabase.rpc('record_denial', {
        p_category: category,
        p_check_in: checkIn,
        p_check_out: checkOut,
        p_party_size: guests.length,
        p_reason_enc: reasonEnc,
        p_key_version: 1
      });

      if (error) throw error;
      setShowDenyDialog(false);
      router.replace('/(app)' as any);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to record denial');
    } finally {
      setDenying(false);
    }
  };

  return (
    <Screen title="No Rooms Available" showBack={true}>
      <ScrollView contentContainerStyle={styles.container}>
        <Banner
          type="error"
          message={`Full House: No continuous rooms free between ${checkIn} and ${checkOut} for ${guests.length} guest(s).`}
        />

        {/* Section 1: Alternate Dates */}
        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.sectionTitle, { color: colors.navy }]}>
            NEXT AVAILABLE DATES
          </Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            The system scanned ahead 90 days for continuous windows that fit your guests.
          </Text>

          {windows.length === 0 ? (
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              No continuous alternate windows found in the next 90 days.
            </Text>
          ) : (
            windows.map((w, idx) => (
              <View key={idx} style={[styles.windowRow, { borderColor: colors.border }]}>
                <View>
                  <Text style={[styles.windowDates, { color: colors.text }]}>
                    {w.checkIn} → {w.checkOut}
                  </Text>
                  <Text style={[styles.windowRooms, { color: colors.muted }]}>
                    {w.roomsFree} room(s) free across this entire window
                  </Text>
                </View>
                <Button
                  label="Select Dates"
                  variant="secondary"
                  onPress={() => {
                    router.push({
                      pathname: '/(app)/bookings/new',
                      params: {
                        initialCheckIn: w.checkIn,
                        initialCheckOut: w.checkOut
                      }
                    } as any);
                  }}
                />
              </View>
            ))
          )}
        </Card>

        {/* Section 2: Priority Handling / Eviction or Denial */}
        <Card style={{ marginTop: spacing.md }}>
          <Text style={[styles.sectionTitle, { color: colors.navy }]}>RESOLUTION OPTIONS</Text>

          {isPriority ? (
            <View>
              <Banner
                type="warning"
                message={`${category} is a protected priority category. It cannot be denied. You may initiate an eviction review to displace lower-priority bookings.`}
              />
              <Button
                label="Proceed to Eviction Review"
                variant="primary"
                onPress={handleOpenEviction}
                style={{ marginTop: spacing.md }}
              />
            </View>
          ) : (
            <View>
              <Text style={[styles.bodyText, { color: colors.text }]}>
                Category {category} can be formally denied if alternate dates are not acceptable to the visitor.
              </Text>
              <Button
                label="Deny Request"
                variant="destructive"
                onPress={() => setShowDenyDialog(true)}
                style={{ marginTop: spacing.md }}
              />
            </View>
          )}

          {errorMessage && (
            <Banner
              type="error"
              message={errorMessage}
              style={{ marginTop: spacing.md }}
            />
          )}
        </Card>

        {/* Denial Dialog */}
        <Dialog
          visible={showDenyDialog}
          title="Record Denial"
          message={`Deny ${category} booking request for ${checkIn} to ${checkOut} (${guests.length} person(s)). Written reason is required and will be encrypted.`}
          confirmLabel="Confirm Denial"
          confirmVariant="destructive"
          onConfirm={handleConfirmDenial}
          onCancel={() => setShowDenyDialog(false)}
          loading={denying}
        >
          <Field
            label="Denial Reason (Encrypted)"
            value={denyReason}
            onChangeText={setDenyReason}
            placeholder="e.g. Full occupancy, visitor unable to shift stay dates"
            multiline={true}
          />
        </Dialog>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.md
  },
  sectionTitle: {
    fontSize: typography.base,
    fontWeight: typography.weights.bold
  },
  subtitle: {
    fontSize: typography.sm,
    marginVertical: spacing.xs
  },
  emptyText: {
    fontSize: typography.sm,
    fontStyle: 'italic',
    marginTop: spacing.sm
  },
  windowRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    marginTop: spacing.sm
  },
  windowDates: {
    fontSize: typography.sm,
    fontWeight: typography.weights.bold
  },
  windowRooms: {
    fontSize: typography.xs
  },
  bodyText: {
    fontSize: typography.sm,
    marginBottom: spacing.sm
  }
});
