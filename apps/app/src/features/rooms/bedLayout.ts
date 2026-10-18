import type { RoomAvailabilityStatus, RoomDayOccupant } from '@sms/core';

/** What one bed of a room looks like for one day. */
export type BedState =
  | { kind: 'free'; sharesWith?: RoomDayOccupant }
  | { kind: 'held'; by: RoomDayOccupant }
  | { kind: 'occupied'; occ: RoomDayOccupant }
  | { kind: 'closed' };

export interface BedEntry {
  slot: 1 | 2;
  state: BedState;
}

/** One room for one day, as daily_room_state returns it. */
export interface BedLayoutRoom {
  is_closed: boolean;
  occupants: RoomDayOccupant[] | null;
}

/** A booking that does not allow sharing holds its room. A missing flag (older rows) means it allows it. */
export const occupantAllowsSharing = (o: RoomDayOccupant): boolean => o.allowSharing !== false;

/**
 * True when the room has exactly one occupant and that occupant's booking keeps the room to its
 * own party: the empty bed is neither free nor bookable, so it is not shown at all.
 */
export function isHeldByExclusiveBooking(room: BedLayoutRoom): boolean {
  const occ = room.occupants ?? [];
  return !room.is_closed && occ.length === 1 && !occupantAllowsSharing(occ[0]);
}

/**
 * The beds to draw for a room:
 * - closed: both beds, out of service;
 * - a lone occupant of a booking that does not allow sharing: just that one bed (the booked
 *   entry), with no free second bed;
 * - otherwise both beds. An empty bed beside a ranked guest is free (any guest of the same gender
 *   may book it, whatever the rank); beside a civilian it is held for the civilian's own party.
 */
export function roomBedLayout(room: BedLayoutRoom): BedEntry[] {
  if (room.is_closed) {
    return [
      { slot: 1, state: { kind: 'closed' } },
      { slot: 2, state: { kind: 'closed' } },
    ];
  }
  const occ = room.occupants ?? [];
  const at = (slot: 1 | 2) => occ.find((o) => o.bedSlot === slot);

  if (isHeldByExclusiveBooking(room)) {
    const only = occ[0];
    return [{ slot: only.bedSlot, state: { kind: 'occupied', occ: only } }];
  }

  return ([1, 2] as const).map((slot): BedEntry => {
    const here = at(slot);
    if (here) return { slot, state: { kind: 'occupied', occ: here } };
    const other = at(slot === 1 ? 2 : 1);
    if (!other) return { slot, state: { kind: 'free' } };
    // Beside a civilian only their own party may sleep.
    if (!other.rankCode) return { slot, state: { kind: 'held', by: other } };
    return { slot, state: { kind: 'free', sharesWith: other } };
  });
}

/**
 * Availability of a room for one day. A room held by a lone non-sharing booking counts as full:
 * it has no bookable bed left even though only one bed is occupied.
 */
export function roomAvailability(room: BedLayoutRoom & { beds_taken: number }): RoomAvailabilityStatus {
  if (room.is_closed) return 'out_of_service';
  if (room.beds_taken >= 2 || isHeldByExclusiveBooking(room)) return 'full';
  if (room.beds_taken === 1) return 'one_bed_free';
  return 'free';
}
