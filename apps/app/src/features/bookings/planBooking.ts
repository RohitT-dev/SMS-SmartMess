import { guestRelation, pairParty, type GuestDemand } from '@sms/core';
import { addDaysToDateString } from '../../lib/dates';

/** findAlternateWindows() scans this many days ahead of the requested check-in. */
export const ALTERNATE_HORIZON_DAYS = 90;

/**
 * Exclusive end date of the room-state range the engine needs to look for alternate windows:
 * the last candidate window starts at check-in + 90 days and lasts as long as the stay, so it
 * ends at check-out + 90 days. The engine only sees the dates it is given, so a range that stops
 * at the requested check-out can never produce alternates.
 */
export function alternatesHorizonEnd(checkOut: string): string {
  return addDaysToDateString(checkOut, ALTERNATE_HORIZON_DAYS);
}

/** p_guests rows for create_booking / approve_eviction: seq, gender, rank (null for civilians), relation, plus any contact details. */
export function guestRowsPayload(
  guests: Array<
    GuestDemand & {
      name?: string | null;
      serviceNumber?: string | null;
      unit?: string | null;
      phone?: string | null;
    }
  >,
) {
  return guests.map((g, idx) => ({
    seq: idx + 1,
    gender: g.gender,
    rank_code: g.rankCode,
    relation: guestRelation(g, idx),
    guest_name: g.name || null,
    service_number: g.serviceNumber || null,
    unit: g.unit || null,
    phone: g.phone || null,
  }));
}

export interface FreedBed {
  /** The evicted allocation this bed came from. */
  allocationId: string;
  roomId: string;
  bedSlot: 1 | 2;
}

export interface SeatedGuest {
  guestIndex: number;
  bed: FreedBed;
}

/**
 * Seats an incoming party on the beds an eviction frees. People who belong in one room (a primary
 * and spouse, two ranked guests of the same gender and rank, a ranked guest and a civilian of the
 * party) are put into a room whose two beds are both freed; only when no such room is left are
 * they split. Returns null when there are fewer beds than guests.
 */
export function seatPartyOnBeds(guests: GuestDemand[], beds: FreedBed[]): SeatedGuest[] | null {
  if (beds.length < guests.length) return null;
  const remaining = [...beds];
  const seated: SeatedGuest[] = [];
  const take = (guestIndex: number, bed: FreedBed) => {
    remaining.splice(remaining.indexOf(bed), 1);
    seated.push({ guestIndex, bed });
  };

  const { pairs, singles } = pairParty(guests);
  const loose = [...singles];
  for (const [a, b] of pairs) {
    const byRoom = new Map<string, FreedBed[]>();
    for (const bed of remaining) byRoom.set(bed.roomId, [...(byRoom.get(bed.roomId) ?? []), bed]);
    const wholeRoom = [...byRoom.values()].find((list) => list.length >= 2);
    if (wholeRoom) {
      take(a.guestIndex, wholeRoom[0]);
      take(b.guestIndex, wholeRoom[1]);
    } else {
      loose.push(a, b);
    }
  }
  loose.sort((x, y) => x.guestIndex - y.guestIndex);
  for (const g of loose) take(g.guestIndex, remaining[0]);

  return seated.sort((x, y) => x.guestIndex - y.guestIndex);
}
