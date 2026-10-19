import { describe, expect, it } from 'vitest';
import {
  buildGuestReportRows,
  describeGuestReportFilters,
  filterGuestReportRows,
  parseStay,
  periodFetchWindow,
  stayStatus,
  type GuestReportFilters,
  type RawReportBooking,
  type ReportRoom,
} from './guestReport';
import { buildGuestReport } from './guestReportHtml';

const TODAY = '2026-10-20';
const XSS = `<script>alert('x')</script>`;

const rooms: Record<string, ReportRoom> = {
  'room-v1': { name: 'V-01', type: 'VIP' },
  'room-s1': { name: 'S-01', type: 'SEMI_VIP' },
  'room-n1': { name: 'N-01', type: 'NORMAL' },
};

function booking(id: string, over: Partial<RawReportBooking> & { guests?: RawReportBooking['booking_guests'] }): RawReportBooking {
  const { guests, ...rest } = over;
  return {
    id,
    category: 'MFA',
    status: 'CONFIRMED',
    check_in: '2026-10-18',
    check_out: '2026-10-22',
    booking_guests: guests ?? [
      { id: `${id}-g1`, seq: 1, gender: 'M', rank_code: 'WG_CDR', guest_name: `Officer ${id}`, unit: '12 Wing', service_number: `SN-${id}`, phone: '9800000000' },
    ],
    allocations: [
      { room_id: 'room-v1', guest_id: `${id}-g1`, bed_slot: 1, status: 'ACTIVE', stay: `[${rest.check_in ?? '2026-10-18'},${rest.check_out ?? '2026-10-22'})` },
    ],
    ...rest,
  };
}

const data: RawReportBooking[] = [
  // In house today, VIP, MFA, 12 Wing.
  booking('a', {}),
  // In house today, Semi VIP, PI, 3 Wing; two guests (officer + spouse) sharing the room.
  booking('b', {
    category: 'PI',
    guests: [
      { id: 'b-g1', seq: 1, gender: 'F', rank_code: 'SQN_LDR', guest_name: 'Asha Rao', unit: '3 Wing AF', service_number: '29482-K', phone: '9811111111' },
      { id: 'b-g2', seq: 2, gender: 'M', rank_code: null, relation: 'SPOUSE', guest_name: 'Vikram Rao', unit: '', phone: '' },
    ],
    allocations: [
      { room_id: 'room-s1', guest_id: 'b-g1', bed_slot: 1, status: 'ACTIVE', stay: '[2026-10-18,2026-10-22)' },
      { room_id: 'room-s1', guest_id: 'b-g2', bed_slot: 2, status: 'ACTIVE', stay: '[2026-10-18,2026-10-22)' },
    ],
  }),
  // Ended last week, still CONFIRMED (nothing marks bookings COMPLETED): a completed stay.
  booking('c', { category: 'LEAVE', check_in: '2026-10-10', check_out: '2026-10-13' }),
  // Cancelled, would have been in house today.
  booking('d', { status: 'CANCELLED', category: 'MFA', allocations: [{ room_id: 'room-v1', guest_id: 'd-g1', bed_slot: 2, status: 'RELEASED', stay: '[2026-10-18,2026-10-22)' }] }),
  // Upcoming, Normal room, TD.
  booking('e', { category: 'TD', check_in: '2026-11-01', check_out: '2026-11-03', allocations: [{ room_id: 'room-n1', guest_id: 'e-g1', bed_slot: 1, status: 'ACTIVE', stay: '[2026-11-01,2026-11-03)' }] }),
  // Suite booking whose room this clerk cannot see, and a guest with no bed.
  booking('f', { allocations: [{ room_id: 'room-hidden', guest_id: 'f-g1', bed_slot: 1, status: 'ACTIVE', stay: '[2026-10-18,2026-10-22)' }] }),
  booking('g', { category: 'PI', allocations: [] }),
];

const rows = buildGuestReportRows(data, { today: TODAY, rooms });
const names = (f: GuestReportFilters) => filterGuestReportRows(rows, f).map((r) => r.name);

describe('stay status', () => {
  it('derives completed / in house / upcoming from the dates, keeps cancelled', () => {
    expect(stayStatus('CONFIRMED', '2026-10-10', '2026-10-13', TODAY)).toBe('COMPLETED');
    expect(stayStatus('CONFIRMED', '2026-10-18', '2026-10-20', TODAY)).toBe('COMPLETED'); // leaves today
    expect(stayStatus('CONFIRMED', '2026-10-20', '2026-10-21', TODAY)).toBe('CURRENT');
    expect(stayStatus('CONFIRMED', '2026-10-21', '2026-10-22', TODAY)).toBe('UPCOMING');
    expect(stayStatus('COMPLETED', '2026-10-21', '2026-10-22', TODAY)).toBe('COMPLETED');
    expect(stayStatus('CANCELLED', '2026-10-10', '2026-10-13', TODAY)).toBe('CANCELLED');
    expect(stayStatus('DISPLACED', '2026-10-18', '2026-10-22', TODAY)).toBe('DISPLACED');
  });

  it('parses Postgres date ranges', () => {
    expect(parseStay('[2026-10-01,2026-10-05)')).toEqual({ from: '2026-10-01', to: '2026-10-05' });
    expect(parseStay('["2026-10-01","2026-10-05")')).toEqual({ from: '2026-10-01', to: '2026-10-05' });
    expect(parseStay('empty')).toBeNull();
    expect(parseStay(null)).toBeNull();
  });
});

describe('guest report rows', () => {
  it('has one row per guest with plain details, room, bed and room type', () => {
    expect(rows).toHaveLength(8);
    const asha = rows.find((r) => r.name === 'Asha Rao')!;
    expect(asha).toMatchObject({
      rank: 'Squadron Leader',
      unit: '3 Wing AF',
      serviceNumber: '29482-K',
      phone: '9811111111',
      room: 'S-01',
      bed: 1,
      roomType: 'SEMI_VIP',
      category: 'PI',
      status: 'CURRENT',
      gender: 'F',
    });
    const spouse = rows.find((r) => r.name === 'Vikram Rao')!;
    expect(spouse.rank).toBe('Spouse');
    expect(spouse.bed).toBe(2);
  });

  it('keeps the released bed of a cancelled booking, and marks hidden or missing rooms', () => {
    expect(rows.find((r) => r.bookingId === 'd')).toMatchObject({ room: 'V-01', bed: 2, status: 'CANCELLED' });
    expect(rows.find((r) => r.bookingId === 'f')).toMatchObject({ room: 'Room room', roomType: null });
    expect(rows.find((r) => r.bookingId === 'g')).toMatchObject({ room: '', bed: null, roomType: null });
  });

  it('shows the bed held on the chosen day when a guest moved rooms', () => {
    const moved = booking('m', {
      allocations: [
        { room_id: 'room-v1', guest_id: 'm-g1', bed_slot: 1, status: 'RELEASED', stay: '[2026-10-18,2026-10-20)' },
        { room_id: 'room-n1', guest_id: 'm-g1', bed_slot: 2, status: 'ACTIVE', stay: '[2026-10-20,2026-10-22)' },
      ],
    });
    expect(buildGuestReportRows([moved], { today: TODAY, rooms, day: '2026-10-19' })[0].room).toBe('V-01');
    expect(buildGuestReportRows([moved], { today: TODAY, rooms, day: '2026-10-21' })[0].room).toBe('N-01');
    expect(buildGuestReportRows([moved], { today: TODAY, rooms })[0].room).toBe('N-01');
  });

  it('falls back to decrypted PII for guests saved before plain columns existed', () => {
    const legacy = booking('l', { guests: [{ id: 'l-g1', seq: 1, gender: 'M', rank_code: 'FO', guest_code: 'GST-1' }] });
    const pii = new Map([['l-g1', { name: 'Legacy Name', unit: '7 Wing', serviceNumber: 'L-1', phone: '99' }]]);
    expect(buildGuestReportRows([legacy], { today: TODAY, rooms, piiByGuestId: pii })[0]).toMatchObject({
      name: 'Legacy Name',
      unit: '7 Wing',
      serviceNumber: 'L-1',
      phone: '99',
    });
  });
});

describe('guest report filters', () => {
  it('everyone in VIP rooms today', () => {
    expect(names({ period: { mode: 'day', day: TODAY }, roomTypes: ['VIP'] })).toEqual(['Officer a']);
  });

  it('in house on a day leaves out cancelled, ended and upcoming stays, whatever the status chips say', () => {
    const inHouse = names({ period: { mode: 'day', day: TODAY }, statuses: ['CANCELLED'] });
    expect(inHouse).toEqual(['Officer a', 'Asha Rao', 'Vikram Rao', 'Officer f', 'Officer g']);
    expect(names({ period: { mode: 'day', day: '2026-10-11' } })).toEqual(['Officer c']);
  });

  it('all MFA guests, in any status', () => {
    expect(names({ period: { mode: 'all' }, categories: ['MFA'] }).sort()).toEqual(['Officer a', 'Officer d', 'Officer f']);
  });

  it('all guests from a unit, case- and space-insensitive part match', () => {
    expect(names({ period: { mode: 'all' }, unit: '  3   wing ' })).toEqual(['Asha Rao']);
    expect(names({ period: { mode: 'all' }, unit: '12 wing' })).toHaveLength(6);
  });

  it('a date range includes every stay overlapping it (both days included)', () => {
    expect(names({ period: { mode: 'range', from: '2026-10-13', to: '2026-10-17' } })).toEqual([]);
    expect(names({ period: { mode: 'range', from: '2026-10-12', to: '2026-10-12' } })).toEqual(['Officer c']);
    expect(names({ period: { mode: 'range', from: '2026-11-01', to: '2026-11-30' } })).toEqual(['Officer e']);
  });

  it('status: completed stays include confirmed bookings that have ended', () => {
    expect(names({ period: { mode: 'all' }, statuses: ['COMPLETED'] })).toEqual(['Officer c']);
    expect(names({ period: { mode: 'all' }, statuses: ['CANCELLED'] })).toEqual(['Officer d']);
    expect(names({ period: { mode: 'all' }, statuses: ['CURRENT', 'UPCOMING'] })).toHaveLength(6);
  });

  it('combines filters, plus gender and rank', () => {
    expect(names({ period: { mode: 'day', day: TODAY }, categories: ['PI'], roomTypes: ['SEMI_VIP'], gender: 'M' })).toEqual([
      'Vikram Rao',
    ]);
    expect(names({ period: { mode: 'all' }, rankCodes: ['SQN_LDR'] })).toEqual(['Asha Rao']);
    // Room type filter drops guests without a visible room.
    expect(names({ period: { mode: 'all' }, roomTypes: ['VIP', 'SEMI_VIP', 'NORMAL', 'SUITE'] })).toHaveLength(6);
  });

  it('orders by room type, room and bed, unallotted guests last', () => {
    const order = filterGuestReportRows(rows, { period: { mode: 'day', day: TODAY } }).map((r) => `${r.roomType}:${r.room}:${r.bed}`);
    expect(order).toEqual(['VIP:V-01:1', 'SEMI_VIP:S-01:1', 'SEMI_VIP:S-01:2', 'null:Room room:1', 'null::null']);
  });

  it('fetch window covers the period', () => {
    const add = (d: string, n: number) => `${d}+${n}`;
    expect(periodFetchWindow({ mode: 'all' }, add)).toBeNull();
    expect(periodFetchWindow({ mode: 'day', day: TODAY }, add)).toEqual({ from: TODAY, toExclusive: `${TODAY}+1` });
    expect(periodFetchWindow({ mode: 'range', from: 'a', to: 'b' }, add)).toEqual({ from: 'a', toExclusive: 'b+1' });
  });

  it('describes the active filters for the header', () => {
    expect(
      describeGuestReportFilters({
        period: { mode: 'day', day: TODAY },
        roomTypes: ['VIP', 'SEMI_VIP'],
        categories: ['MFA'],
        unit: ' 12 Wing ',
        statuses: ['CANCELLED'],
        gender: 'F',
        rankCodes: ['WG_CDR'],
      }),
    ).toEqual([
      { label: 'In house on', value: TODAY },
      { label: 'Room type', value: 'VIP, Semi VIP' },
      { label: 'Category', value: 'MFA (BA MFA)' },
      { label: 'Unit contains', value: '"12 Wing"' },
      { label: 'Gender', value: 'Female' },
      { label: 'Rank', value: 'Wing Commander' },
    ]);
    expect(describeGuestReportFilters({ period: { mode: 'all' }, statuses: ['COMPLETED'] })).toEqual([
      { label: 'Period', value: 'All dates' },
      { label: 'Status', value: 'Completed' },
    ]);
  });
});

describe('guest report document', () => {
  const generatedAt = new Date(2026, 9, 20, 9, 5);
  const filters: GuestReportFilters = { period: { mode: 'day', day: TODAY }, roomTypes: ['VIP', 'SEMI_VIP'] };
  const listed = filterGuestReportRows(rows, filters);
  const doc = buildGuestReport({
    rows: listed,
    filters: describeGuestReportFilters(filters),
    messName: 'Residential Officers Mess',
    generatedBy: 'clerk@example.mil',
    generatedAt,
  });

  it('lists only the filtered guests with every column', () => {
    for (const header of ['Name', 'Rank / Relation', 'Unit', 'Service No.', 'Phone', 'Room / Bed', 'Room type', 'Cat.', 'Check-in', 'Check-out', 'Status']) {
      expect(doc.html).toContain(`>${header}</th>`);
    }
    expect(doc.html).toContain('Asha Rao');
    expect(doc.html).toContain('Squadron Leader');
    expect(doc.html).toContain('29482-K');
    expect(doc.html).toContain('9811111111');
    expect(doc.html).toContain('S-01 (Bed 2)');
    expect(doc.html).toContain('Semi VIP');
    expect(doc.html).toContain('In house');
    expect(doc.html).not.toContain('Officer c');
    expect(doc.html).not.toContain('Officer d');
    expect(doc.html).not.toContain('Officer g');
  });

  it('puts the active filters and the count in the header', () => {
    expect(doc.html).toContain('Guest Report');
    expect(doc.html).toContain('3 guests - In house on 2026-10-20; Room type VIP, Semi VIP');
    expect(doc.html).toContain('<strong>In house on:</strong> 2026-10-20');
    expect(doc.html).toContain('<strong>Room type:</strong> VIP, Semi VIP');
    expect(doc.html).toMatch(/Guests listed<\/span><span class="mh-value">3</);
    expect(doc.kind).toBe('guest_report');
    expect(doc.orientation).toBe('landscape');
    expect(doc.fileName).toBe('Guest-Report_2026-10-20');
    expect(doc.audit).toEqual({
      action: 'guest_report_exported',
      entity: 'bookings',
      meta: { total_records: 3, filter: 'In house on, Room type', pages: 1 },
    });
  });

  it('escapes guest data and filter text', () => {
    const evil = buildGuestReport({
      rows: [{ ...listed[0], name: XSS, unit: XSS, phone: XSS, room: XSS }],
      filters: [{ label: 'Unit contains', value: XSS }],
      generatedAt,
    });
    expect(evil.html).not.toContain('<script>');
    expect(evil.html).toContain('&lt;script&gt;');
  });

  it('says so when nothing matches, and paginates long lists', () => {
    const empty = buildGuestReport({ rows: [], filters: [], generatedAt });
    expect(empty.html).toContain('No guests match these filters.');
    expect(empty.html).toContain('None - every guest');
    expect(empty.pageCount).toBe(1);

    const many = Array.from({ length: 120 }, (_, i) => ({ ...listed[0], guestId: `g${i}`, name: `Guest ${i}` }));
    const long = buildGuestReport({ rows: many, filters: [], generatedAt });
    expect(long.pageCount).toBeGreaterThan(2);
    expect(long.html).toContain(`Page ${long.pageCount} of ${long.pageCount}`);
    for (let i = 0; i < 120; i++) expect(long.html).toContain(`>Guest ${i}<`);
  });
});
