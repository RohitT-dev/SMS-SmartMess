import { describe, expect, it } from 'vitest';
import {
  bookingMatchesText,
  bookingSearchText,
  dateVariants,
  effectiveBookingStatus,
  extractPartySize,
  filterBookings,
  hasActiveFilters,
  rankCodesForText,
  searchTokens,
  stayOverlaps,
  type SearchableBooking,
} from './searchBookings';

const ROOMS = { r1: 'VIP Suite 1', r2: 'Room 12', r3: 'Locked' };

const sharma: SearchableBooking = {
  id: '3fa2b1c4-1111-4222-8333-444455556666',
  category: 'MFA',
  status: 'CONFIRMED',
  check_in: '2026-10-18',
  check_out: '2026-10-21',
  party_size: 2,
  booking_guests: [
    {
      id: 'g1',
      seq: 1,
      guest_code: 'GST-1053',
      guest_name: 'Rohit Sharma',
      rank_code: 'FLT_LT',
      relation: 'PRIMARY',
      unit: '12 Wing',
      service_number: '29482-K',
      phone: '+91 98765 43210',
    },
    { id: 'g2', seq: 2, guest_code: 'GST-1054', guest_name: 'Meera Sharma', rank_code: null, relation: 'SPOUSE' },
  ],
  allocations: [{ room_id: 'r1', status: 'ACTIVE' }],
};

const verma: SearchableBooking = {
  id: 'aaaa0000-1111-4222-8333-444455556666',
  category: 'PI',
  status: 'PENDING_ALLOTMENT',
  check_in: '2026-11-02',
  check_out: '2026-11-04',
  party_size: 1,
  booking_guests: [
    { id: 'g3', seq: 1, guest_code: 'GST-1060', guest_name: 'Anil Verma', rank_code: 'FO', relation: 'PRIMARY', unit: 'AF Stn Hindan' },
  ],
  allocations: [],
};

const gupta: SearchableBooking = {
  id: 'bbbb0000-1111-4222-8333-444455556666',
  category: 'LEAVE',
  status: 'CONFIRMED',
  check_in: '2026-09-01',
  check_out: '2026-09-03',
  party_size: 1,
  // CONFIRMED but holds no bed: the ledger shows it as pending allotment.
  booking_guests: [{ id: 'g4', seq: 1, guest_code: 'GST-1070', guest_name: 'Seema Gupta', rank_code: 'SQN_LDR', relation: 'PRIMARY' }],
  allocations: [{ room_id: 'r2', status: 'RELEASED' }],
};

const ALL_BOOKINGS = [sharma, verma, gupta];
const opts = { roomNames: ROOMS };
const find = (text: string, o = opts) => filterBookings(ALL_BOOKINGS, { text }, o).map((b) => b.id.slice(0, 4));

describe('rankCodesForText', () => {
  it('maps typed words to rank codes via the full labels', () => {
    expect(rankCodesForText('flight')).toEqual(['FLT_LT']);
    expect(rankCodesForText('flying')).toEqual(['FO']);
    expect(rankCodesForText('FO')).toContain('FO');
    expect(rankCodesForText('flt lt')).toEqual(['FLT_LT']);
    expect(rankCodesForText('squadron leader')).toEqual(['SQN_LDR']);
    expect(rankCodesForText('')).toEqual([]);
    expect(rankCodesForText('zzz')).toEqual([]);
  });
});

describe('dateVariants / searchTokens', () => {
  it('lists the ways a date is typed', () => {
    const v = dateVariants('2026-10-08');
    expect(v).toContain('2026-10-08');
    expect(v).toContain('08/10/2026');
    expect(v).toContain('08 oct 2026');
    expect(v).toContain('8 october 2026');
    expect(dateVariants('')).toEqual([]);
  });

  it('pads typed dates so 8/10/2026 and 18.10.2026 match the stored forms', () => {
    expect(searchTokens('8/10/2026')).toEqual(['08/10/2026']);
    expect(searchTokens('18.10.2026')).toEqual(['18/10/2026']);
    expect(searchTokens('  Flight   "Lieutenant" ')).toEqual(['flight', 'lieutenant']);
  });
});

describe('extractPartySize', () => {
  it('reads party size phrases and leaves the rest', () => {
    expect(extractPartySize('3 guests')).toEqual({ partySize: 3, rest: '' });
    expect(extractPartySize('party of 2 sharma')).toEqual({ partySize: 2, rest: 'sharma' });
    expect(extractPartySize('sharma 4 people')).toEqual({ partySize: 4, rest: 'sharma' });
    expect(extractPartySize('sharma')).toEqual({ partySize: null, rest: 'sharma' });
  });
});

describe('effectiveBookingStatus', () => {
  it('shows confirmed only when a bed is held', () => {
    expect(effectiveBookingStatus(sharma)).toBe('CONFIRMED');
    expect(effectiveBookingStatus(gupta)).toBe('PENDING_ALLOTMENT');
    expect(effectiveBookingStatus(verma)).toBe('PENDING_ALLOTMENT');
    expect(effectiveBookingStatus({ status: 'CANCELLED', allocations: [] })).toBe('CANCELLED');
  });
});

describe('text search', () => {
  it('finds a guest by name, partial name and across words', () => {
    expect(find('rohit')).toEqual(['3fa2']);
    expect(find('sharma')).toEqual(['3fa2']);
    expect(find('rohit sharma')).toEqual(['3fa2']);
    expect(find('SHARMA rohit')).toEqual(['3fa2']);
  });

  it('matches the full rank label and the code', () => {
    expect(find('flight lieutenant')).toEqual(['3fa2']);
    expect(find('flight')).toEqual(['3fa2']);
    expect(find('flying officer')).toEqual(['aaaa']);
    expect(find('flt_lt')).toEqual(['3fa2']);
    expect(find('flt lt')).toEqual(['3fa2']);
    expect(find('squadron')).toEqual(['bbbb']);
    expect(find('flight lieutenant sharma')).toEqual(['3fa2']);
    expect(find('flight lieutenant verma')).toEqual([]);
  });

  it('matches civilian companions by relation', () => {
    expect(find('spouse')).toEqual(['3fa2']);
    expect(find('civilian')).toEqual(['3fa2']);
    expect(find('meera')).toEqual(['3fa2']);
  });

  it('matches unit, service number, phone (with or without spaces) and guest code', () => {
    expect(find('12 wing')).toEqual(['3fa2']);
    expect(find('hindan')).toEqual(['aaaa']);
    expect(find('29482')).toEqual(['3fa2']);
    expect(find('98765')).toEqual(['3fa2']);
    expect(find('9876543210')).toEqual(['3fa2']);
    expect(find('gst-1060')).toEqual(['aaaa']);
    expect(find('1060')).toEqual(['aaaa']);
  });

  it('matches booking id fragments only when long enough to identify one', () => {
    expect(find('3fa2b1c4')).toEqual(['3fa2']);
    expect(find('bbbb0000')).toEqual(['bbbb']);
    // "ac" would be a hex digit pair in many ids; it must not match ids.
    expect(bookingMatchesText(sharma, 'cc')).toBe(false);
  });

  it('matches category code and name, and status words', () => {
    expect(find('mfa')).toEqual(['3fa2']);
    expect(find('posted in')).toEqual(['aaaa']);
    expect(find('leave')).toEqual(['bbbb']);
    expect(find('confirmed')).toEqual(['3fa2']);
    expect(find('pending')).toEqual(['aaaa', 'bbbb']);
    expect(find('pending allotment')).toEqual(['aaaa', 'bbbb']);
  });

  it('matches stay dates in ISO, DD/MM/YYYY and month-name forms', () => {
    expect(find('2026-10-18')).toEqual(['3fa2']);
    expect(find('2026-10-21')).toEqual(['3fa2']);
    expect(find('18/10/2026')).toEqual(['3fa2']);
    expect(find('18 oct')).toEqual(['3fa2']);
    expect(find('2 november 2026')).toEqual(['aaaa']);
    expect(find('2026-11')).toEqual(['aaaa']);
  });

  it('matches party size phrases exactly', () => {
    expect(find('2 guests')).toEqual(['3fa2']);
    expect(find('party of 1')).toEqual(['aaaa', 'bbbb']);
    expect(find('1 guest verma')).toEqual(['aaaa']);
  });

  it('matches decrypted room names, but not placeholders or released beds', () => {
    expect(find('vip suite')).toEqual(['3fa2']);
    expect(find('suite 1')).toEqual(['3fa2']);
    expect(find('locked')).toEqual([]);
    // gupta only has a RELEASED bed in Room 12: not its room by default, but it is for past bookings.
    expect(find('room 12')).toEqual([]);
    expect(find('room 12', { roomNames: ROOMS, allocationStatuses: ['ACTIVE', 'RELEASED'] } as never)).toEqual(['bbbb']);
  });

  it('returns everything for an empty query and honours server hits', () => {
    expect(find('')).toHaveLength(3);
    expect(find('   ')).toHaveLength(3);
    const hits = new Set([verma.id]);
    expect(filterBookings(ALL_BOOKINGS, { text: '5551-id-number' }, { ...opts, serverHitIds: hits }).map((b) => b.id.slice(0, 4))).toEqual([
      'aaaa',
    ]);
  });

  it('exposes one lower-cased searchable string per booking', () => {
    const text = bookingSearchText(sharma, opts);
    expect(text).toContain('flight lieutenant');
    expect(text).toContain('rohit sharma');
    expect(text).toContain('12 wing');
    expect(text).toBe(text.toLowerCase());
  });
});

describe('filters', () => {
  it('filters by category and effective status', () => {
    expect(filterBookings(ALL_BOOKINGS, { category: 'PI' }, opts)).toEqual([verma]);
    expect(filterBookings(ALL_BOOKINGS, { status: 'CONFIRMED' }, opts)).toEqual([sharma]);
    expect(filterBookings(ALL_BOOKINGS, { status: 'PENDING_ALLOTMENT' }, opts)).toEqual([verma, gupta]);
    expect(filterBookings(ALL_BOOKINGS, { status: 'ALL', category: 'ALL' }, opts)).toHaveLength(3);
  });

  it('filters by rank and by civilian companions', () => {
    expect(filterBookings(ALL_BOOKINGS, { rank: 'FO' }, opts)).toEqual([verma]);
    expect(filterBookings(ALL_BOOKINGS, { rank: 'FLT_LT' }, opts)).toEqual([sharma]);
    expect(filterBookings(ALL_BOOKINGS, { rank: 'CIVILIAN' }, opts)).toEqual([sharma]);
    expect(filterBookings(ALL_BOOKINGS, { rank: 'ALL' }, opts)).toHaveLength(3);
  });

  it('filters by room (active beds only)', () => {
    expect(filterBookings(ALL_BOOKINGS, { roomId: 'r1' }, opts)).toEqual([sharma]);
    expect(filterBookings(ALL_BOOKINGS, { roomId: 'r2' }, opts)).toEqual([]);
  });

  it('filters by stay overlap with both days included', () => {
    expect(stayOverlaps('2026-10-18', '2026-10-21', '2026-10-21', '2026-10-25')).toBe(true); // leaves at 12 PM that day
    expect(stayOverlaps('2026-10-18', '2026-10-21', '2026-10-22', '2026-10-25')).toBe(false);
    expect(stayOverlaps('2026-10-18', '2026-10-21', '2026-10-10', '2026-10-18')).toBe(true);
    expect(stayOverlaps('2026-10-18', '2026-10-21', '2026-10-10', '2026-10-17')).toBe(false);
    expect(stayOverlaps('2026-10-18', '2026-10-21', undefined, '2026-10-17')).toBe(false);
    expect(stayOverlaps('2026-10-18', '2026-10-21', '2026-10-30', undefined)).toBe(false);
    expect(stayOverlaps('2026-10-18', '2026-10-21')).toBe(true);
    expect(filterBookings(ALL_BOOKINGS, { dateFrom: '2026-10-01', dateTo: '2026-10-31' }, opts)).toEqual([sharma]);
    expect(filterBookings(ALL_BOOKINGS, { dateFrom: '2026-10-19' }, opts)).toEqual([sharma, verma]);
  });

  it('combines filters with text (all must hold)', () => {
    expect(filterBookings(ALL_BOOKINGS, { text: 'sharma', category: 'MFA', rank: 'FLT_LT' }, opts)).toEqual([sharma]);
    expect(filterBookings(ALL_BOOKINGS, { text: 'sharma', category: 'PI' }, opts)).toEqual([]);
  });

  it('reports whether anything is filtered', () => {
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ text: '  ', category: 'ALL', status: 'ALL', rank: 'ALL', roomId: 'ALL' })).toBe(false);
    expect(hasActiveFilters({ rank: 'FO' })).toBe(true);
    expect(hasActiveFilters({ dateFrom: '2026-10-01' })).toBe(true);
    expect(hasActiveFilters({ text: 'x' })).toBe(true);
  });
});
