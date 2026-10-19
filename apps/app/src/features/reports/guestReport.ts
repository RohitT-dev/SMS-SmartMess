/**
 * Custom guest report: one row per guest (not per booking), filtered by room type, category,
 * unit, dates, status, gender and rank. Pure - the data is fetched in reportData.ts - so the
 * mapping and the filters can be unit-tested.
 *
 * Status is derived from the dates, because nothing marks a booking COMPLETED when the guest
 * leaves: a CONFIRMED booking whose check-out has passed is a completed stay.
 */
import {
  CATEGORIES,
  RANKS,
  type Category,
  type Gender,
  type RankCode,
  type RoomType,
} from '@sms/core';
import {
  guestName,
  guestPhone,
  guestRankOrRelation,
  guestServiceNumber,
  guestUnit,
  type GuestLike,
  type GuestPiiLike,
} from '../bookings/guestDisplay';

export interface RawReportGuest extends GuestLike {
  id: string;
  seq: number;
  gender?: Gender | string | null;
}

export interface RawReportAllocation {
  room_id: string;
  guest_id?: string | null;
  bed_slot: number;
  status: string;
  /** Postgres daterange text, e.g. "[2026-10-01,2026-10-05)". */
  stay?: string | null;
}

export interface RawReportBooking {
  id: string;
  category: string;
  status: string;
  check_in: string;
  check_out: string;
  booking_guests?: RawReportGuest[];
  allocations?: RawReportAllocation[];
}

export interface ReportRoom {
  name?: string;
  type?: RoomType | string | null;
}

/** Where a stay stands on `today`. */
export type StayStatus = 'UPCOMING' | 'CURRENT' | 'COMPLETED' | 'CANCELLED' | 'DISPLACED';

export const STAY_STATUS_LABELS: Record<StayStatus, string> = {
  UPCOMING: 'Upcoming',
  CURRENT: 'In house',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  DISPLACED: 'Displaced',
};

export const ROOM_TYPE_LABELS: Record<RoomType, string> = {
  VIP: 'VIP',
  SEMI_VIP: 'Semi VIP',
  NORMAL: 'Normal',
  SUITE: 'Suite',
};

export interface GuestReportRow {
  /** booking_guests.id */
  guestId: string;
  bookingId: string;
  seq: number;
  name: string;
  /** Full rank, or the relation ("Spouse") for civilians. */
  rank: string;
  rankCode: string | null;
  gender: string | null;
  unit: string;
  serviceNumber: string;
  phone: string;
  /** Room name, or '' when no bed is allotted (or the room is hidden from this user). */
  room: string;
  bed: number | null;
  roomType: string | null;
  category: string;
  checkIn: string;
  /** Exclusive: the day the guest leaves. */
  checkOut: string;
  bookingStatus: string;
  status: StayStatus;
}

export function stayStatus(bookingStatus: string, checkIn: string, checkOut: string, today: string): StayStatus {
  if (bookingStatus === 'CANCELLED' || bookingStatus === 'DISPLACED') return bookingStatus;
  if (bookingStatus === 'COMPLETED' || checkOut <= today) return 'COMPLETED';
  if (checkIn > today) return 'UPCOMING';
  return 'CURRENT';
}

/** "[2026-10-01,2026-10-05)" -> { from, to } (to exclusive). Null for anything else. */
export function parseStay(stay: string | null | undefined): { from: string; to: string } | null {
  const m = /^[[(]\s*"?(\d{4}-\d{2}-\d{2})"?\s*,\s*"?(\d{4}-\d{2}-\d{2})"?\s*[\])]$/.exec(stay ?? '');
  return m ? { from: m[1], to: m[2] } : null;
}

const ALLOCATION_RANK: Record<string, number> = { ACTIVE: 0, RELEASED: 1, EVICTED: 2 };

/**
 * The allocation to show for a guest: one covering `day` if given, else the live one, else the
 * most recent released one (a cancelled or ended stay).
 */
function pickAllocation(allocations: RawReportAllocation[], day?: string): RawReportAllocation | undefined {
  const ordered = [...allocations].sort((a, b) => {
    const r = (ALLOCATION_RANK[a.status] ?? 9) - (ALLOCATION_RANK[b.status] ?? 9);
    if (r !== 0) return r;
    return (parseStay(b.stay)?.from ?? '').localeCompare(parseStay(a.stay)?.from ?? '');
  });
  if (day) {
    const covering = ordered.find((al) => {
      const s = parseStay(al.stay);
      return s && s.from <= day && day < s.to && al.status !== 'EVICTED';
    });
    if (covering) return covering;
  }
  return ordered[0];
}

export interface GuestReportRowOptions {
  today: string;
  /** Room id -> decrypted name and type. Rooms this user cannot see (suites for clerks) are absent. */
  rooms?: Record<string, ReportRoom>;
  /** Decrypted PII keyed by booking_guests.id - only a fallback for rows without plain columns. */
  piiByGuestId?: Map<string, GuestPiiLike>;
  /** Prefer the bed held on this day (the "in house on" report). */
  day?: string;
}

export function buildGuestReportRows(
  bookings: RawReportBooking[],
  { today, rooms, piiByGuestId, day }: GuestReportRowOptions,
): GuestReportRow[] {
  const rows: GuestReportRow[] = [];
  for (const b of bookings) {
    const guests = [...(b.booking_guests ?? [])].sort((x, y) => x.seq - y.seq);
    const allocations = b.allocations ?? [];
    const status = stayStatus(b.status, b.check_in, b.check_out, today);
    guests.forEach((g, i) => {
      const pii = piiByGuestId?.get(g.id);
      const own = allocations.filter((al) => al.guest_id === g.id);
      const al = pickAllocation(own, day);
      const room = al ? rooms?.[al.room_id] : undefined;
      rows.push({
        guestId: g.id,
        bookingId: b.id,
        seq: g.seq,
        name: guestName(g, pii, i),
        rank: guestRankOrRelation(g),
        rankCode: g.rank_code ? String(g.rank_code) : null,
        gender: g.gender ? String(g.gender) : null,
        unit: guestUnit(g, pii),
        serviceNumber: guestServiceNumber(g, pii),
        phone: guestPhone(g, pii),
        room: al ? (room?.name ?? `Room ${al.room_id.slice(0, 4)}`) : '',
        bed: al ? al.bed_slot : null,
        roomType: room?.type ? String(room.type) : null,
        category: b.category,
        checkIn: b.check_in,
        checkOut: b.check_out,
        bookingStatus: b.status,
        status,
      });
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type GuestReportPeriod =
  | { mode: 'all' }
  /** Stays overlapping from..to, both days included. */
  | { mode: 'range'; from: string; to: string }
  /** Guests in house on this day (stay covers it, not cancelled or displaced). */
  | { mode: 'day'; day: string };

export interface GuestReportFilters {
  period: GuestReportPeriod;
  /** Empty = any. */
  roomTypes?: RoomType[];
  categories?: Category[];
  /** Case-insensitive part of the unit. */
  unit?: string;
  /** Empty = any. Ignored for the "in house on" period, which only lists live stays. */
  statuses?: StayStatus[];
  gender?: Gender | null;
  rankCodes?: RankCode[];
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function matchesGuestReportFilters(row: GuestReportRow, f: GuestReportFilters): boolean {
  const p = f.period;
  if (p.mode === 'range' && !(row.checkIn <= p.to && row.checkOut > p.from)) return false;
  if (p.mode === 'day') {
    if (!(row.checkIn <= p.day && p.day < row.checkOut)) return false;
    if (row.status === 'CANCELLED' || row.status === 'DISPLACED') return false;
  }
  if (p.mode !== 'day' && f.statuses?.length && !f.statuses.includes(row.status)) return false;
  if (f.roomTypes?.length && !(row.roomType && (f.roomTypes as string[]).includes(row.roomType))) return false;
  if (f.categories?.length && !(f.categories as string[]).includes(row.category)) return false;
  const unit = normalize(f.unit ?? '');
  if (unit && !normalize(row.unit).includes(unit)) return false;
  if (f.gender && row.gender !== f.gender) return false;
  if (f.rankCodes?.length && !(row.rankCode && (f.rankCodes as string[]).includes(row.rankCode))) return false;
  return true;
}

/** Filtered rows, ordered by room type, room, bed, then check-in and name. */
export function filterGuestReportRows(rows: GuestReportRow[], f: GuestReportFilters): GuestReportRow[] {
  const typeOrder = (t: string | null) => {
    const i = ['VIP', 'SEMI_VIP', 'NORMAL', 'SUITE'].indexOf(t ?? '');
    return i < 0 ? 9 : i;
  };
  return rows
    .filter((r) => matchesGuestReportFilters(r, f))
    .sort(
      (a, b) =>
        typeOrder(a.roomType) - typeOrder(b.roomType) ||
        // Unallotted guests last within their type.
        Number(!a.room) - Number(!b.room) ||
        a.room.localeCompare(b.room, undefined, { numeric: true }) ||
        (a.bed ?? 9) - (b.bed ?? 9) ||
        a.checkIn.localeCompare(b.checkIn) ||
        a.name.localeCompare(b.name),
    );
}

/** The date window to fetch for a period (inclusive from, exclusive to); null = no limit. */
export function periodFetchWindow(p: GuestReportPeriod, addDays: (d: string, n: number) => string) {
  if (p.mode === 'range') return { from: p.from, toExclusive: addDays(p.to, 1) };
  if (p.mode === 'day') return { from: p.day, toExclusive: addDays(p.day, 1) };
  return null;
}

/** Human labels for the active filters, for the report header ("Room type: VIP, Semi VIP"). */
export function describeGuestReportFilters(f: GuestReportFilters): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const p = f.period;
  if (p.mode === 'day') out.push({ label: 'In house on', value: p.day });
  else if (p.mode === 'range') out.push({ label: 'Stays between', value: `${p.from} to ${p.to}` });
  else out.push({ label: 'Period', value: 'All dates' });
  if (f.roomTypes?.length) {
    out.push({ label: 'Room type', value: f.roomTypes.map((t) => ROOM_TYPE_LABELS[t] ?? t).join(', ') });
  }
  if (f.categories?.length) {
    out.push({
      label: 'Category',
      value: f.categories.map((c) => (CATEGORIES[c] ? `${c} (${CATEGORIES[c].name})` : c)).join(', '),
    });
  }
  if (f.unit?.trim()) out.push({ label: 'Unit contains', value: `"${f.unit.trim()}"` });
  if (p.mode !== 'day' && f.statuses?.length) {
    out.push({ label: 'Status', value: f.statuses.map((s) => STAY_STATUS_LABELS[s]).join(', ') });
  }
  if (f.gender) out.push({ label: 'Gender', value: f.gender === 'M' ? 'Male' : 'Female' });
  if (f.rankCodes?.length) {
    out.push({
      label: 'Rank',
      value: f.rankCodes.map((c) => RANKS.find((r) => r.code === c)?.label ?? c).join(', '),
    });
  }
  return out;
}
