/**
 * Room occupancy grid (landscape A4): dates down the side, rooms across the top.
 * Pure HTML builder - no React Native.
 *
 * A name-level matrix of ~45 rooms cannot fit across one page, so rooms are split into blocks of
 * `roomsPerPage` columns; every block lists all dates (paginated) with its own repeated header.
 */
import { RELATION_LABELS, type GuestRelation, type RoomDayOccupant } from '@sms/core';
import { rankLabel } from '../bookings/guestDisplay';
import { isHeldByExclusiveBooking } from '../rooms/bedLayout';
import {
  DEFAULT_MESS_NAME,
  KPI_BLOCK,
  bodyCapacity,
  composeReportHtml,
  estimateLines,
  flowTable,
  html,
  kpiStripHtml,
  pageGeometry,
  reportFileName,
  sectionTitleHtml,
  tableHtml,
  type ReportDocument,
  type SafeHtml,
  type TableColumn,
  type TableRow,
} from './reportDocument';

export interface GridPdfOccupant {
  allocationId?: string;
  bookingId?: string;
  bedSlot?: number;
  gender?: string;
  rankCode?: string | null;
  relation?: string | null;
  guestCode?: string;
  category?: string;
  bookingStatus?: string;
  checkIn?: string;
  checkOut?: string;
  /** Whether the booking lets other bookings use the room's other bed. Missing counts as true. */
  allowSharing?: boolean;
  /** Filled from booking_guests by the grid screen; the RPC only returns codes. */
  guestName?: string;
  /** Full rank ("Flight Lieutenant") or the civilian relation. */
  rankText?: string;
  unit?: string;
  serviceNumber?: string;
}

export interface GridPdfRoom {
  id: string;
  name: string;
  roomType: string;
  displayOrder: number;
}

export interface GridPdfDayState {
  room_id: string;
  date: string;
  beds_taken: number;
  is_closed: boolean;
  occupants?: GridPdfOccupant[];
}

export interface GridPdfOptions {
  fromDate: string;
  toDate: string; // inclusive
  rooms: GridPdfRoom[];
  dayStates: GridPdfDayState[];
  messName?: string;
  generatedBy?: string;
  generatedAt?: Date;
  /** Room columns per page block. */
  roomsPerPage?: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ROOM_TYPE_LABELS: Record<string, string> = {
  VIP: 'VIP',
  SEMI_VIP: 'Semi VIP',
  NORMAL: 'Normal',
  SUITE: 'VVIP Suite',
};

/** Inclusive list of YYYY-MM-DD dates, capped so a typo cannot build a runaway document. */
export function dateRange(fromDate: string, toDate: string, maxDays = 366): string[] {
  const dates: string[] = [];
  const cur = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) return dates;
  while (cur <= end && dates.length < maxDays) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/**
 * A room whose only occupant belongs to a booking that does not allow sharing is fully held:
 * it shows one booked bed and no free second bed (see `isHeldByExclusiveBooking`).
 */
export function isRoomHeldExclusive(state: Pick<GridPdfDayState, 'is_closed' | 'occupants'>): boolean {
  return isHeldByExclusiveBooking({
    is_closed: state.is_closed,
    occupants: (state.occupants ?? null) as RoomDayOccupant[] | null,
  });
}

const HELD_TEXT = 'No sharing - room held, no free bed';

const CAT_CLASS: Record<string, string> = {
  MFA: 'o-mfa',
  LEAVE: 'o-leave',
  TD: 'o-td',
  PI: 'o-pi',
};

/** Name, full rank, unit and service number of an occupant, with plain fallbacks. */
export function occupantLines(occ: GridPdfOccupant): { name: string; rank: string; detail: string; service: string } {
  const name = occ.guestName?.trim() || occ.guestCode?.trim() || 'Guest';
  const rank =
    occ.rankText?.trim() ||
    (occ.rankCode ? rankLabel(occ.rankCode) : '') ||
    (occ.relation ? (RELATION_LABELS[occ.relation as GuestRelation] ?? '') : '');
  const cat = (occ.category || 'MFA').toUpperCase();
  const detail = [cat, rank, occ.unit?.trim()].filter(Boolean).join(' - ');
  const service = occ.serviceNumber?.trim() ? `Svc no. ${occ.serviceNumber.trim()}` : '';
  return { name, rank, detail, service };
}

const OCC_FONT = 8.5;
const OCC_LINE = 10.5;

function occupantHtml(occ: GridPdfOccupant): SafeHtml {
  const cat = (occ.category || 'MFA').toUpperCase();
  const { name, detail, service } = occupantLines(occ);
  const tip = [name, detail, service, occ.checkIn && occ.checkOut ? `${occ.checkIn} to ${occ.checkOut}` : '']
    .filter(Boolean)
    .join(' | ');
  return html`<div class="occ ${CAT_CLASS[cat] ?? 'o-mfa'}" title="${tip}"><div class="o-name">${name}</div><div class="o-detail">${detail}</div>${service ? html`<div class="o-svc">${service}</div>` : ''}</div>`;
}

function occupantHeight(occ: GridPdfOccupant, colWidth: number): number {
  const { name, detail, service } = occupantLines(occ);
  const inner = colWidth - 4 - 6 - 5; // cell padding, block padding, borders
  const lines =
    estimateLines(name, inner, OCC_FONT, true) +
    estimateLines(detail, inner, OCC_FONT) +
    (service ? estimateLines(service, inner, OCC_FONT) : 0);
  return lines * OCC_LINE + 4 + 2 + 2; // padding, borders, margin
}

function heldNoteHeight(colWidth: number): number {
  return estimateLines(HELD_TEXT, colWidth - 4 - 6 - 2, 7.5, true) * 9 + 2 + 2 + 2;
}

const GRID_CSS = `
table.grid { font-size: 8.5px; }
table.grid th { height: 24px; padding: 2px 3px; text-align: center; white-space: normal; text-transform: none; letter-spacing: 0; line-height: 10px; }
table.grid th .th-name { font-size: 8.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
table.grid th .th-type { font-size: 7px; font-weight: 400; text-transform: uppercase; letter-spacing: 0.4px; opacity: 0.85; }
table.grid td { padding: 2px; border: 1px solid #CBD5E0; text-align: center; vertical-align: top; line-height: 10.5px; }
table.grid td.date { background: #EDF2F7; font-weight: 700; font-size: 9px; text-align: center; vertical-align: middle; }
table.grid td.date .dow { display: block; font-weight: 400; font-size: 7.5px; color: #718096; }
table.grid td.vacant { background: #F0FFF4; color: #2E7D32; vertical-align: middle; font-size: 8px; }
table.grid td.closed { background: #EEEEEE; color: #616161; vertical-align: middle; font-size: 8px; font-weight: 700; }
.occ { margin: 0 0 2px; padding: 2px 3px; border: 1px solid transparent; border-left-width: 3px; border-radius: 3px; text-align: left; overflow-wrap: anywhere; break-inside: avoid; }
.occ .o-name { font-weight: 700; font-size: 8.5px; }
.occ .o-detail, .occ .o-svc { font-size: 8px; }
.occ-held { margin: 0 0 2px; padding: 1px 3px; border: 1px dashed #A0AEC0; border-radius: 3px; background: #F7FAFC; color: #4A5568; font-size: 7.5px; font-weight: 700; text-align: left; line-height: 9px; }
.o-mfa { background: #FFEBEE; color: #B71C1C; border-color: #EF9A9A; }
.o-leave { background: #FFF3E0; color: #BF360C; border-color: #FFCC80; }
.o-td { background: #FFFDE7; color: #E65100; border-color: #FFF59D; }
.o-pi { background: #E3F2FD; color: #0D47A1; border-color: #90CAF9; }
.grid-legend { display: flex; flex-wrap: nowrap; overflow: hidden; white-space: nowrap; gap: 14px; height: 24px; align-items: center; background: #F7FAFC; border: 1px solid #E2E8F0; padding: 0 8px; margin-bottom: 4px; font-size: 8.5px; font-weight: 700; color: #2D3748; }
.grid-legend i { display: inline-block; width: 11px; height: 11px; border-radius: 2px; border: 1px solid rgba(0,0,0,0.2); margin-right: 4px; vertical-align: -2px; }
`;

const LEGEND_BLOCK = 28;

function legendHtml(): SafeHtml {
  const item = (bg: string, border: string, label: string) =>
    html`<span><i style="background:${bg};border-color:${border}"></i>${label}</span>`;
  return html`<div class="grid-legend"><span>Colour code:</span>${item('#FFEBEE', '#EF9A9A', 'MFA (BA MFA)')}${item('#FFF3E0', '#FFCC80', 'Leave')}${item('#FFFDE7', '#FFF59D', 'TD (Displacement)')}${item('#E3F2FD', '#90CAF9', 'PI (Posted In)')}${item('#F0FFF4', '#A5D6A7', 'Vacant')}${item('#EEEEEE', '#BDBDBD', 'Closed')}<span><i style="background:#F7FAFC;border:1px dashed #A0AEC0"></i>Held - booking does not allow sharing</span></div>`;
}

export function buildGridReport({
  fromDate,
  toDate,
  rooms,
  dayStates,
  messName = DEFAULT_MESS_NAME,
  generatedBy,
  generatedAt = new Date(),
  roomsPerPage = 8,
}: GridPdfOptions): ReportDocument {
  const geometry = pageGeometry('landscape');
  const stateMap = new Map<string, GridPdfDayState>();
  for (const s of dayStates) stateMap.set(`${s.date}_${s.room_id}`, s);
  const dates = dateRange(fromDate, toDate);

  // Headline numbers over the whole grid.
  let occupiedRoomDays = 0;
  let bedsTaken = 0;
  let closedRoomDays = 0;
  let heldRoomDays = 0;
  for (const date of dates) {
    for (const r of rooms) {
      const st = stateMap.get(`${date}_${r.id}`);
      if (!st) continue;
      if (st.is_closed) closedRoomDays += 1;
      else if (st.occupants && st.occupants.length > 0) {
        occupiedRoomDays += 1;
        bedsTaken += st.occupants.length;
        if (isRoomHeldExclusive(st)) heldRoomDays += 1;
      }
    }
  }
  const kpis = [
    { label: 'Days covered', value: String(dates.length), hint: `${fromDate} to ${toDate}` },
    { label: 'Rooms', value: String(rooms.length) },
    { label: 'Occupied room-days', value: String(occupiedRoomDays) },
    { label: 'Beds taken (bed-days)', value: String(bedsTaken) },
    { label: 'Held, no sharing', value: String(heldRoomDays), hint: 'room-days, 2nd bed not free' },
    { label: 'Closed room-days', value: String(closedRoomDays) },
  ];

  const blockSize = Math.max(1, Math.floor(roomsPerPage));
  const blocks: GridPdfRoom[][] = [];
  for (let i = 0; i < rooms.length; i += blockSize) blocks.push(rooms.slice(i, i + blockSize));

  const dateColWidth = 78;
  const pages: SafeHtml[] = [];
  const intro = html`${kpiStripHtml(kpis)}${legendHtml()}`;

  if (blocks.length === 0 || dates.length === 0) {
    pages.push(html`${intro}<p class="note" style="padding:18px 0;text-align:center">${
      dates.length === 0 ? 'The selected date range is not valid.' : 'No active rooms to show.'
    }</p>`);
  }

  blocks.forEach((block, blockIndex) => {
    const roomWidth = Math.floor((geometry.innerWidth - dateColWidth) / blockSize);
    const columns: TableColumn[] = [
      { header: 'Date / Room', width: dateColWidth, align: 'center' },
      ...block.map((r) => ({
        header: html`<div class="th-name">${r.name}</div><div class="th-type">${ROOM_TYPE_LABELS[r.roomType] ?? r.roomType}</div>`,
        width: roomWidth,
        align: 'center' as const,
      })),
    ];

    const rows: TableRow[] = dates.map((date) => {
      const d = new Date(`${date}T00:00:00Z`);
      let maxCell = 26;
      const classes: string[] = ['date'];
      const cells: SafeHtml[] = block.map((room) => {
        const st = stateMap.get(`${date}_${room.id}`);
        if (st?.is_closed) {
          classes.push('closed');
          return html`Closed`;
        }
        const occupants = st?.occupants ?? [];
        if (occupants.length === 0) {
          classes.push('vacant');
          return html`Vacant`;
        }
        classes.push('occupied');
        const held = isRoomHeldExclusive(st!);
        const h =
          occupants.reduce((sum, o) => sum + occupantHeight(o, roomWidth), 4) +
          (held ? heldNoteHeight(roomWidth) : 0);
        maxCell = Math.max(maxCell, h);
        return html`${occupants.map(occupantHtml)}${held ? html`<div class="occ-held">${HELD_TEXT}</div>` : ''}`;
      });
      return {
        cells: [html`${date}<span class="dow">${WEEKDAYS[d.getUTCDay()]}</span>`, ...cells],
        cellClasses: classes,
        height: maxCell + 1,
        zebra: false,
      };
    });

    const first = blockIndex === 0;
    const left = first ? bodyCapacity(geometry, true) - KPI_BLOCK - LEGEND_BLOCK : bodyCapacity(geometry, false);
    const flowed = flowTable(rows, geometry, left, true);
    const title = sectionTitleHtml(
      `Rooms ${blockIndex * blockSize + 1} to ${blockIndex * blockSize + block.length} of ${rooms.length}`,
    );
    const render = (pageRows: TableRow[]) => tableHtml(columns, pageRows, 0, 'grid');

    if (first) {
      pages.push(flowed.firstPageRows ? html`${intro}${title}${render(flowed.firstPageRows)}` : intro);
      flowed.laterPages.forEach((p, i) => pages.push(html`${!flowed.firstPageRows && i === 0 ? title : ''}${render(p)}`));
    } else {
      // Every later block starts on a fresh page.
      if (flowed.firstPageRows) {
        pages.push(html`${title}${render(flowed.firstPageRows)}`);
        flowed.laterPages.forEach((p) => pages.push(render(p)));
      } else {
        flowed.laterPages.forEach((p, i) => pages.push(html`${i === 0 ? title : ''}${render(p)}`));
      }
    }
  });

  const title = 'Room Occupancy Grid';
  const meta = {
    messName,
    title,
    subtitle: `${fromDate} to ${toDate} (${dates.length} days) - dates down, rooms across`,
    details: [
      { label: 'Date range', value: `${fromDate} to ${toDate}` },
      { label: 'Rooms', value: String(rooms.length) },
    ],
    generatedAt,
    generatedBy,
  };

  const htmlDoc = composeReportHtml({
    meta,
    orientation: 'landscape',
    pages,
    footerNote: 'CONFIDENTIAL - OFFICIAL MESS OCCUPANCY RECORD - ALLOCATIONS ENFORCE MILITARY STAY POLICIES',
    extraCss: GRID_CSS,
  });

  return {
    kind: 'grid',
    title,
    fileName: reportFileName(title, generatedAt, `${fromDate}_to_${toDate}`),
    orientation: 'landscape',
    pageCount: pages.length,
    html: htmlDoc,
    summary: {
      kpis: kpis.slice(0, 4).map((k) => ({ label: k.label, value: k.value })),
      lines: [`${rooms.length} room(s) over ${dates.length} day(s), ${fromDate} to ${toDate}.`],
    },
    audit: {
      action: 'grid_report_exported',
      entity: 'reports',
      meta: { fromDate, toDate, rooms: rooms.length, pages: pages.length },
    },
  };
}

/** Standalone HTML only - see `buildGridReport` for the full document. */
export function buildGridHtml(options: GridPdfOptions): string {
  return buildGridReport(options).html;
}
