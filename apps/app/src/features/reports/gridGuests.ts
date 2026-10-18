/**
 * daily_room_state only returns guest codes and rank codes. These helpers attach the real name,
 * full rank, unit and service number (read from booking_guests) to each grid occupant.
 * Pure - the guest rows are fetched elsewhere.
 */
import {
  guestRankOrRelation,
  guestServiceNumber,
  guestUnit,
  type GuestLike,
  type GuestPiiLike,
} from '../bookings/guestDisplay';
import type { GridPdfDayState, GridPdfOccupant } from './gridHtml';

export interface GridGuestRow extends GuestLike {
  id: string;
  booking_id: string;
}

/** Real name if the guest has one on file; undefined otherwise (never a "Guest (GST-...)" label). */
function knownName(g: GridGuestRow, pii?: GuestPiiLike | null): string | undefined {
  return g.guest_name?.trim() || pii?.name?.trim() || undefined;
}

export function enrichOccupant(
  occ: GridPdfOccupant,
  byCode: Map<string, GridGuestRow>,
  pii?: Map<string, GuestPiiLike>,
): GridPdfOccupant {
  const g = occ.guestCode ? byCode.get(occ.guestCode) : undefined;
  if (!g) return occ;
  const p = pii?.get(g.id);
  return {
    ...occ,
    guestName: knownName(g, p),
    rankText: guestRankOrRelation(g) || undefined,
    unit: guestUnit(g, p) || undefined,
    serviceNumber: guestServiceNumber(g, p) || undefined,
    rankCode: occ.rankCode ?? g.rank_code ?? undefined,
    relation: occ.relation ?? g.relation ?? undefined,
  };
}

export function enrichDayStates(
  dayStates: GridPdfDayState[],
  guests: GridGuestRow[],
  pii?: Map<string, GuestPiiLike>,
): GridPdfDayState[] {
  if (guests.length === 0) return dayStates;
  const byCode = new Map<string, GridGuestRow>();
  for (const g of guests) if (g.guest_code) byCode.set(g.guest_code, g);
  return dayStates.map((s) =>
    s.occupants && s.occupants.length > 0
      ? { ...s, occupants: s.occupants.map((o) => enrichOccupant(o, byCode, pii)) }
      : s,
  );
}

/** Distinct booking ids across all occupants, sorted so the list is a stable cache key. */
export function occupantBookingIds(dayStates: GridPdfDayState[] | undefined): string[] {
  const ids = new Set<string>();
  for (const s of dayStates ?? []) for (const o of s.occupants ?? []) if (o.bookingId) ids.add(o.bookingId);
  return Array.from(ids).sort();
}

/** Short stable cache key for a list of ids (the list can run to hundreds of uuids). */
export function idsKey(ids: string[]): string {
  let hash = 5381;
  for (const id of ids) for (let i = 0; i < id.length; i++) hash = ((hash * 33) ^ id.charCodeAt(i)) >>> 0;
  return `${ids.length}:${hash.toString(36)}`;
}
