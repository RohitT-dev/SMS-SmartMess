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
}

export interface PastBookingsPdfOptions {
  title?: string;
  bookings: PastBookingPdfItem[];
  filterLabel?: string;
}

export function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildPastBookingsHtml({
  title = "OFFICERS' MESS - PAST BOOKINGS REGISTER",
  bookings,
  filterLabel = 'All Completed & Past Stays',
}: PastBookingsPdfOptions): string {
  const generatedAt = new Date().toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const totalBookings = bookings.length;
  const totalNights = bookings.reduce((sum, b) => sum + (b.nights || 0), 0);
  const mfaCount = bookings.filter((b) => b.category === 'MFA').length;
  const piCount = bookings.filter((b) => b.category === 'PI').length;
  const leaveCount = bookings.filter((b) => b.category === 'LEAVE').length;
  const tdCount = bookings.filter((b) => b.category === 'TD').length;

  const rowsHtml = bookings
    .map(
      (b, idx) => `
    <tr>
      <td style="text-align: center; font-weight: bold;">${idx + 1}</td>
      <td style="font-family: monospace; font-size: 11px;">#${b.id.slice(0, 8)}</td>
      <td>
        <strong>${escapeHtml(b.guestRank)} ${escapeHtml(b.guestName)}</strong>
        ${b.serviceNumber ? `<div style="font-size: 10px; color: #5B6877;">No: ${escapeHtml(b.serviceNumber)}</div>` : ''}
        ${b.unit ? `<div style="font-size: 10px; color: #5B6877;">Unit: ${escapeHtml(b.unit)}</div>` : ''}
      </td>
      <td style="text-align: center;">
        <span class="badge badge-${b.category.toLowerCase()}">${b.category}</span>
      </td>
      <td>${b.checkIn} to ${b.checkOut}</td>
      <td style="text-align: center; font-weight: bold;">${b.nights}</td>
      <td>${escapeHtml(b.rooms || '—')}</td>
      <td style="text-align: center;">
        <span class="badge badge-${b.status === 'CONFIRMED' || b.status === 'COMPLETED' ? 'confirmed' : 'cancelled'}">
          ${b.status}
        </span>
      </td>
    </tr>
  `,
    )
    .join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4 landscape; margin: 15mm; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #1B2733;
      line-height: 1.35;
      margin: 0;
      padding: 0;
    }
    .header {
      border-bottom: 3px solid #12283F;
      padding-bottom: 12px;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .title {
      font-size: 20px;
      font-weight: 800;
      color: #12283F;
      letter-spacing: 0.5px;
      margin: 0;
    }
    .subtitle {
      font-size: 12px;
      color: #5B6877;
      margin-top: 4px;
    }
    .meta {
      text-align: right;
      font-size: 11px;
      color: #5B6877;
    }
    .grid {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
    }
    .stat-card {
      flex: 1;
      border: 1px solid #DDE2E8;
      border-radius: 4px;
      padding: 10px;
      background: #F4F6F8;
    }
    .stat-label {
      font-size: 10px;
      font-weight: bold;
      color: #5B6877;
      text-transform: uppercase;
    }
    .stat-value {
      font-size: 20px;
      font-weight: bold;
      color: #12283F;
      margin-top: 2px;
    }
    .table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
    }
    .table th, .table td {
      border: 1px solid #DDE2E8;
      padding: 6px 8px;
      text-align: left;
    }
    .table th {
      background: #12283F;
      color: #FFFFFF;
      font-weight: 600;
      font-size: 10px;
      text-transform: uppercase;
    }
    .table tr:nth-child(even) {
      background: #FAFBFD;
    }
    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 700;
    }
    .badge-mfa { background: #FFEBEE; color: #C62828; border: 1px solid #EF9A9A; }
    .badge-pi { background: #E3F2FD; color: #1565C0; border: 1px solid #90CAF9; }
    .badge-leave { background: #FFF3E0; color: #E65100; border: 1px solid #FFCC80; }
    .badge-td { background: #FFFDE7; color: #F57F17; border: 1px solid #FFF59D; }
    .badge-confirmed { background: #E8F5E9; color: #2E7D32; border: 1px solid #A5D6A7; }
    .badge-cancelled { background: #ECEFF1; color: #546E7A; border: 1px solid #CFD8DC; }
    .footer {
      margin-top: 20px;
      padding-top: 8px;
      border-top: 1px solid #DDE2E8;
      font-size: 10px;
      color: #7A8699;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="title">${escapeHtml(title)}</div>
      <div class="subtitle">Scope: ${escapeHtml(filterLabel)}</div>
    </div>
    <div class="meta">
      <div><strong>Date Generated:</strong> ${generatedAt}</div>
      <div><strong>Total Records:</strong> ${totalBookings}</div>
    </div>
  </div>

  <div class="grid">
    <div class="stat-card">
      <div class="stat-label">Total Past Stays</div>
      <div class="stat-value">${totalBookings}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Nights Hosted</div>
      <div class="stat-value">${totalNights}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">MFA Stays</div>
      <div class="stat-value" style="color: #C62828;">${mfaCount}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">PI Stays</div>
      <div class="stat-value" style="color: #1565C0;">${piCount}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Leave Stays</div>
      <div class="stat-value" style="color: #E65100;">${leaveCount}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">TD Stays</div>
      <div class="stat-value" style="color: #F57F17;">${tdCount}</div>
    </div>
  </div>

  <table class="table">
    <thead>
      <tr>
        <th style="width: 35px; text-align: center;">S.No</th>
        <th style="width: 75px;">Booking ID</th>
        <th>Guest Details</th>
        <th style="width: 60px; text-align: center;">Category</th>
        <th style="width: 140px;">Stay Period</th>
        <th style="width: 45px; text-align: center;">Nights</th>
        <th>Rooms Allotted</th>
        <th style="width: 75px; text-align: center;">Status</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || '<tr><td colspan="8" style="text-align:center; padding: 20px;">No past bookings found.</td></tr>'}
    </tbody>
  </table>

  <div class="footer">
    CONFIDENTIAL - OFFICIAL ARMED FORCES MESS PROPERTY - NOT FOR PUBLIC DISSEMINATION
  </div>
</body>
</html>
  `;
}
