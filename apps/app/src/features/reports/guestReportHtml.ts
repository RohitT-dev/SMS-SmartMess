/**
 * Custom guest report (landscape A4): one row per guest matching the chosen filters, with the
 * active filters and the count in the header. Pure HTML builder - no React Native.
 */
import {
  DEFAULT_MESS_NAME,
  KPI_BLOCK,
  bodyCapacity,
  cellLineCount,
  composeReportHtml,
  estimateLines,
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
import {
  ROOM_TYPE_LABELS,
  STAY_STATUS_LABELS,
  type GuestReportRow,
  type StayStatus,
} from './guestReport';

export interface GuestReportOptions {
  title?: string;
  rows: GuestReportRow[];
  /** Active filters, from describeGuestReportFilters. */
  filters: Array<{ label: string; value: string }>;
  messName?: string;
  generatedBy?: string;
  generatedAt?: Date;
}

const DEFAULT_TITLE = 'Guest Report';

function columnsFor(innerWidth: number): TableColumn[] {
  const fixed: Array<[string, number, TableColumn['align']?]> = [
    ['S.No', 30, 'center'],
    ['Name', 165],
    ['Rank / Relation', 108],
    ['Unit', 122],
    ['Service No.', 74],
    ['Phone', 80],
    ['Room / Bed', 0],
    ['Room type', 68, 'center'],
    ['Cat.', 46, 'center'],
    ['Check-in', 66, 'center'],
    ['Check-out', 66, 'center'],
    ['Status', 66, 'center'],
  ];
  const used = fixed.reduce((sum, [, w]) => sum + w, 0);
  return fixed.map(([header, width, align]) => ({ header, width: width || innerWidth - used, align }));
}

const STATUS_CLASS: Record<StayStatus, string> = {
  CURRENT: 'badge-ok',
  UPCOMING: 'badge-ok',
  COMPLETED: 'badge-ok',
  CANCELLED: 'badge-off',
  DISPLACED: 'badge-off',
};

const roomTypeLabel = (t: string | null) => (t ? (ROOM_TYPE_LABELS[t as keyof typeof ROOM_TYPE_LABELS] ?? t) : '');

function rowFor(r: GuestReportRow, index: number, cols: TableColumn[]): TableRow {
  const room = r.room ? `${r.room}${r.bed ? ` (Bed ${r.bed})` : ''}` : 'Not allotted';
  const lines = Math.max(
    cellLineCount([r.name], cols[1].width, true),
    cellLineCount([r.rank], cols[2].width),
    cellLineCount([r.unit], cols[3].width),
    cellLineCount([r.serviceNumber], cols[4].width),
    cellLineCount([r.phone], cols[5].width),
    cellLineCount([room], cols[6].width),
  );
  const cells: SafeHtml[] = [
    html`${index + 1}`,
    html`<strong>${r.name}</strong>`,
    html`${r.rank}`,
    html`${r.unit}`,
    html`${r.serviceNumber}`,
    html`${r.phone}`,
    r.room ? html`${room}` : html`<span class="note">${room}</span>`,
    html`${roomTypeLabel(r.roomType)}`,
    html`<span class="badge badge-${r.category.toLowerCase()}">${r.category}</span>`,
    html`${r.checkIn}`,
    html`${r.checkOut}`,
    html`<span class="badge ${STATUS_CLASS[r.status]}">${STAY_STATUS_LABELS[r.status]}</span>`,
  ];
  return { cells, height: tableRowHeight(lines), zebra: index % 2 === 1 };
}

const FILTER_FONT_PX = 10;
const FILTER_LINE_PX = 14;
/** Padding + border + bottom margin of the filters box. */
const FILTER_CHROME_PX = 20;

const EXTRA_CSS = `
.filters { font-size: ${FILTER_FONT_PX}px; line-height: ${FILTER_LINE_PX}px; color: #1B2733; background: #F4F6F8; border: 1px solid #DDE2E8; border-left: 3px solid #12283F; padding: 4px 8px; margin-bottom: 10px; overflow: hidden; }
.filters .fl { color: #5B6877; font-weight: 700; text-transform: uppercase; font-size: 8px; letter-spacing: 0.5px; }
`;

export function buildGuestReport({
  title = DEFAULT_TITLE,
  rows,
  filters,
  messName = DEFAULT_MESS_NAME,
  generatedBy,
  generatedAt = new Date(),
}: GuestReportOptions): ReportDocument {
  const geometry = pageGeometry('landscape');
  const cols = columnsFor(geometry.innerWidth);

  const bookings = new Set(rows.map((r) => r.bookingId)).size;
  const rooms = new Set(rows.filter((r) => r.room).map((r) => r.room)).size;
  const count = (cat: string) => rows.filter((r) => r.category === cat).length;
  const kpis = [
    { label: 'Guests listed', value: String(rows.length) },
    { label: 'Bookings', value: String(bookings) },
    { label: 'Rooms', value: String(rooms) },
    { label: 'MFA', value: String(count('MFA')) },
    { label: 'PI', value: String(count('PI')) },
    { label: 'Leave', value: String(count('LEAVE')) },
    { label: 'TD', value: String(count('TD')) },
  ];

  const filterText = filters.map((f) => `${f.label}: ${f.value}`).join('  |  ');
  const filterLines = estimateLines(filterText || 'None', geometry.innerWidth - 24, FILTER_FONT_PX);
  const filterBlock = filterLines * FILTER_LINE_PX + FILTER_CHROME_PX;
  const filtersHtml = html`<div class="filters"><span class="fl">Filters</span> ${
    filters.length === 0
      ? 'None - every guest'
      : filters.map(
          (f, i) => html`${i > 0 ? html`&nbsp;&nbsp;|&nbsp;&nbsp;` : html``}<strong>${f.label}:</strong> ${f.value}`,
        )
  }</div>`;

  const tableRows = rows.map((r, i) => rowFor(r, i, cols));
  const flowed = flowTable(tableRows, geometry, bodyCapacity(geometry, true) - KPI_BLOCK - filterBlock, false);

  const intro = html`${kpiStripHtml(kpis)}${filtersHtml}`;
  let rowCursor = 0;
  const render = (pageRows: TableRow[]): SafeHtml => {
    const out = tableHtml(cols, pageRows, rowCursor);
    rowCursor += pageRows.length;
    return out;
  };

  const pages: SafeHtml[] = [];
  if (rows.length === 0) {
    pages.push(html`${intro}<p class="note" style="padding:18px 0;text-align:center">No guests match these filters.</p>`);
  } else {
    pages.push(flowed.firstPageRows ? html`${intro}${render(flowed.firstPageRows)}` : intro);
    flowed.laterPages.forEach((pageRows) => pages.push(render(pageRows)));
  }

  const scope = filters.map((f) => `${f.label} ${f.value}`).join('; ') || 'All guests';
  const meta = {
    messName,
    title,
    subtitle: `${rows.length} guest${rows.length === 1 ? '' : 's'} - ${scope}`,
    details: [
      { label: 'Guests listed', value: String(rows.length) },
      { label: 'Bookings', value: String(bookings) },
    ],
    generatedAt,
    generatedBy,
  };

  return {
    kind: 'guest_report',
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
      lines: rows
        .slice(0, 8)
        .map((r) => `${r.name} - ${r.room || 'No room'} (${r.category}, ${STAY_STATUS_LABELS[r.status]})`),
    },
    audit: {
      action: 'guest_report_exported',
      entity: 'bookings',
      // Filter labels only - the unit text is not a name, but no guest data goes in the log.
      meta: { total_records: rows.length, filter: filters.map((f) => f.label).join(', ') || 'none', pages: pages.length },
    },
  };
}
