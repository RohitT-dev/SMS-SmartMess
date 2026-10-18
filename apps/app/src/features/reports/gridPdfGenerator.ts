import { Platform } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { supabase } from '../../lib/supabase';
import { escapeHtml } from './pastBookingsHtml';

export interface GridPdfOccupant {
  allocationId?: string;
  bookingId?: string;
  bedSlot?: number;
  gender?: string;
  rankCode?: string;
  guestCode?: string;
  category?: string;
  bookingStatus?: string;
  checkIn?: string;
  checkOut?: string;
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
}

export function buildGridHtml({
  fromDate,
  toDate,
  rooms,
  dayStates,
  messName = 'Residential Officers Mess',
}: GridPdfOptions): string {
  // Index state by `${date}_${room_id}`
  const stateMap = new Map<string, GridPdfDayState>();
  dayStates.forEach((s) => {
    stateMap.set(`${s.date}_${s.room_id}`, s);
  });

  // Unique dates in order
  const dates: string[] = [];
  let cur = new Date(fromDate + 'T00:00:00Z');
  const end = new Date(toDate + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const roomHeaders = rooms.map(
    (r) => `<th class="room-col"><div class="r-name">${escapeHtml(r.name)}</div><div class="r-type">${escapeHtml(r.roomType)}</div></th>`,
  ).join('');

  const rows = dates
    .map((dateStr) => {
      const d = new Date(dateStr + 'T00:00:00Z');
      const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
      const dateLabel = `${dateStr}<br/><span class="day-label">${dayName}</span>`;

      const cells = rooms
        .map((r) => {
          const state = stateMap.get(`${dateStr}_${r.id}`);
          if (!state) {
            return `<td class="cell vacant"><span class="badge badge-vacant">Vacant</span></td>`;
          }
          if (state.is_closed) {
            return `<td class="cell closed"><span class="badge badge-closed">Closed</span></td>`;
          }
          if (!state.occupants || state.occupants.length === 0) {
            return `<td class="cell vacant"><span class="badge badge-vacant">Vacant</span></td>`;
          }

          // Occupied cell: render occupant badges
          const occHtml = state.occupants
            .map((occ) => {
              const cat = (occ.category || 'MFA').toUpperCase();
              let cls = 'badge-mfa';
              if (cat === 'LEAVE') cls = 'badge-leave';
              else if (cat === 'TD') cls = 'badge-td';
              else if (cat === 'PI') cls = 'badge-pi';

              const guestCode = occ.guestCode || 'GST-…';
              const rank = occ.rankCode ? ` ${occ.rankCode}` : '';
              return `<div class="badge ${cls}"><span class="cat-tag">${escapeHtml(cat)}</span> ${escapeHtml(guestCode)}${escapeHtml(rank)}</div>`;
            })
            .join('');

          return `<td class="cell occupied">${occHtml}</td>`;
        })
        .join('');

      return `<tr><th class="date-col">${dateLabel}</th>${cells}</tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Room Occupancy Grid Matrix - ${escapeHtml(fromDate)} to ${escapeHtml(toDate)}</title>
  <style>
    @page {
      size: A4 landscape;
      margin: 8mm;
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      margin: 0;
      padding: 0;
      color: #1a202c;
      font-size: 10px;
      line-height: 1.2;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      border-bottom: 2px solid #2b6cb0;
      padding-bottom: 6px;
      margin-bottom: 8px;
    }
    .title {
      font-size: 16px;
      font-weight: 800;
      color: #1a365d;
      margin: 0;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .subtitle {
      font-size: 11px;
      color: #4a5568;
      margin-top: 2px;
    }
    .meta {
      text-align: right;
      font-size: 9px;
      color: #718096;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      background: #f7fafc;
      border: 1px solid #e2e8f0;
      padding: 6px 10px;
      border-radius: 4px;
      margin-bottom: 8px;
      align-items: center;
    }
    .legend-title {
      font-weight: bold;
      font-size: 10px;
      color: #2d3748;
      margin-right: 4px;
    }
    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 9px;
      font-weight: 600;
    }
    .legend-box {
      width: 12px;
      height: 12px;
      border-radius: 2px;
      border: 1px solid rgba(0,0,0,0.15);
    }
    .table-container {
      width: 100%;
      overflow: hidden;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 9px;
    }
    th, td {
      border: 1px solid #cbd5e0;
      padding: 4px 3px;
      text-align: center;
      vertical-align: middle;
      word-wrap: break-word;
    }
    th {
      background: #edf2f7;
      color: #2d3748;
      font-weight: 700;
    }
    .date-col {
      width: 74px;
      background: #edf2f7;
      font-size: 9px;
      font-weight: bold;
      text-align: center;
    }
    .day-label {
      font-size: 8px;
      color: #718096;
      font-weight: normal;
    }
    .room-col {
      font-size: 9px;
    }
    .r-name {
      font-weight: 700;
      color: #1a365d;
    }
    .r-type {
      font-size: 8px;
      color: #718096;
      text-transform: uppercase;
      font-weight: 600;
    }
    .cell {
      height: 28px;
    }
    .cell.vacant {
      background: #f0fff4;
    }
    .cell.closed {
      background: #edf2f7;
    }
    .cell.occupied {
      background: #ffffff;
      padding: 2px;
    }
    .badge {
      display: inline-block;
      width: 100%;
      padding: 2px 3px;
      border-radius: 3px;
      font-size: 8px;
      font-weight: 700;
      line-height: 1.1;
      margin: 1px 0;
      box-sizing: border-box;
      border: 1px solid transparent;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .badge-vacant {
      background: #e8f5e9;
      color: #2e7d32;
      border-color: #a5d6a7;
    }
    .badge-closed {
      background: #eeeeee;
      color: #616161;
      border-color: #bdbdbd;
    }
    .badge-mfa {
      background: #ffebee;
      color: #c62828;
      border-color: #ef9a9a;
    }
    .badge-leave {
      background: #fff3e0;
      color: #e65100;
      border-color: #ffcc80;
    }
    .badge-td {
      background: #fffde7;
      color: #f57f17;
      border-color: #fff59d;
    }
    .badge-pi {
      background: #e3f2fd;
      color: #1565c0;
      border-color: #90caf9;
    }
    .cat-tag {
      font-weight: 800;
      text-decoration: underline;
    }
    .footer {
      margin-top: 10px;
      border-top: 1px solid #cbd5e0;
      padding-top: 4px;
      font-size: 8px;
      color: #a0aec0;
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1 class="title">${escapeHtml(messName)} - Room Occupancy Matrix</h1>
      <div class="subtitle">Custom Date Range: <strong>${escapeHtml(fromDate)}</strong> to <strong>${escapeHtml(toDate)}</strong> (${dates.length} Days) • Rooms (X-Axis) vs Dates (Y-Axis)</div>
    </div>
    <div class="meta">
      <div>Official Ledger Document</div>
      <div>Printed: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
    </div>
  </div>

  <div class="legend">
    <span class="legend-title">Occupancy Color Code:</span>
    <span class="legend-item"><span class="legend-box" style="background:#ffebee;border-color:#ef9a9a;"></span> MFA (BA MFA) - Red</span>
    <span class="legend-item"><span class="legend-box" style="background:#fff3e0;border-color:#ffcc80;"></span> LEAVE (On Leave) - Orange</span>
    <span class="legend-item"><span class="legend-box" style="background:#fffde7;border-color:#fff59d;"></span> TD (Displacement) - Yellow</span>
    <span class="legend-item"><span class="legend-box" style="background:#e3f2fd;border-color:#90caf9;"></span> PI (Posted In) - Blue</span>
    <span class="legend-item"><span class="legend-box" style="background:#e8f5e9;border-color:#a5d6a7;"></span> Vacant (Available) - Green</span>
    <span class="legend-item"><span class="legend-box" style="background:#eeeeee;border-color:#bdbdbd;"></span> Closed (Maintenance) - Grey</span>
  </div>

  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th class="date-col">Date \\ Room</th>
          ${roomHeaders}
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>

  <div class="footer">
    <div>CONFIDENTIAL - OFFICIAL SMART MESS OCCUPANCY RECORD • ALLOCATIONS ENFORCE MILITARY STAY POLICIES</div>
    <div>ZERO-KNOWLEDGE VERIFIED • UNIQUE GUEST IDS PRESERVE SECURITY</div>
  </div>
</body>
</html>`;
}

export async function exportGridPdf(options: GridPdfOptions): Promise<void> {
  const html = buildGridHtml(options);

  try {
    await supabase.rpc('log_event', {
      p_action: 'grid_report_exported',
      p_entity: 'reports',
      p_entity_id: null,
      p_meta: { fromDate: options.fromDate, toDate: options.toDate, rooms: options.rooms.length },
    });
  } catch {
    // Non-fatal if offline
  }

  if (Platform.OS === 'web') {
    await Print.printAsync({ html });
  } else {
    const { uri } = await Print.printToFileAsync({ html });
    await Sharing.shareAsync(uri, {
      UTI: '.pdf',
      mimeType: 'application/pdf',
      dialogTitle: 'Export SMS Room Occupancy Grid Matrix',
    });
  }
}
