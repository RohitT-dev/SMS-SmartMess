/**
 * Turns bookings (with their guests and allocations) into rows for the past bookings register.
 * Pure - the data is fetched elsewhere - so it can be unit-tested.
 */
import {
  guestName,
  guestRankOrRelation,
  guestServiceNumber,
  guestUnit,
  type GuestLike,
  type GuestPiiLike,
} from '../bookings/guestDisplay';
import type { PastBookingGuestItem, PastBookingPdfItem } from './pastBookingsHtml';

export interface RawPastGuest extends GuestLike {
  id: string;
  seq: number;
}

export interface RawPastAllocation {
  id?: string;
  room_id: string;
  guest_id?: string | null;
  bed_slot: number;
  status: string;
}

export interface RawPastBooking {
  id: string;
  category: string;
  status: string;
  check_in: string;
  check_out: string;
  party_size: number;
  booking_guests?: RawPastGuest[];
  allocations?: RawPastAllocation[];
}

export interface PastBookingItemOptions {
  /** Decrypted PII keyed by booking_guests.id - only a fallback for rows without plain columns. */
  piiByGuestId?: Map<string, GuestPiiLike>;
  /** Room id -> decrypted room name. */
  roomNames?: Record<string, string>;
}

const DAY_MS = 86_400_000;

export function stayNights(checkIn: string, checkOut: string): number {
  return Math.max(1, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / DAY_MS));
}

export function buildPastBookingItems(
  bookings: RawPastBooking[],
  { piiByGuestId, roomNames }: PastBookingItemOptions = {},
): PastBookingPdfItem[] {
  const roomLabel = (roomId: string, bedSlot: number) =>
    `${roomNames?.[roomId] ?? `Room ${roomId.slice(0, 4)}`} (Bed ${bedSlot})`;

  return bookings.map((b) => {
    const guests = [...(b.booking_guests ?? [])].sort((a, c) => a.seq - c.seq);
    const allocations = (b.allocations ?? []).filter(
      (al) => al.status === 'ACTIVE' || al.status === 'RELEASED',
    );

    const guestItems: PastBookingGuestItem[] = guests.map((g, i) => {
      const pii = piiByGuestId?.get(g.id);
      const own = Array.from(
        new Set(allocations.filter((al) => al.guest_id === g.id).map((al) => roomLabel(al.room_id, al.bed_slot))),
      );
      return {
        name: guestName(g, pii, i),
        rank: guestRankOrRelation(g),
        unit: guestUnit(g, pii),
        serviceNumber: guestServiceNumber(g, pii),
        // Only set when allocations are tied to individual guests, so each guest shows their own room.
        rooms: allocations.some((al) => al.guest_id) ? own.join(', ') || '-' : undefined,
      };
    });

    const rooms = Array.from(new Set(allocations.map((al) => roomLabel(al.room_id, al.bed_slot)))).join(', ');
    const first = guestItems[0];

    return {
      id: b.id,
      category: b.category,
      checkIn: b.check_in,
      checkOut: b.check_out,
      nights: stayNights(b.check_in, b.check_out),
      partySize: b.party_size,
      status: b.status,
      guestName: first?.name ?? 'Guest',
      guestRank: first?.rank ?? '',
      serviceNumber: first?.serviceNumber || null,
      unit: first?.unit || null,
      rooms: rooms || 'None',
      guests: guestItems.length > 0 ? guestItems : undefined,
    };
  });
}
