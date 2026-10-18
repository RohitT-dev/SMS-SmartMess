/**
 * Past bookings register (landscape A4). Pure HTML builder - no React Native.
 *
 * One table row per guest, grouped by booking: the booking columns (ID, category, stay, rooms,
 * status) sit on the booking's first row and a booking's rows are never split across pages.
 */
import { rankLabel } from '../bookings/guestDisplay';
import {
  DEFAULT_MESS_NAME,
  KPI_BLOCK,
  bodyCapacity,
  cellLineCount,
  composeReportHtml,
  escapeHtml,
  flowTable,
  html,
  kpiStripHtml,
  pageGeometry,
  reportFileName,
  tableHtml,
  tableRowHeight,
  type ReportDocument,
  type SafeHtml,
  type TableColumn,
  type TableRow,
} from './reportDocument';

// Kept here for the modules that already import it from this file.
export { escapeHtml };

export interface PastBookingGuestItem {
  name: string;
  /** Full rank for officers, relation (e.g. "Spouse") for civilian companions. */
  rank?: string | null;
  unit?: string | null;
  serviceNumber?: string | null;
  /** Rooms this guest occupied, when they differ from the booking's rooms. */
  rooms?: string;
}

export interface PastBookingPdfItem {
  id: string;
  category: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  partySize: number;
  status: string;
  guestName: string;
  guestRank: string;
  serviceNumber?: string | null;
  unit?: string | null;
  rooms: string;
  /** Every guest of the booking. When absent, the single guest above is listed. */
  guests?: PastBookingGuestItem[];
}

export interface PastBookingsPdfOptions {
  title?: string;
  bookings: PastBookingPdfItem[];
  filterLabel?: string;
  messName?: string;
  generatedBy?: string;
  generatedAt?: Date;
}

const DEFAULT_TITLE = 'Past Bookings Register';

export function guestsOf(b: PastBookingPdfItem): PastBookingGuestItem[] {
  if (b.guests && b.guests.length > 0) return b.guests;
  return [
    {
      name: b.guestName,
      rank: b.guestRank,
      unit: b.unit,
      serviceNumber: b.serviceNumber,
    },
  ];
}

/** Full rank for rank codes ("FLT_LT"), anything else (already a label or a relation) as given. */
function rankText(rank: string | null | undefined): string {
  return rank ? rankLabel(rank) : '';
}

const STATUS_OK = new Set(['CONFIRMED', 'COMPLETED']);

function columnsFor(innerWidth: number): TableColumn[] {
  const fixed: Array<[string, number, TableColumn['align']?]> = [
    ['S.No', 36, 'center'],
    ['Booking', 68],
    ['Name', 160],
    ['Rank / Relation', 118],
    ['Unit', 122],
    ['Service No.', 80],
    ['Category', 60, 'center'],
    ['Stay period', 140],
    ['Nights', 42, 'center'],
    ['Rooms allotted', 0],
    ['Status', 80, 'center'],
  ];
  const used = fixed.reduce((sum, [, w]) => sum + w, 0);
  return fixed.map(([header, width, align]) => ({
    header,
    width: width || innerWidth - used,
    align,
  }));
}

interface BookingGroup {
  rows: TableRow[];
  height: number;
}

function groupFor(b: PastBookingPdfItem, index: number, cols: TableColumn[]): BookingGroup {
  const guests = guestsOf(b);
  const stay = `${b.checkIn} to ${b.checkOut}`;
  const zebra = index % 2 === 1;
  const rows = guests.map((g, gi): TableRow => {
    const first = gi === 0;
    const rooms = g.rooms ?? (first ? b.rooms || '-' : '');
    const rank = rankText(g.rank);
    const name = g.name?.trim() || `Guest ${gi + 1}`;
    const lines = Math.max(
      cellLineCount([name], cols[2].width, true),
      cellLineCount([rank], cols[3].width),
      cellLineCount([g.unit ?? ''], cols[4].width),
      cellLineCount([g.serviceNumber ?? ''], cols[5].width),
      first ? cellLineCount([stay], cols[7].width) : 1,
      cellLineCount([rooms], cols[9].width),
    );
    const cells: SafeHtml[] = [
      html`${first ? index + 1 : ''}`,
      first ? html`<span class="mono">#${b.id.slice(0, 8)}</span>` : html``,
      html`<strong>${name}</strong>`,
      html`${rank}`,
      html`${g.unit ?? ''}`,
      html`${g.serviceNumber ?? ''}`,
      first ? html`<span class="badge badge-${b.category.toLowerCase()}">${b.category}</span>` : html``,
      html`${first ? stay : ''}`,
      html`${first ? b.nights : ''}`,
      html`${rooms}`,
      first
        ? html`<span class="badge ${STATUS_OK.has(b.status) ? 'badge-ok' : 'badge-off'}">${b.status}</span>`
        : html``,
    ];
    return { cells, height: tableRowHeight(lines), zebra, className: first ? '' : 'cont' };
  });
  return { rows, height: rows.reduce((sum, r) => sum + r.height, 0) };
}

const EXTRA_CSS = `
table.data tr.cont td { border-top: 0; }
`;

export function buildPastBookingsReport({
  title = DEFAULT_TITLE,
  bookings,
  filterLabel = 'All Completed & Past Stays',
  messName = DEFAULT_MESS_NAME,
  generatedBy,
  generatedAt = new Date(),
}: PastBookingsPdfOptions): ReportDocument {
  const geometry = pageGeometry('landscape');
  const cols = columnsFor(geometry.innerWidth);

  const totalBookings = bookings.length;
  const totalNights = bookings.reduce((sum, b) => sum + (b.nights || 0), 0);
  const totalGuests = bookings.reduce((sum, b) => sum + guestsOf(b).length, 0);
  const count = (cat: string) => bookings.filter((b) => b.category === cat).length;
  const kpis = [
    { label: 'Total Past Stays', value: String(totalBookings) },
    { label: 'Total Nights Hosted', value: String(totalNights) },
    { label: 'Guests Hosted', value: String(totalGuests) },
    { label: 'MFA Stays', value: String(count('MFA')) },
    { label: 'PI Stays', value: String(count('PI')) },
    { label: 'Leave Stays', value: String(count('LEAVE')) },
    { label: 'TD Stays', value: String(count('TD')) },
  ];

  const groups = bookings.map((b, i) => groupFor(b, i, cols));
  const flowed = flowTable(groups, geometry, bodyCapacity(geometry, true) - KPI_BLOCK, false);

  const intro = kpiStripHtml(kpis);
  let rowCursor = 0;
  const render = (pageGroups: BookingGroup[]): SafeHtml => {
    const rows = pageGroups.flatMap((g) => g.rows);
    const out = tableHtml(cols, rows, rowCursor);
    rowCursor += rows.length;
    return out;
  };

  const pages: SafeHtml[] = [];
  if (bookings.length === 0) {
    pages.push(html`${intro}<p class="note" style="padding:18px 0;text-align:center">No past bookings found.</p>`);
  } else {
    pages.push(flowed.firstPageRows ? html`${intro}${render(flowed.firstPageRows)}` : intro);
    flowed.laterPages.forEach((pageGroups) => pages.push(render(pageGroups)));
  }

  const meta = {
    messName,
    title,
    subtitle: `Scope: ${filterLabel}`,
    details: [
      { label: 'Scope', value: filterLabel },
      { label: 'Total records', value: String(totalBookings) },
    ],
    generatedAt,
    generatedBy,
  };

  return {
    kind: 'past_bookings',
    title,
    fileName: reportFileName(title, generatedAt),
    orientation: 'landscape',
    pageCount: pages.length,
    html: composeReportHtml({
      meta,
      orientation: 'landscape',
      pages,
      footerNote: 'CONFIDENTIAL - OFFICIAL ARMED FORCES MESS PROPERTY - NOT FOR PUBLIC DISSEMINATION',
      extraCss: EXTRA_CSS,
    }),
    summary: {
      kpis: kpis.slice(0, 4),
      lines: bookings
        .slice(0, 8)
        .map((b) => `${guestsOf(b)[0].name || 'Guest'} - ${b.checkIn} to ${b.checkOut} (${b.category}, ${b.status})`),
    },
    audit: {
      action: 'past_bookings_exported',
      entity: 'bookings',
      meta: { total_records: totalBookings, filter: filterLabel, pages: pages.length },
    },
  };
}

/** Standalone HTML only - see `buildPastBookingsReport` for the full document. */
export function buildPastBookingsHtml(options: PastBookingsPdfOptions): string {
  return buildPastBookingsReport(options).html;
}
