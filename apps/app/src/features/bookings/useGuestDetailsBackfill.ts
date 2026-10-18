import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { useSessionStore } from '../../state/sessionStore';
import { decryptGuestPii, getActiveKeyVersion } from '../crypto-session/cryptoSession';
import { runGuestDetailsBackfill } from './guestDetailsBackfill';

/** Queries that show guest names, ranks or units and must refetch after the backfill wrote them. */
const REFRESH_KEYS = [
  'bookings_ledger',
  'past_bookings_list',
  'pending_booking_requests',
  'booking_record',
  'booking_guests_to_fill',
];

// One run per app session (a reload or a new sign-in starts a new one).
let startedForSession = false;

/**
 * Once the access code has unlocked the session, an administrator's device copies the names, units,
 * service numbers and phone numbers of existing guests out of their encrypted records into the
 * plain columns, so names show everywhere. Runs in the background; never blocks the UI, never
 * surfaces an error, never logs a value. Other roles do nothing: the first administrator to open
 * the app fills it in for everyone.
 */
export function useGuestDetailsBackfill(): void {
  const isUnlocked = useSessionStore((s) => s.isUnlocked);
  const userRole = useSessionStore((s) => s.userRole);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isUnlocked || userRole !== 'admin' || startedForSession) return;

    // Let the first screen render and load before spending any time on this.
    const timer = setTimeout(() => {
      if (startedForSession) return;
      startedForSession = true;
      runGuestDetailsBackfill({
        client: supabase,
        keyVersion: getActiveKeyVersion(),
        decrypt: (guestId, piiEnc) => decryptGuestPii(guestId, piiEnc),
      })
        .then((result) => {
          if (result.filled === 0) return;
          for (const key of REFRESH_KEYS) queryClient.invalidateQueries({ queryKey: [key] });
        })
        .catch(() => {
          // Best effort: try again on the next session.
          startedForSession = false;
        });
    }, 1500);

    return () => {
      clearTimeout(timer);
    };
  }, [isUnlocked, userRole, queryClient]);
}
