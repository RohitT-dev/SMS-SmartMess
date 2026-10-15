import { Platform } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import type { ReportDailyRow, ReportInsights } from '@sms/core';
import { supabase } from '../../lib/supabase';

export interface GeneratePdfOptions {
  periodLabel: string;
  insights: ReportInsights;
  dailyRows: ReportDailyRow[];
  denials?: Array<{ category: string; count: number }>;
}

export function buildHtmlReport({
  periodLabel,
  insights,
  dailyRows,
  denials = []
}: GeneratePdfOptions): string {
  // Build inline SVG for the chart
  const daysMap = new Map<string, { msa: number; pi: number; leave: number; td: number; suite: number; total: number }>();

  for (const r of dailyRows) {
    let entry = daysMap.get(r.day);
    if (!entry) {
      entry = { msa: 0, pi: 0, leave: 0, td: 0, suite: 0, total: 0 };
      daysMap.set(r.day, entry);
    }
    if (r.roomType === 'SUITE') {
      entry.suite += r.people;
    } else {
      if (r.category === 'MSA') entry.msa += r.people;
      if (r.category === 'PI') entry.pi += r.people;
      if (r.category === 'LEAVE') entry.leave += r.people;
      if (r.category === 'TD') entry.td += r.people;
      entry.total += r.people;
    }
  }

  const days = Array.from(daysMap.keys()).sort();
  const maxTotal = Math.max(10, ...Array.from(daysMap.values()).map((d) => d.total));

  const chartWidth = 700;
  const chartHeight = 220;
  const padL = 40;
  const padR = 20;
  const padT = 20;
  const padB = 30;
  const plotW = chartWidth - padL - padR;
  const plotH = chartHeight - padT - padB;
  const barW = Math.max(10, Math.min(28, (plotW / (days.length || 1)) * 0.7));

  let barsSvg = '';
  days.forEach((day, idx) => {
    const d = daysMap.get(day)!;
    const x = padL + (idx + 0.5) * (plotW / days.length) - barW / 2;
    let currY = padT + plotH;

    const segs = [
      { c: d.msa, col: '#12283F' },
      { c: d.pi, col: '#2F5D8C' },
      { c: d.leave, col: '#138808' },
      { c: d.td, col: '#C25E00' }
    ];

    segs.forEach((s) => {
      if (s.c <= 0) return;
      const h = (s.c / maxTotal) * plotH;
      currY -= h;
      barsSvg += `<rect x="${x}" y="${currY}" width="${barW}" height="${h}" fill="${s.col}" />`;
    });

    barsSvg += `<text x="${x + barW / 2}" y="${chartHeight - 10}" font-size="9" text-anchor="middle" fill="#5B6877">${day.slice(5)}</text>`;
  });

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Smart Mess System - Occupancy Report</title>
  <style>
    @page { size: A4 portrait; margin: 20mm; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1B2733; line-height: 1.4; }
    .header { border-bottom: 3px solid #FF9933; padding-bottom: 12px; margin-bottom: 20px; }
    .title { font-size: 24px; font-weight: bold; color: #12283F; margin: 0; }
    .subtitle { font-size: 13px; color: #5B6877; margin-top: 4px; }
    .grid { display: flex; gap: 16px; margin-bottom: 20px; }
    .stat-card { flex: 1; border: 1px solid #DDE2E8; border-radius: 4px; padding: 12px; background: #F4F6F8; }
    .stat-label { font-size: 10px; font-weight: bold; color: #5B6877; text-transform: uppercase; }
    .stat-value { font-size: 22px; font-weight: bold; color: #12283F; margin-top: 4px; }
    .section-title { font-size: 14px; font-weight: bold; color: #12283F; border-bottom: 1px solid #DDE2E8; padding-bottom: 4px; margin-top: 24px; margin-bottom: 12px; }
    .legend { display: flex; gap: 16px; font-size: 11px; margin-bottom: 8px; }
    .legend-item { display: flex; align-items: center; gap: 6px; }
    .legend-box { width: 12px; height: 12px; border-radius: 2px; }
    .insights-list { list-style: disc; padding-left: 20px; font-size: 12px; }
    .insights-list li { margin-bottom: 6px; }
    .table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
    .table th, .table td { border: 1px solid #DDE2E8; padding: 8px; text-align: left; }
    .table th { background: #F4F6F8; }
    .footer { position: fixed; bottom: 0; left: 0; right: 0; text-align: center; font-size: 10px; color: #8795A5; border-top: 1px solid #DDE2E8; padding-top: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <h1 class="title">Smart Mess System (SMS)</h1>
    <div class="subtitle">Official Room Inventory & Occupancy Report | Period: ${periodLabel} | Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
  </div>

  <div class="grid">
    <div class="stat-card">
      <div class="stat-label">Total Guest-Days</div>
      <div class="stat-value">${insights.totalPeopleDays}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Daily Average</div>
      <div class="stat-value">${insights.dailyAverage.toFixed(1)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Peak Occupancy</div>
      <div class="stat-value">${insights.peakCount} (${insights.peakOccupancyPercentage}%)</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Priority Share</div>
      <div class="stat-value">${insights.msaPiSharePercentage}%</div>
    </div>
  </div>

  <div class="section-title">Date vs People Occupancy Chart (Excluding VVIP Suites)</div>
  <div class="legend">
    <div class="legend-item"><div class="legend-box" style="background:#12283F"></div> BA MSA</div>
    <div class="legend-item"><div class="legend-box" style="background:#2F5D8C"></div> Posted In (PI)</div>
    <div class="legend-item"><div class="legend-box" style="background:#138808"></div> Leave</div>
    <div class="legend-item"><div class="legend-box" style="background:#C25E00"></div> Temp Displacement</div>
  </div>

  <svg width="${chartWidth}" height="${chartHeight}" style="background:#FFFFFF; border:1px solid #DDE2E8; border-radius:4px;">
    ${barsSvg}
  </svg>

  <div class="section-title">Operational Insights</div>
  <ul class="insights-list">
    ${insights.writtenInsights.map((i) => `<li>${i}</li>`).join('')}
  </ul>

  <div class="section-title">Booking Denials Summary</div>
  <table class="table">
    <thead>
      <tr><th>Visitor Category</th><th>Recorded Denials Count</th><th>Priority Level</th></tr>
    </thead>
    <tbody>
      <tr><td>Leave (LEAVE)</td><td>${denials.find((d) => d.category === 'LEAVE')?.count || 0}</td><td>Low (Eligible for denial)</td></tr>
      <tr><td>Temporary Displacement (TD)</td><td>${denials.find((d) => d.category === 'TD')?.count || 0}</td><td>Low (Eligible for denial)</td></tr>
      <tr><td>BA MSA (MSA)</td><td>0</td><td>Highest (Mandatory - Never denied)</td></tr>
      <tr><td>Posted In (PI)</td><td>0</td><td>High (Mandatory - Never denied)</td></tr>
    </tbody>
  </table>

  <div class="footer">
    CONFIDENTIAL - OFFICIAL RESIDENTIAL MESS INVENTORY RECORDS - NO PERSONAL IDENTIFIABLE DATA (PII) INCLUDED
  </div>
</body>
</html>
`;
}

export async function exportReportPdf(options: GeneratePdfOptions): Promise<void> {
  const html = buildHtmlReport(options);

  // Audit export through log_event RPC
  try {
    await supabase.rpc('log_event', {
      p_action: 'report_exported',
      p_entity: 'reports',
      p_entity_id: null,
      p_meta: { period: options.periodLabel }
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
      dialogTitle: 'Export SMS Occupancy Report'
    });
  }
}
