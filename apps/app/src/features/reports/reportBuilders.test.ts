import { describe, expect, it } from 'vitest';
import { reportInsights, type ReportDailyRow } from '@sms/core';
import { buildInsightsReport, buildOccupancyReport, niceAxis } from './occupancyHtml';
import { buildPastBookingsReport, buildPastBookingsHtml, type PastBookingPdfItem } from './pastBookingsHtml';
import {
  buildGridReport,
  dateRange,
  isRoomHeldExclusive,
  occupantLines,
  type GridPdfDayState,
  type GridPdfRoom,
} from './gridHtml';

const generatedAt = new Date(2026, 9, 18, 9, 5);
const common = { messName: 'Residential Officers Mess', generatedBy: 'clerk@example.mil', generatedAt };
const XSS = `<script>alert('x')</script>`;

/** Number of body rows (booking / date rows), not header rows. */
const bodyRows = (docHtml: string) => (docHtml.match(/<tbody>[\s\S]*?<\/tbody>/g) ?? []).join('').match(/<tr/g)?.length ?? 0;

function booking(i: number, over: Partial<PastBookingPdfItem> = {}): PastBookingPdfItem {
  return {
    id: `0000000${i}-aaaa-bbbb-cccc-dddddddddddd`.slice(-36).padStart(36, '0'),
    category: ['MFA', 'PI', 'LEAVE', 'TD'][i % 4],
    checkIn: '2026-10-01',
    checkOut: '2026-10-04',
    nights: 3,
    partySize: 1,
    status: 'COMPLETED',
    guestName: `Guest Number ${i}`,
    guestRank: 'WG_CDR',
    serviceNumber: `SN-${i}`,
    unit: `${i} Wing`,
    rooms: 'Room V-01 (Bed 1)',
    ...over,
  };
}

describe('past bookings report', () => {
  it('shows name, full rank, unit and service number as plain columns', () => {
    const doc = buildPastBookingsReport({
      ...common,
      bookings: [booking(1, { guestName: 'Rohit Tiwari', guestRank: 'FLT_LT', serviceNumber: '24567-K', unit: '12 Wing' })],
    });
    expect(doc.html).toContain('Rohit Tiwari');
    expect(doc.html).toContain('Flight Lieutenant');
    expect(doc.html).not.toContain('FLT_LT');
    expect(doc.html).toContain('12 Wing');
    expect(doc.html).toContain('24567-K');
    expect(doc.html).toContain('<th class="">Unit</th>');
    expect(doc.html).toContain('Service No.');
    expect(doc.html).not.toContain('Guest (GST');
  });

  it('keeps the register structure: masthead, KPI strip, header row, A4 landscape, page numbers', () => {
    const doc = buildPastBookingsReport({ ...common, bookings: [booking(1), booking(2)] });
    expect(doc.orientation).toBe('landscape');
    expect(doc.html).toContain('size: A4 landscape');
    expect(doc.html).toContain('Past Bookings Register');
    expect(doc.html).toContain('Residential Officers Mess');
    expect(doc.html).toContain('Total Past Stays');
    expect(doc.html).toContain('Total Nights Hosted');
    expect(doc.html).toContain('<thead>');
    expect(doc.html).toContain('Page 1 of 1');
    expect(doc.html).toContain('2026-10-18 09:05');
    expect(doc.html).toContain('clerk@example.mil');
    expect(doc.html).toContain('badge-mfa');
    expect(doc.html).toContain('badge-pi');
  });

  it('lists every guest of a multi-guest booking and keeps civilian relations', () => {
    const doc = buildPastBookingsReport({
      ...common,
      bookings: [
        booking(1, {
          partySize: 2,
          guests: [
            { name: 'Wing Commander A', rank: 'WG_CDR', unit: '1 Wing', serviceNumber: 'A-1', rooms: 'Room 1 (Bed 1)' },
            { name: 'Mrs A', rank: 'Spouse', unit: '', serviceNumber: '', rooms: 'Room 1 (Bed 2)' },
          ],
        }),
      ],
    });
    expect(doc.html).toContain('Wing Commander A');
    expect(doc.html).toContain('Mrs A');
    expect(doc.html).toContain('Spouse');
    expect(doc.html).toContain('Room 1 (Bed 2)');
    expect(doc.html).toContain('Total Past Stays');
    expect(doc.summary.kpis[2]).toEqual({ label: 'Guests Hosted', value: '2' });
  });

  it('escapes every dynamic field', () => {
    const doc = buildPastBookingsReport({
      ...common,
      title: `OFFICERS' MESS - ${XSS}`,
      filterLabel: XSS,
      bookings: [
        booking(1, { guestName: XSS, guestRank: XSS, unit: XSS, serviceNumber: XSS, rooms: XSS, status: XSS, category: 'MFA' }),
      ],
    });
    expect(doc.html).not.toContain('<script');
    expect(doc.html).toContain('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;');
    expect(doc.html).toContain('OFFICERS&#39; MESS');
  });

  it('paginates long registers without losing or splitting rows, repeating the header and numbering pages', () => {
    const bookings = Array.from({ length: 130 }, (_, i) => booking(i + 1));
    const doc = buildPastBookingsReport({ ...common, bookings });
    expect(doc.pageCount).toBeGreaterThan(3);
    const sheets = doc.html.match(/<section class="page">/g) ?? [];
    expect(sheets).toHaveLength(doc.pageCount);
    expect(doc.html).toContain(`Page ${doc.pageCount} of ${doc.pageCount}`);
    expect(doc.html.match(/class="mono">#/g)).toHaveLength(130);
    expect(bodyRows(doc.html)).toBe(130);
    // One repeated header row per page that carries rows.
    expect(doc.html.match(/<thead>/g)!.length).toBe(doc.pageCount);
  });

  it('wraps long names instead of truncating them', () => {
    const longName = 'Air Vice Marshal Venkatasubramanian Ramachandran Iyer-Krishnamurthy';
    const doc = buildPastBookingsReport({ ...common, bookings: [booking(1, { guestName: longName })] });
    expect(doc.html).toContain(longName);
  });

  it('handles an empty register and keeps the legacy html entry point', () => {
    const doc = buildPastBookingsReport({ ...common, bookings: [] });
    expect(doc.html).toContain('No past bookings found.');
    expect(buildPastBookingsHtml({ bookings: [booking(1)] })).toContain('Total Past Stays');
  });

  it('records an audit entry without personal data', () => {
    const doc = buildPastBookingsReport({ ...common, bookings: [booking(1)], filterLabel: 'MFA Category Stays' });
    expect(doc.audit.action).toBe('past_bookings_exported');
    expect(JSON.stringify(doc.audit)).not.toContain('Guest Number');
  });
});

describe('grid report', () => {
  const rooms: GridPdfRoom[] = Array.from({ length: 20 }, (_, i) => ({
    id: `r${i}`,
    name: `Room ${i + 1}`,
    roomType: i % 2 ? 'VIP' : 'NORMAL',
    displayOrder: i,
  }));
  const states: GridPdfDayState[] = [
    {
      room_id: 'r0',
      date: '2026-10-01',
      beds_taken: 2,
      is_closed: false,
      occupants: [
        {
          guestCode: 'GST-0001',
          category: 'MFA',
          bedSlot: 1,
          guestName: 'Rohit Tiwari',
          rankText: 'Flight Lieutenant',
          rankCode: 'FLT_LT',
          unit: '12 Wing',
          serviceNumber: '24567-K',
          checkIn: '2026-10-01',
          checkOut: '2026-10-03',
        },
        { guestCode: 'GST-0002', category: 'LEAVE', bedSlot: 2, rankCode: 'WG_CDR' },
      ],
    },
    { room_id: 'r1', date: '2026-10-01', beds_taken: 0, is_closed: true, occupants: [] },
  ];

  it('prints real name, full rank, unit and service number in the cell', () => {
    const doc = buildGridReport({ ...common, fromDate: '2026-10-01', toDate: '2026-10-03', rooms, dayStates: states });
    expect(doc.html).toContain('Rohit Tiwari');
    expect(doc.html).toContain('Flight Lieutenant');
    expect(doc.html).toContain('12 Wing');
    expect(doc.html).toContain('24567-K');
    expect(doc.html).toContain('Closed');
    expect(doc.html).toContain('Vacant');
    expect(doc.html).not.toContain('GST-…');
    expect(doc.html).not.toContain('FLT_LT');
  });

  it('falls back to the guest code and full rank (never a placeholder) when the name is unknown', () => {
    const lines = occupantLines({ guestCode: 'GST-0002', category: 'LEAVE', rankCode: 'WG_CDR' });
    expect(lines.name).toBe('GST-0002');
    expect(lines.detail).toContain('Wing Commander');
    expect(occupantLines({ category: 'PI' }).name).toBe('Guest');
  });

  it('shows the civilian relation for guests without a rank', () => {
    expect(occupantLines({ category: 'MFA', relation: 'SPOUSE', guestName: 'Mrs A' }).detail).toContain('Spouse');
  });

  it('splits rooms into blocks, one date row per day per block, with page numbers', () => {
    const doc = buildGridReport({ ...common, fromDate: '2026-10-01', toDate: '2026-10-03', rooms, dayStates: states, roomsPerPage: 8 });
    // 20 rooms / 8 per block = 3 blocks x 3 days
    expect(bodyRows(doc.html)).toBe(9);
    expect(doc.html).toContain('Rooms 1 to 8 of 20');
    expect(doc.html).toContain('Rooms 17 to 20 of 20');
    expect(doc.html).toContain(`Page ${doc.pageCount} of ${doc.pageCount}`);
    expect(doc.orientation).toBe('landscape');
  });

  it('escapes room names, guest fields and dates', () => {
    const evilRooms = [{ id: 'x', name: XSS, roomType: XSS, displayOrder: 1 }];
    const evilStates: GridPdfDayState[] = [
      {
        room_id: 'x',
        date: '2026-10-01',
        beds_taken: 1,
        is_closed: false,
        occupants: [{ guestName: XSS, rankText: XSS, unit: XSS, serviceNumber: XSS, category: XSS, checkIn: XSS, checkOut: XSS }],
      },
    ];
    const doc = buildGridReport({ ...common, messName: XSS, fromDate: '2026-10-01', toDate: '2026-10-01', rooms: evilRooms, dayStates: evilStates });
    expect(doc.html).not.toContain('<script');
    expect(doc.html).toContain('&lt;script&gt;');
  });

  it('copes with an invalid range or no rooms', () => {
    expect(buildGridReport({ ...common, fromDate: 'nope', toDate: 'nope', rooms, dayStates: [] }).html).toContain(
      'not valid',
    );
    expect(buildGridReport({ ...common, fromDate: '2026-10-01', toDate: '2026-10-02', rooms: [], dayStates: [] }).html).toContain(
      'No active rooms',
    );
    expect(dateRange('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });
});

describe('occupancy and insights reports', () => {
  const rows: ReportDailyRow[] = [
    { day: '2026-10-01', category: 'MFA', roomType: 'NORMAL', people: 4 },
    { day: '2026-10-01', category: 'LEAVE', roomType: 'VIP', people: 2 },
    { day: '2026-10-02', category: 'PI', roomType: 'NORMAL', people: 6 },
    { day: '2026-10-02', category: 'MFA', roomType: 'SUITE', people: 1 },
    { day: '2026-10-03', category: 'TD', roomType: 'SEMI_VIP', people: 3 },
  ];
  const insights = reportInsights(rows, 92, 3);
  const denials = [
    { category: 'LEAVE', count: 2 },
    { category: 'TD', count: 1 },
  ];
  const base = { ...common, periodLabel: 'This Month', insights, dailyRows: rows, denials };

  it('occupancy report has KPIs, an SVG chart and a day-by-day table', () => {
    const doc = buildOccupancyReport(base);
    expect(doc.html).toContain('Room Occupancy Report');
    expect(doc.html).toContain('Total guest-days');
    expect(doc.html).toContain(String(insights.totalGuestDays));
    expect(doc.html).toContain('<svg');
    expect(doc.html).toContain('Day-by-day occupancy');
    expect(doc.html).toContain('2026-10-02');
    expect(doc.html).toContain('Fri'); // 2026-10-02 is a Friday
    expect(doc.html).toContain('VVIP Suite');
    expect(doc.html).toContain('Page 1 of 1');
    expect(doc.orientation).toBe('portrait');
  });

  it('highlights the peak day and splits long months over several numbered pages', () => {
    const month: ReportDailyRow[] = Array.from({ length: 31 }, (_, i) => ({
      day: `2026-10-${String(i + 1).padStart(2, '0')}`,
      category: 'MFA' as const,
      roomType: 'NORMAL' as const,
      people: (i % 7) + 1,
    }));
    const doc = buildOccupancyReport({ ...base, dailyRows: month, insights: reportInsights(month, 92) });
    expect(doc.pageCount).toBeGreaterThanOrEqual(2);
    expect(bodyRows(doc.html)).toBe(31);
    expect(doc.html).toContain('class="peak"');
    expect(doc.html).toContain(`Page ${doc.pageCount} of ${doc.pageCount}`);
  });

  it('insights summary lists findings, categories and denials', () => {
    const doc = buildInsightsReport(base);
    expect(doc.html).toContain('Operational Insights Summary');
    expect(doc.html).toContain('Key findings');
    expect(doc.html).toContain('3 booking requests were denied');
    expect(doc.html).toContain('Visitor categories and denials');
    expect(doc.html).toContain('BA MFA (MFA)');
    expect(doc.html).toContain('Protected - never denied');
    expect(doc.html).toContain('VVIP suites (separate)');
    expect(doc.pageCount).toBe(1);
  });

  it('escapes the period label, generated-by and written insights', () => {
    const doc = buildInsightsReport({
      ...base,
      periodLabel: XSS,
      generatedBy: XSS,
      insights: { ...insights, writtenInsights: [XSS] },
    });
    expect(doc.html).not.toContain('<script');
    expect(doc.html).toContain('&lt;script&gt;');
    const occ = buildOccupancyReport({ ...base, periodLabel: XSS, generatedBy: XSS });
    expect(occ.html).not.toContain('<script');
  });

  it('renders with no data at all', () => {
    const empty = reportInsights([], 92);
    const doc = buildOccupancyReport({ ...base, dailyRows: [], insights: empty });
    expect(doc.html).toContain('No occupancy records in this period.');
    expect(buildInsightsReport({ ...base, dailyRows: [], insights: empty }).html).toContain('Key findings');
  });

  it('niceAxis rounds up to a tidy maximum', () => {
    expect(niceAxis(0)).toEqual({ max: 5, step: 1 });
    expect(niceAxis(37)).toEqual({ max: 40, step: 10 });
    expect(niceAxis(92)).toEqual({ max: 100, step: 20 });
  });
});

describe('grid: rooms held by a booking that does not allow sharing', () => {
  const room: GridPdfRoom = { id: 'r1', name: 'Room 1', roomType: 'NORMAL', displayOrder: 1 };
  const occ = (allowSharing?: boolean) => ({
    guestCode: 'GST-0001',
    guestName: 'Rohit Tiwari',
    category: 'MFA',
    bedSlot: 1,
    allowSharing,
  });
  const state = (occupants: ReturnType<typeof occ>[], is_closed = false): GridPdfDayState => ({
    room_id: 'r1',
    date: '2026-10-01',
    beds_taken: occupants.length,
    is_closed,
    occupants,
  });
  const build = (s: GridPdfDayState) =>
    buildGridReport({ ...common, fromDate: '2026-10-01', toDate: '2026-10-01', rooms: [room], dayStates: [s] });

  it('a lone occupant of a no-sharing booking holds the room: one booked bed, no free second bed', () => {
    expect(isRoomHeldExclusive(state([occ(false)]))).toBe(true);
    const doc = build(state([occ(false)]));
    expect(doc.html).toContain('No sharing - room held, no free bed');
    expect(doc.html).toContain('Rohit Tiwari');
    expect(doc.summary.kpis.length).toBeGreaterThan(0);
    // counted as occupied, with the bed that is actually booked
    expect(doc.html).toMatch(/Held, no sharing<\/div><div class="kpi-value">1</);
    expect(doc.html).toMatch(/Occupied room-days<\/div><div class="kpi-value">1</);
    expect(doc.html).toMatch(/Beds taken \(bed-days\)<\/div><div class="kpi-value">1</);
  });

  it('shows no held note when sharing is allowed, unknown, or the room is closed / full / empty', () => {
    for (const s of [state([occ(true)]), state([occ(undefined)]), state([occ(false)], true), state([])]) {
      expect(isRoomHeldExclusive(s)).toBe(false);
      expect(build(s).html).not.toContain('No sharing - room held');
    }
    const two = state([occ(false), { ...occ(false), guestCode: 'GST-0002', bedSlot: 2 }]);
    expect(isRoomHeldExclusive(two)).toBe(false);
    expect(build(two).html).not.toContain('No sharing - room held');
  });
});
