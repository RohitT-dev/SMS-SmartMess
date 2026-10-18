import { guestRelation, type GuestDemand } from '@sms/core';
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

/** p_guests rows for create_booking / approve_eviction: seq, gender, rank (null for civilians), relation. */
export function guestRowsPayload(guests: GuestDemand[]) {
  return guests.map((g, idx) => ({
    seq: idx + 1,
    gender: g.gender,
    rank_code: g.rankCode,
    relation: guestRelation(g, idx),
  }));
}
