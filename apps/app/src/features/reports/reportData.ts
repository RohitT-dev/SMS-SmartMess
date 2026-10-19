/**
 * Data loading for reports (Supabase + decrypted PII fallback). The mapping lives in the pure
 * modules (guestReport.ts, gridGuests.ts); this file only fetches.
 */
import { supabase } from '../../lib/supabase';
import { decryptGuestPii } from '../crypto-session/cryptoSession';
import type { GuestPiiLike } from '../bookings/guestDisplay';
import type { GridGuestRow } from './gridGuests';
import {
  buildGuestReportRows,
  type GuestReportRow,
  type RawReportBooking,
  type ReportRoom,
} from './guestReport';

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

export interface GuestReportQuery {
  today: string;
  /** Stay window (inclusive start, exclusive end); omit both for every booking. */
  from?: string;
  toExclusive?: string;
  rooms?: Record<string, ReportRoom>;
  /** Prefer the bed held on this day. */
  day?: string;
}

/**
 * Every guest of every booking overlapping the window, one row each, in any status. Filtering by
 * room type, category, unit etc. happens client-side (filterGuestReportRows) so the screen can
 * show a live count while the filters change.
 */
export async function fetchGuestReportRows({
  today,
  from,
  toExclusive,
  rooms,
  day,
}: GuestReportQuery): Promise<GuestReportRow[]> {
  let query = supabase
    .from('bookings')
    .select(
      'id, category, status, check_in, check_out, ' +
        'booking_guests(id, seq, gender, rank_code, relation, guest_code, guest_name, unit, service_number, phone), ' +
        'allocations(room_id, guest_id, bed_slot, status, stay)',
    )
    .is('deleted_at', null);
  if (from) query = query.gt('check_out', from);
  if (toExclusive) query = query.lt('check_in', toExclusive);
  const { data, error } = await query.order('check_in', { ascending: true });
  if (error) throw error;

  const bookings = (data ?? []) as unknown as RawReportBooking[];
  const nameless = bookings
    .flatMap((b) => b.booking_guests ?? [])
    .filter((g) => !g.guest_name?.trim())
    .map((g) => g.id);
  const piiByGuestId = nameless.length > 0 ? await fetchPiiFallback(nameless) : undefined;
  return buildGuestReportRows(bookings, { today, rooms, piiByGuestId, day });
}
