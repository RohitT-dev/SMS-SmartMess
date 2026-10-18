/**
 * Data loading for reports (Supabase + decrypted PII fallback). The mapping lives in the pure
 * modules (pastBookingItems.ts, gridGuests.ts); this file only fetches.
 */
import { supabase } from '../../lib/supabase';
import { decryptGuestPii } from '../crypto-session/cryptoSession';
import type { GuestPiiLike } from '../bookings/guestDisplay';
import type { GridGuestRow } from './gridGuests';
import {
  buildPastBookingItems,
  type RawPastBooking,
} from './pastBookingItems';
import type { PastBookingPdfItem } from './pastBookingsHtml';

const CHUNK = 60;

function chunked<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Decrypted PII for guests that lack plain columns. Best effort: a locked session or a missing
 * permission just means the fallback is empty.
 */
export async function fetchPiiFallback(guestIds: string[]): Promise<Map<string, GuestPiiLike>> {
  const map = new Map<string, GuestPiiLike>();
  for (const ids of chunked(guestIds)) {
    try {
      const { data, error } = await supabase.from('guest_pii').select('guest_id, pii_enc').in('guest_id', ids);
      if (error) continue;
      for (const row of data ?? []) {
        if (!row.pii_enc) continue;
        try {
          const dec = decryptGuestPii(row.guest_id, row.pii_enc);
          map.set(row.guest_id, { name: dec.name, unit: dec.unit, serviceNumber: dec.serviceNumber, phone: dec.phone });
        } catch {
          // Session locked or key mismatch: skip this guest.
        }
      }
    } catch {
      // Offline or not permitted.
    }
  }
  return map;
}

export interface PastBookingsQuery {
  /** Local calendar date; bookings are "past" when they ended on/before it or are completed/cancelled. */
  today: string;
  /** Optional stay window (inclusive start, exclusive end) to restrict the register to a period. */
  from?: string;
  toExclusive?: string;
  roomNames?: Record<string, string>;
}

export async function fetchPastBookingItems({
  today,
  from,
  toExclusive,
  roomNames,
}: PastBookingsQuery): Promise<PastBookingPdfItem[]> {
  let query = supabase
    .from('bookings')
    .select('*, booking_guests(*), allocations(*)')
    .or(`check_out.lte.${today},status.in.(COMPLETED,CANCELLED)`);
  if (from) query = query.gt('check_out', from);
  if (toExclusive) query = query.lt('check_in', toExclusive);
  const { data, error } = await query.order('check_out', { ascending: false });
  if (error) throw error;

  const bookings = (data ?? []) as RawPastBooking[];
  const nameless = bookings
    .flatMap((b) => b.booking_guests ?? [])
    .filter((g) => !g.guest_name?.trim())
    .map((g) => g.id);
  const piiByGuestId = nameless.length > 0 ? await fetchPiiFallback(nameless) : undefined;
  return buildPastBookingItems(bookings, { piiByGuestId, roomNames });
}

export interface GridGuestData {
  guests: GridGuestRow[];
  pii: Map<string, GuestPiiLike>;
}

/** Guests of the given bookings, to attach names/units to the room grid. */
export async function fetchGridGuests(bookingIds: string[]): Promise<GridGuestData> {
  const guests: GridGuestRow[] = [];
  for (const ids of chunked(bookingIds)) {
    const { data, error } = await supabase
      .from('booking_guests')
      .select('id, booking_id, seq, guest_code, guest_name, unit, service_number, phone, rank_code, relation')
      .in('booking_id', ids);
    if (error) throw error;
    guests.push(...((data ?? []) as GridGuestRow[]));
  }
  const nameless = guests.filter((g) => !g.guest_name?.trim()).map((g) => g.id);
  const pii = nameless.length > 0 ? await fetchPiiFallback(nameless) : new Map<string, GuestPiiLike>();
  return { guests, pii };
}
