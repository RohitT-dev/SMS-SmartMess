import { CATEGORIES, RANKS, RELATION_LABELS, type GuestRelation, type RankCode, type VisitorCategory } from '@sms/core';
import { humanizeStatus } from '../../lib/labels';
import { rankLabel, realGuestName, type GuestLike } from './guestDisplay';

/**
 * Pure search and filter logic for the booking ledger and the past-bookings register.
 *
 * Everything a clerk can read on a booking row is searchable: guest name, full rank ("flight
 * lieutenant"), unit, service number, phone, guest code, booking id, category, status words,
 * stay dates (ISO, DD/MM/YYYY, "18 Oct"), party size ("3 guests") and the room names (which are
 * encrypted in the database, so they are matched here, after decryption).
 */

export interface SearchableAllocation {
  room_id: string;
  status: string;
}

export interface SearchableBooking {
  id: string;
  category: string;
  status: string;
  check_in: string;
  check_out: string;
  party_size?: number | null;
  booking_guests?: Array<GuestLike & { id?: string }> | null;
  allocations?: SearchableAllocation[] | null;
}

export type RoomNames = Record<string, string> | null | undefined;

export interface MatchOptions {
  /** Room id -> decrypted name. */
  roomNames?: RoomNames;
  /** Which allocation statuses count as "the room of this booking" (default: ACTIVE only). */
  allocationStatuses?: readonly string[];
  /** Booking ids the server search already matched (e.g. an exact ID-number hit). */
  serverHitIds?: ReadonlySet<string> | null;
}

export interface BookingFilters {
  text?: string;
  /** Category code or 'ALL'. */
  category?: string;
  /** Effective status (see effectiveBookingStatus) or 'ALL'. */
  status?: string;
  /** A rank code, 'CIVILIAN' (booking has a civilian companion) or 'ALL'. */
  rank?: string;
  /** Room id or 'ALL'. */
  roomId?: string;
  /** YYYY-MM-DD; the stay must overlap [dateFrom, dateTo], both days included. */
  dateFrom?: string;
  dateTo?: string;
}

export const ALL = 'ALL';
export const CIVILIAN = 'CIVILIAN';

/** Room names that are not real names (locked session, failed decryption, still loading). */
const PLACEHOLDER_ROOM_NAMES = new Set(['Locked', 'Decryption Error', '…']);

const MONTHS = [
  ['jan', 'january'],
  ['feb', 'february'],
  ['mar', 'march'],
  ['apr', 'april'],
  ['may', 'may'],
  ['jun', 'june'],
  ['jul', 'july'],
  ['aug', 'august'],
  ['sep', 'september'],
  ['oct', 'october'],
  ['nov', 'november'],
  ['dec', 'december'],
] as const;

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();

/**
 * What the ledger shows as a booking's status: cancelled / displaced / completed as stored, and
 * otherwise "Pending allotment" until a bed is actually held, "Confirmed" once one is.
 */
export function effectiveBookingStatus(b: Pick<SearchableBooking, 'status' | 'allocations'> | null | undefined): string {
  if (!b) return 'PENDING_ALLOTMENT';
  if (b.status === 'CANCELLED' || b.status === 'DISPLACED' || b.status === 'COMPLETED') return b.status;
  if (b.status === 'PENDING_ALLOTMENT') return 'PENDING_ALLOTMENT';
  const hasBed = (b.allocations ?? []).some((a) => a.status === 'ACTIVE');
  return hasBed ? 'CONFIRMED' : 'PENDING_ALLOTMENT';
}

/** "2026-10-18" -> the ways a clerk might type it: 2026-10-18, 18/10/2026, 18-10-2026, 18 oct 2026, 18 october 2026. */
export function dateVariants(iso: string | null | undefined): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return [];
  const [, y, mo, d] = m;
  const monthIdx = Number(mo) - 1;
  const names = MONTHS[monthIdx];
  if (!names) return [`${y}-${mo}-${d}`];
  const dayNoPad = String(Number(d));
  return [
    `${y}-${mo}-${d}`,
    `${d}/${mo}/${y}`,
    `${d}-${mo}-${y}`,
    `${d} ${names[0]} ${y}`,
    `${d} ${names[1]} ${y}`,
    `${dayNoPad} ${names[0]} ${y}`,
    `${dayNoPad} ${names[1]} ${y}`,
  ];
}

/** Rank codes whose code or full label contains the text: "flight" -> FLT_LT, "fo" / "flying" -> FO. */
export function rankCodesForText(text: string): RankCode[] {
  const q = lower(text).trim().replace(/\s+/g, ' ');
  if (!q) return [];
  return RANKS.filter((r) => {
    const code = r.code.toLowerCase();
    return code.includes(q) || code.replace(/_/g, ' ').includes(q) || r.label.toLowerCase().includes(q);
  }).map((r) => r.code);
}

/** "party of 3", "3 guests", "2 people" -> the party size, and the query without that phrase. */
export function extractPartySize(query: string): { partySize: number | null; rest: string } {
  const patterns = [
    /\bparty\s*(?:of|size|:)?\s*(\d{1,2})\b/i,
    /\b(\d{1,2})\s*(?:guests?|people|persons?|pax|members?|occupants?)\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(query);
    if (m) {
      return { partySize: Number(m[1]), rest: (query.slice(0, m.index) + ' ' + query.slice(m.index + m[0].length)).trim() };
    }
  }
  return { partySize: null, rest: query.trim() };
}

/** Lower-cased search words. Typed dates ("8/10/2026", "18.10.2026") are put in the padded DD/MM/YYYY form. */
export function searchTokens(query: string): string[] {
  return lower(query)
    .split(/\s+/)
    .map((t) => t.replace(/^["']+|["']+$/g, ''))
    .filter(Boolean)
    .map((t) => {
      const m = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})$/.exec(t);
      if (!m) return t;
      const sep = m[2] === '.' ? '/' : m[2];
      return `${m[1].padStart(2, '0')}${sep}${m[3].padStart(2, '0')}${sep}${m[4]}`;
    });
}

function guestTexts(g: GuestLike & { id?: string }): string[] {
  const out: string[] = [];
  const add = (v: string | null | undefined) => {
    const s = lower(v).trim();
    if (s) out.push(s);
  };
  add(realGuestName(g.guest_name));
  add(g.guest_code);
  add(g.unit);
  add(g.service_number);
  add(g.phone);
  const digits = (g.phone ?? '').replace(/\D/g, '');
  if (digits) out.push(digits);
  if (g.rank_code) {
    add(g.rank_code);
    add(String(g.rank_code).replace(/_/g, ' '));
    add(rankLabel(g.rank_code));
  } else {
    // Civilian companions: their relation ("Spouse", "Child"), and the word "civilian".
    add(RELATION_LABELS[(g.relation as GuestRelation) ?? 'OTHER']);
    out.push('civilian');
  }
  return out;
}

/** Everything searchable about a booking, lower-cased, one entry per line. */
export function bookingSearchText(b: SearchableBooking, opts: MatchOptions = {}): string {
  const statuses = opts.allocationStatuses ?? ['ACTIVE'];
  const parts: string[] = [];
  const cat = CATEGORIES[b.category as VisitorCategory];
  parts.push(lower(b.category), lower(cat?.name));
  const effective = effectiveBookingStatus(b);
  parts.push(lower(humanizeStatus(effective)), lower(effective.replace(/_/g, ' ')));
  parts.push(...dateVariants(b.check_in), ...dateVariants(b.check_out));
  const size = b.party_size ?? b.booking_guests?.length ?? 0;
  if (size > 0) parts.push(`party of ${size}`, `party size ${size}`, `${size} guest${size === 1 ? '' : 's'}`);

  const roomNames = opts.roomNames;
  if (roomNames) {
    for (const a of b.allocations ?? []) {
      if (!statuses.includes(a.status)) continue;
      const name = roomNames[a.room_id];
      if (name && !PLACEHOLDER_ROOM_NAMES.has(name)) parts.push(lower(name));
    }
  }
  for (const g of b.booking_guests ?? []) parts.push(...guestTexts(g));
  return parts.join('\n');
}

function idMatches(id: string, token: string): boolean {
  // Short fragments such as "ac" are hex digits in nearly every id; only longer ones identify a booking.
  return token.length >= 4 && /^[0-9a-f-]+$/.test(token) && id.toLowerCase().includes(token);
}

/** True when every word of the query is found on the booking (words may match different fields). */
export function bookingMatchesText(b: SearchableBooking, query: string, opts: MatchOptions = {}): boolean {
  const q = query.trim();
  if (!q) return true;
  if (opts.serverHitIds?.has(b.id)) return true;

  const { partySize, rest } = extractPartySize(q);
  if (partySize !== null) {
    const size = b.party_size ?? b.booking_guests?.length ?? 0;
    if (size !== partySize) return false;
  }
  const tokens = searchTokens(rest);
  if (tokens.length === 0) return true;
  const hay = bookingSearchText(b, opts);
  return tokens.every((t) => hay.includes(t) || idMatches(b.id, t));
}

export function bookingMatchesRank(b: SearchableBooking, rank: string): boolean {
  if (!rank || rank === ALL) return true;
  const guests = b.booking_guests ?? [];
  if (rank === CIVILIAN) return guests.some((g) => !g.rank_code);
  return guests.some((g) => g.rank_code === rank);
}

export function bookingMatchesRoom(b: SearchableBooking, roomId: string, statuses: readonly string[] = ['ACTIVE']): boolean {
  if (!roomId || roomId === ALL) return true;
  return (b.allocations ?? []).some((a) => a.room_id === roomId && statuses.includes(a.status));
}

/** The stay [check_in, check_out] touches [from, to]; either bound may be empty (open ended). */
export function stayOverlaps(checkIn: string, checkOut: string, from?: string, to?: string): boolean {
  if (from && checkOut < from) return false;
  if (to && checkIn > to) return false;
  return true;
}

export function hasActiveFilters(f: BookingFilters): boolean {
  return Boolean(
    f.text?.trim() ||
      (f.category && f.category !== ALL) ||
      (f.status && f.status !== ALL) ||
      (f.rank && f.rank !== ALL) ||
      (f.roomId && f.roomId !== ALL) ||
      f.dateFrom ||
      f.dateTo,
  );
}

export function filterBookings<T extends SearchableBooking>(list: readonly T[], f: BookingFilters, opts: MatchOptions = {}): T[] {
  const statuses = opts.allocationStatuses ?? ['ACTIVE'];
  return list.filter((b) => {
    if (f.category && f.category !== ALL && b.category !== f.category) return false;
    if (f.status && f.status !== ALL && effectiveBookingStatus(b) !== f.status) return false;
    if (!bookingMatchesRank(b, f.rank ?? ALL)) return false;
    if (!bookingMatchesRoom(b, f.roomId ?? ALL, statuses)) return false;
    if (!stayOverlaps(b.check_in, b.check_out, f.dateFrom, f.dateTo)) return false;
    return bookingMatchesText(b, f.text ?? '', opts);
  });
}
