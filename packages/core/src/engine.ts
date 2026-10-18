import type {
  AllotmentResult,
  AlternateWindow,
  BookingPlanRequest,
  EvictionCandidate,
  GuestDemand,
  PlannedAssignment,
  RoomDayState
} from './types.ts';
import type { Gender, GuestRelation, RankCode, RoomType, VisitorCategory } from './constants.ts';
import { CATEGORIES } from './constants.ts';

export type RoomAvailabilityStatus = 'free' | 'one_bed_free' | 'full' | 'out_of_service';

/**
 * Calculates single-day room availability status.
 */
export function roomStatus(state: RoomDayState): RoomAvailabilityStatus {
  if (state.isClosed) return 'out_of_service';
  if (state.bedsTaken === 0) return 'free';
  if (state.bedsTaken === 1) return 'one_bed_free';
  return 'full';
}

/**
 * Checks whether category A can displace category B.
 * Rules:
 * - MFA may displace PI, LEAVE, TD.
 * - PI may displace LEAVE, TD.
 * - LEAVE and TD never displace anyone.
 * - Nobody displaces MFA.
 */
export function canDisplace(incomingCategory: VisitorCategory, existingCategory: VisitorCategory): boolean {
  if (incomingCategory === 'MFA') {
    return existingCategory === 'PI' || existingCategory === 'LEAVE' || existingCategory === 'TD';
  }
  if (incomingCategory === 'PI') {
    return existingCategory === 'LEAVE' || existingCategory === 'TD';
  }
  return false;
}

/**
 * Date range helpers for half-open interval [checkIn, checkOut).
 */
export function getDatesBetween(checkIn: string, checkOut: string): string[] {
  const dates: string[] = [];
  const start = new Date(checkIn + 'T00:00:00Z');
  const end = new Date(checkOut + 'T00:00:00Z');

  const curr = new Date(start);
  while (curr < end) {
    dates.push(curr.toISOString().split('T')[0]);
    curr.setUTCDate(curr.getUTCDate() + 1);
  }
  return dates;
}

export interface SharingPerson {
  gender: Gender;
  /** Null for civilians. */
  rankCode: RankCode | null;
  /** The booking the person belongs to; unknown (undefined) for a booking not yet created. */
  bookingId?: string;
}

/**
 * Room sharing rule (mirrors trigger_enforce_sharing_rule):
 * - two ranked people share only with the same gender and rank, across any bookings;
 * - a civilian shares only with members of their own booking (any gender or rank).
 */
export function canShareRoom(a: SharingPerson, b: SharingPerson): boolean {
  if (a.rankCode && b.rankCode) return a.gender === b.gender && a.rankCode === b.rankCode;
  return a.bookingId !== undefined && a.bookingId === b.bookingId;
}

/** A guest's relation, filling in the default for callers that leave it out. */
export function guestRelation(g: GuestDemand, index: number): GuestRelation {
  if (g.relation) return g.relation;
  if (!g.rankCode) return 'OTHER';
  return index === 0 ? 'PRIMARY' : 'SERVICE';
}

type IndexedGuest = GuestDemand & { guestIndex: number };

/**
 * Groups a party into room pairs and singles:
 * 1. the primary with their spouse;
 * 2. ranked guests of the same gender and rank;
 * 3. each remaining ranked guest with a civilian of the party;
 * 4. remaining civilians with each other.
 */
export function pairParty(guests: GuestDemand[]): {
  pairs: Array<[IndexedGuest, IndexedGuest]>;
  singles: IndexedGuest[];
} {
  const all = guests.map((g, idx) => ({ ...g, guestIndex: idx }));
  let ranked = all.filter((g) => g.rankCode);
  const civilians = all.filter((g) => !g.rankCode);
  const pairs: Array<[IndexedGuest, IndexedGuest]> = [];
  const singles: IndexedGuest[] = [];

  const primary = ranked.find((g) => guestRelation(g, g.guestIndex) === 'PRIMARY');
  const spouseIdx = civilians.findIndex((c) => c.relation === 'SPOUSE');
  if (primary && spouseIdx !== -1) {
    pairs.push([primary, civilians.splice(spouseIdx, 1)[0]]);
    ranked = ranked.filter((g) => g !== primary);
  }

  const grouped = new Map<string, IndexedGuest[]>();
  for (const g of ranked) {
    const key = `${g.gender}-${g.rankCode}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(g);
  }
  const rankedSingles: IndexedGuest[] = [];
  for (const list of grouped.values()) {
    while (list.length >= 2) pairs.push([list.shift()!, list.shift()!]);
    if (list.length === 1) rankedSingles.push(list.shift()!);
  }
  rankedSingles.sort((a, b) => a.guestIndex - b.guestIndex);

  for (const s of rankedSingles) {
    const companion = civilians.shift();
    if (companion) pairs.push([s, companion]);
    else singles.push(s);
  }
  while (civilians.length >= 2) pairs.push([civilians.shift()!, civilians.shift()!]);
  if (civilians.length === 1) singles.push(civilians.shift()!);

  return { pairs, singles };
}

interface RoomIntervalSummary {
  roomId: string;
  roomType: RoomType;
  displayOrder: number;
  isClosed: boolean;
  // Over the entire interval:
  bed1Free: boolean;
  bed2Free: boolean;
  // Occupant in the other bed if exactly one bed is taken throughout the interval
  bed1Occupant?: SharingPerson;
  bed2Occupant?: SharingPerson;
}

function summarizeRoomsForInterval(
  states: RoomDayState[],
  stayDates: string[]
): Map<string, RoomIntervalSummary> {
  const roomMap = new Map<string, RoomIntervalSummary>();

  for (const s of states) {
    if (!stayDates.includes(s.date)) continue;

    let summary = roomMap.get(s.roomId);
    if (!summary) {
      summary = {
        roomId: s.roomId,
        roomType: s.roomType,
        displayOrder: s.displayOrder,
        isClosed: false,
        bed1Free: true,
        bed2Free: true
      };
      roomMap.set(s.roomId, summary);
    }

    if (s.isClosed) {
      summary.isClosed = true;
      summary.bed1Free = false;
      summary.bed2Free = false;
    }

    if (s.bedsTaken >= 2) {
      summary.bed1Free = false;
      summary.bed2Free = false;
    } else if (s.bedsTaken === 1 && s.occupants.length === 0) {
      summary.bed1Free = false;
    }

    for (const occ of s.occupants) {
      if (occ.bedSlot === 1) {
        summary.bed1Free = false;
        summary.bed1Occupant = { gender: occ.gender, rankCode: occ.rankCode, bookingId: occ.bookingId };
      }
      if (occ.bedSlot === 2) {
        summary.bed2Free = false;
        summary.bed2Occupant = { gender: occ.gender, rankCode: occ.rankCode, bookingId: occ.bookingId };
      }
    }
  }

  return roomMap;
}

/**
 * Deterministic Allotment Engine.
 *
 * Implements:
 * 1. Respect preferredRoomType first; if it cannot fit, mark usedFallbackType and try other non-suite types.
 * 2. Pair guests of the same booking into one room (see pairParty: primary + spouse, same gender
 *    and rank, ranked guest + civilian, civilians together).
 * 3. Use whole free rooms for the rest.
 * 4. Use compatible partial rooms (shareable beds) only when whole rooms run out.
 * 5. Never return a Suite (Suites are managed via a dedicated Admin screen).
 * 6. Free rooms are free for the whole stay [check_in, check_out).
 */
export function planAllotment(request: BookingPlanRequest, states: RoomDayState[]): AllotmentResult {
  const stayDates = getDatesBetween(request.checkIn, request.checkOut);
  if (stayDates.length === 0) {
    throw new Error('Check-out must be after check-in');
  }

  // 1. Group the party into room pairs and singles
  const { pairs, singles } = pairParty(request.guests);

  const roomSummaries = Array.from(summarizeRoomsForInterval(states, stayDates).values())
    // Suites are NEVER offered by the standard allotment engine
    .filter((r) => r.roomType !== 'SUITE' && !r.isClosed)
    .sort((a, b) => a.displayOrder - b.displayOrder);

  const preferredType =
    request.preferredRoomType && request.preferredRoomType !== 'SUITE'
      ? request.preferredRoomType
      : undefined;

  if (request.preferSharing) {
    // Shared rooms first, across every room type; the preferred type only orders the choices.
    const ordered = [...roomSummaries].sort(
      (a, b) =>
        Number(b.roomType === preferredType) - Number(a.roomType === preferredType) ||
        a.displayOrder - b.displayOrder
    );
    const shared = tryAssignRooms(pairs, singles, ordered, true);
    if (shared) {
      return {
        kind: 'ALLOT',
        assignments: shared,
        usedFallbackType: Boolean(preferredType && shared.some((a) => a.roomType !== preferredType))
      };
    }
  } else {
    // Attempt plan with preferred room type first if specified
    if (preferredType) {
      const preferredRooms = roomSummaries.filter((r) => r.roomType === preferredType);
      const result = tryAssignRooms(pairs, singles, preferredRooms);
      if (result) {
        return {
          kind: 'ALLOT',
          assignments: result,
          usedFallbackType: false
        };
      }
    }

    // Attempt across all non-suite room types
    const fullResult = tryAssignRooms(pairs, singles, roomSummaries);
    if (fullResult) {
      return {
        kind: 'ALLOT',
        assignments: fullResult,
        usedFallbackType: Boolean(preferredType)
      };
    }
  }

  // If nothing fits for these dates, compute alternates or check eviction / denial
  const alternates = findAlternateWindows(request, states, 5, 90);
  if (alternates.length > 0) {
    return {
      kind: 'ALTERNATES',
      windows: alternates
    };
  }

  const catMeta = CATEGORIES[request.category];
  return {
    kind: 'NONE',
    canDeny: catMeta.canBeDenied,
    canEvict: !catMeta.canBeDenied
  };
}

function tryAssignRooms(
  pairs: Array<[IndexedGuest, IndexedGuest]>,
  singles: IndexedGuest[],
  availableRooms: RoomIntervalSummary[],
  preferSharing = false
): PlannedAssignment[] | null {
  const assignments: PlannedAssignment[] = [];
  const roomPool = availableRooms.map((r) => ({ ...r }));

  // 1. Assign pairs to whole free rooms (bed 1 and bed 2 free)
  for (const [p1, p2] of pairs) {
    const freeRoomIdx = roomPool.findIndex((r) => r.bed1Free && r.bed2Free);
    if (freeRoomIdx === -1) {
      // Cannot fit all pairs into whole rooms
      return null;
    }
    const r = roomPool[freeRoomIdx];
    r.bed1Free = false;
    r.bed2Free = false;
    assignments.push(
      { guestIndex: p1.guestIndex, roomId: r.roomId, roomType: r.roomType, bedSlot: 1 },
      { guestIndex: p2.guestIndex, roomId: r.roomId, roomType: r.roomType, bedSlot: 2 }
    );
  }

  // 2. Assign remaining singles. Default: a whole free room first, a compatible shared bed only
  // when whole rooms run out. With preferSharing the order flips: shared beds first.
  const findShared = (s: GuestDemand) =>
    roomPool.findIndex((r) => {
      if (r.bed1Free && !r.bed2Free && r.bed2Occupant) return canShareRoom(r.bed2Occupant, s);
      if (r.bed2Free && !r.bed1Free && r.bed1Occupant) return canShareRoom(r.bed1Occupant, s);
      return false;
    });
  const findWhole = () => roomPool.findIndex((r) => r.bed1Free && r.bed2Free);

  const seatShared = (s: IndexedGuest, idx: number) => {
    const r = roomPool[idx];
    const bedSlot: 1 | 2 = r.bed1Free ? 1 : 2;
    if (bedSlot === 1) r.bed1Free = false;
    else r.bed2Free = false;
    assignments.push({ guestIndex: s.guestIndex, roomId: r.roomId, roomType: r.roomType, bedSlot });
  };
  const seatWhole = (s: IndexedGuest, idx: number) => {
    const r = roomPool[idx];
    r.bed1Free = false;
    // Record the lone occupant so bed 2 stays open to a compatible guest.
    r.bed1Occupant = { gender: s.gender, rankCode: s.rankCode };
    assignments.push({ guestIndex: s.guestIndex, roomId: r.roomId, roomType: r.roomType, bedSlot: 1 });
  };

  for (const s of singles) {
    if (preferSharing) {
      const sharedIdx = findShared(s);
      if (sharedIdx !== -1) {
        seatShared(s, sharedIdx);
        continue;
      }
      const wholeIdx = findWhole();
      if (wholeIdx === -1) return null;
      seatWhole(s, wholeIdx);
    } else {
      const wholeIdx = findWhole();
      if (wholeIdx !== -1) {
        seatWhole(s, wholeIdx);
        continue;
      }
      const sharedIdx = findShared(s);
      if (sharedIdx === -1) return null;
      seatShared(s, sharedIdx);
    }
  }

  return assignments;
}

/**
 * Searches up to `maxDaysAhead` days ahead for `limit` alternate windows of the same stay length.
 */
export function findAlternateWindows(
  request: BookingPlanRequest,
  states: RoomDayState[],
  limit = 5,
  maxDaysAhead = 90
): AlternateWindow[] {
  const stayLength = getDatesBetween(request.checkIn, request.checkOut).length;
  if (stayLength === 0) return [];

  const windows: AlternateWindow[] = [];
  const startDate = new Date(request.checkIn + 'T00:00:00Z');

  for (let offset = 1; offset <= maxDaysAhead && windows.length < limit; offset++) {
    const altStart = new Date(startDate);
    altStart.setUTCDate(altStart.getUTCDate() + offset);
    const altEnd = new Date(altStart);
    altEnd.setUTCDate(altEnd.getUTCDate() + stayLength);

    const altCheckIn = altStart.toISOString().split('T')[0];
    const altCheckOut = altEnd.toISOString().split('T')[0];

    const altStayDates = getDatesBetween(altCheckIn, altCheckOut);
    const altSummaries = Array.from(summarizeRoomsForInterval(states, altStayDates).values()).filter(
      (r) => r.roomType !== 'SUITE' && !r.isClosed
    );

    const { pairs, singles } = pairParty(request.guests);

    const result = tryAssignRooms(pairs, singles, altSummaries, request.preferSharing);
    if (result) {
      const wholeRoomsFree = altSummaries.filter((r) => r.bed1Free && r.bed2Free).length;
      windows.push({
        checkIn: altCheckIn,
        checkOut: altCheckOut,
        roomsFree: wholeRoomsFree
      });
    }
  }

  return windows;
}

/**
 * Eviction candidate ranking hook.
 *
 * NOTE / TODO(ranking):
 * The ranking rule is deliberately deferred. Leave a clear TODO(ranking) and
 * return candidates in a stable, deterministic order.
 */
export function rankCandidates(candidates: EvictionCandidate[]): EvictionCandidate[] {
  // TODO(ranking): Implement complex priority weighting once policy is finalized.
  // Currently returns candidates in stable order (by days stayed descending, then room code).
  return [...candidates].sort((a, b) => {
    if (b.daysStayed !== a.daysStayed) {
      return b.daysStayed - a.daysStayed;
    }
    const byRoom = a.roomCode.localeCompare(b.roomCode, undefined, { numeric: true });
    return byRoom !== 0 ? byRoom : a.bedSlot - b.bedSlot;
  });
}
