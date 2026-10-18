/**
 * Occupancy report and insights summary (portrait A4). Pure HTML builders - no React Native.
 */
import {
  CATEGORIES,
  dailyBreakdown,
  occupancyPercent,
  type DailyBreakdownRow,
  type ReportDailyRow,
  type ReportInsights,
  type VisitorCategory,
} from '@sms/core';
import {
  DEFAULT_MESS_NAME,
  KPI_BLOCK,
  SECTION_BLOCK,
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
  tableRowHeight,
  type ReportDocument,
  type SafeHtml,
  type TableColumn,
  type TableRow,
} from './reportDocument';

export interface OccupancyReportOptions {
  periodLabel: string;
  insights: ReportInsights;
  dailyRows: ReportDailyRow[];
  denials?: Array<{ category: string; count: number }>;
  messName?: string;
  generatedBy?: string;
  generatedAt?: Date;
}

const CHART_COLORS = { mfa: '#12283F', pi: '#2F5D8C', leave: '#138808', td: '#C25E00' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weekdayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
}

/** Round the chart axis up to a tidy maximum with at most five steps. */
export function niceAxis(value: number): { max: number; step: number } {
  const target = Math.max(5, value);
  for (const step of [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000]) {
    if (Math.ceil(target / step) <= 5) return { max: Math.ceil(target / step) * step, step };
  }
  return { max: Math.ceil(target / 1000) * 1000, step: 1000 };
}

/** Stacked daily occupancy bars as an inline SVG string (suites excluded). */
export function occupancyChartSvg(days: DailyBreakdownRow[], width: number, height: number): SafeHtml {
  const padL = 30;
  const padR = 6;
  const padT = 10;
  const padB = 22;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const { max, step } = niceAxis(Math.max(0, ...days.map((d) => d.total)));
  const slot = plotW / Math.max(1, days.length);
  const barW = Math.max(4, Math.min(26, slot * 0.7));
  const labelEvery = Math.max(1, Math.ceil(22 / slot));
  const fullLabels = slot * labelEvery >= 40;

  const grid: SafeHtml[] = [];
  for (let v = 0; v <= max; v += step) {
    const y = padT + plotH * (1 - v / max);
    grid.push(
      html`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}" stroke="#DDE2E8" stroke-width="1" /><text x="${padL - 5}" y="${(y + 3).toFixed(1)}" font-size="8" text-anchor="end" fill="#5B6877" font-family="Arial, Helvetica, sans-serif">${v}</text>`,
    );
  }

  const bars: SafeHtml[] = days.map((d, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    let y = padT + plotH;
    const segments = [
      { count: d.mfa, color: CHART_COLORS.mfa },
      { count: d.pi, color: CHART_COLORS.pi },
      { count: d.leave, color: CHART_COLORS.leave },
      { count: d.td, color: CHART_COLORS.td },
    ];
    const rects = segments
      .filter((s) => s.count > 0)
      .map((s) => {
        const h = (s.count / max) * plotH;
        y -= h;
        return html`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${s.color}" />`;
      });
    const label =
      i % labelEvery === 0
        ? html`<text x="${(x + barW / 2).toFixed(1)}" y="${height - 8}" font-size="8" text-anchor="middle" fill="#5B6877" font-family="Arial, Helvetica, sans-serif">${fullLabels ? d.day.slice(5) : d.day.slice(8)}</text>`
        : '';
    return html`${rects}${label}`;
  });

  return html`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily occupancy by visitor category">${grid}${bars}</svg>`;
}

const SECTION_STYLE = `
.legend { display: flex; flex-wrap: wrap; gap: 14px; height: 18px; font-size: 9px; color: #3E4C5C; align-items: center; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.chart-box { border: 1px solid #DDE2E8; padding: 4px 0 0; height: 232px; overflow: hidden; margin-bottom: 8px; }
.chart-box svg { display: block; }
.ins { margin: 0; padding: 0 0 0 16px; font-size: 11px; line-height: 16px; }
.ins li { margin: 0 0 4px; }
tr.peak td { font-weight: 700; background: #FFF3E0; }
`;

function dailyColumns(innerWidth: number): TableColumn[] {
  // Fixed widths summing to the inner page width.
  const fixed = [100, 56, 64, 64, 64, 64, 90, 84];
  const last = innerWidth - fixed.reduce((a, b) => a + b, 0);
  const widths = [...fixed, last];
  const headers = ['Date', 'Day', 'MFA', 'PI', 'Leave', 'TD', 'Total', 'VVIP Suite', 'Occupancy'];
  return headers.map((header, i) => ({
    header,
    width: widths[i],
    align: i < 2 ? 'left' : 'right',
  }));
}

function dailyRows(days: DailyBreakdownRow[], bedsTotal: number, peakDay: string): TableRow[] {
  return days.map((d) => ({
    height: tableRowHeight(1),
    className: d.day === peakDay && d.total > 0 ? 'peak' : '',
    cells: [
      html`${d.day}`,
      html`${weekdayOf(d.day)}`,
      html`${d.mfa}`,
      html`${d.pi}`,
      html`${d.leave}`,
      html`${d.td}`,
      html`${d.total}`,
      html`${d.suite}`,
      html`${bedsTotal > 0 ? `${occupancyPercent(d.total, bedsTotal)}%` : '-'}`,
    ],
  }));
}

function kpisFor(insights: ReportInsights) {
  return [
    { label: 'Total guest-days', value: String(insights.totalGuestDays), hint: 'excl. VVIP suites' },
    { label: 'Daily average', value: insights.dailyAverage.toFixed(1), hint: 'guests per day' },
    {
      label: 'Peak occupancy',
      value: `${insights.peakCount} (${insights.peakOccupancyPercentage}%)`,
      hint: insights.peakDay || 'no data',
    },
    { label: 'Priority share', value: `${insights.mfaPiSharePercentage}%`, hint: 'BA MFA + Posted In' },
    { label: 'Bed inventory', value: String(insights.bedsTotal), hint: 'active non-suite beds' },
  ];
}

function baseMeta(options: OccupancyReportOptions, title: string, records: string) {
  const generatedAt = options.generatedAt ?? new Date();
  return {
    generatedAt,
    meta: {
      messName: options.messName ?? DEFAULT_MESS_NAME,
      title,
      subtitle: `Reporting period: ${options.periodLabel}`,
      details: [
        { label: 'Period', value: options.periodLabel },
        { label: 'Records', value: records },
      ],
      generatedAt,
      generatedBy: options.generatedBy,
    },
  };
}

/** Occupancy report: KPI strip, stacked daily chart and the day-by-day table. */
export function buildOccupancyReport(options: OccupancyReportOptions): ReportDocument {
  const { insights, dailyRows: rows, periodLabel } = options;
  const geometry = pageGeometry('portrait');
  const days = dailyBreakdown(rows);
  const tableRows = dailyRows(days, insights.bedsTotal, insights.peakDay);
  const columns = dailyColumns(geometry.innerWidth);
  const { meta, generatedAt } = baseMeta(options, 'Room Occupancy Report', `${days.length} day(s)`);

  const chartHeight = 220;
  const intro = html`${kpiStripHtml(kpisFor(insights))}
    ${sectionTitleHtml('Daily occupancy by visitor category (VVIP suites excluded)')}
    <div class="legend">
      <span><i style="background:${CHART_COLORS.mfa}"></i>BA MFA</span>
      <span><i style="background:${CHART_COLORS.pi}"></i>Posted In (PI)</span>
      <span><i style="background:${CHART_COLORS.leave}"></i>On leave</span>
      <span><i style="background:${CHART_COLORS.td}"></i>Temporary displacement</span>
    </div>
    <div class="chart-box">${
      days.length > 0
        ? occupancyChartSvg(days, geometry.innerWidth, chartHeight)
        : html`<p class="note" style="padding:16px">No occupancy records in this period.</p>`
    }</div>`;

  const used = KPI_BLOCK + SECTION_BLOCK + 18 + 232 + 8;
  const left = bodyCapacity(geometry, true) - used;
  const flowed = flowTable(tableRows, geometry, left);
  const title = sectionTitleHtml('Day-by-day occupancy');

  const pages: SafeHtml[] = [];
  let rowCursor = 0;
  const chunk = (pageRows: TableRow[]) => {
    const t = tableHtml(columns, pageRows, rowCursor);
    rowCursor += pageRows.length;
    return t;
  };
  if (flowed.firstPageRows) {
    pages.push(html`${intro}${tableRows.length > 0 ? html`${title}${chunk(flowed.firstPageRows)}` : ''}`);
  } else {
    pages.push(intro);
  }
  flowed.laterPages.forEach((pageRows, i) => {
    pages.push(html`${!flowed.firstPageRows && i === 0 ? title : ''}${chunk(pageRows)}`);
  });

  const htmlDoc = composeReportHtml({
    meta,
    orientation: 'portrait',
    pages,
    footerNote: 'CONFIDENTIAL - OFFICIAL OCCUPANCY RECORD - NO GUEST IDENTIFIERS INCLUDED',
    extraCss: SECTION_STYLE,
  });

  return {
    kind: 'occupancy',
    title: meta.title,
    fileName: reportFileName(meta.title, generatedAt, periodLabel),
    orientation: 'portrait',
    pageCount: pages.length,
    html: htmlDoc,
    summary: {
      kpis: kpisFor(insights).map((k) => ({ label: k.label, value: k.value })),
      lines: [
        `${days.length} day(s) of occupancy data for ${periodLabel}.`,
        ...(insights.peakDay ? [`Peak day: ${insights.peakDay} with ${insights.peakCount} guests.`] : []),
      ],
    },
    audit: {
      action: 'report_exported',
      entity: 'reports',
      meta: { report: 'occupancy', period: periodLabel, pages: pages.length },
    },
  };
}

const CATEGORY_ORDER: VisitorCategory[] = ['MFA', 'PI', 'LEAVE', 'TD'];

function categoryPolicy(code: VisitorCategory): string {
  return CATEGORIES[code].canBeDenied
    ? 'Low priority - may be denied with a written reason'
    : 'Protected - never denied';
}

/** One-page insights summary: KPIs, written findings and the category / denials table. */
export function buildInsightsReport(options: OccupancyReportOptions): ReportDocument {
  const { insights, dailyRows: rows, denials = [], periodLabel } = options;
  const geometry = pageGeometry('portrait');
  const days = dailyBreakdown(rows);
  const { meta, generatedAt } = baseMeta(options, 'Operational Insights Summary', `${days.length} day(s)`);

  const totals = { MFA: 0, PI: 0, LEAVE: 0, TD: 0 } as Record<VisitorCategory, number>;
  let suiteDays = 0;
  for (const d of days) {
    totals.MFA += d.mfa;
    totals.PI += d.pi;
    totals.LEAVE += d.leave;
    totals.TD += d.td;
    suiteDays += d.suite;
  }
  const general = CATEGORY_ORDER.reduce((sum, c) => sum + totals[c], 0);
  const deniedBy = (code: string) => denials.find((d) => d.category === code)?.count ?? 0;

  const columns: TableColumn[] = [
    { header: 'Visitor category', width: 150 },
    { header: 'Guest-days', width: 80, align: 'right' },
    { header: 'Share', width: 70, align: 'right' },
    { header: 'Denials', width: 70, align: 'right' },
    { header: 'Policy', width: geometry.innerWidth - 370 },
  ];
  const categoryRows: TableRow[] = CATEGORY_ORDER.map((code) => {
    const policy = categoryPolicy(code);
    return {
      height: tableRowHeight(estimateLines(policy, columns[4].width - 12, 10)),
      cells: [
        html`${CATEGORIES[code].name} (${code})`,
        html`${totals[code]}`,
        html`${general > 0 ? `${Math.round((totals[code] / general) * 100)}%` : '-'}`,
        html`${deniedBy(code)}`,
        html`${policy}`,
      ],
    };
  });
  categoryRows.push({
    height: tableRowHeight(1),
    cells: [html`VVIP suites (separate)`, html`${suiteDays}`, html`-`, html`-`, html`Accounted outside general inventory`],
  });

  const page = html`${kpiStripHtml(kpisFor(insights))}
    ${sectionTitleHtml('Key findings')}
    <ul class="ins">${insights.writtenInsights.map((line) => html`<li>${line}</li>`)}</ul>
    ${sectionTitleHtml('Visitor categories and denials')}
    ${tableHtml(columns, categoryRows)}
    <p class="note" style="margin-top:10px">Guest-days count general mess inventory only; VVIP suite stays are reported separately. Denials are the requests recorded as denied in the reporting period.</p>`;

  const htmlDoc = composeReportHtml({
    meta,
    orientation: 'portrait',
    pages: [page],
    footerNote: 'CONFIDENTIAL - OFFICIAL OCCUPANCY RECORD - NO GUEST IDENTIFIERS INCLUDED',
    extraCss: SECTION_STYLE,
  });

  return {
    kind: 'insights',
    title: meta.title,
    fileName: reportFileName(meta.title, generatedAt, periodLabel),
    orientation: 'portrait',
    pageCount: 1,
    html: htmlDoc,
    summary: {
      kpis: kpisFor(insights).map((k) => ({ label: k.label, value: k.value })),
      lines: insights.writtenInsights,
    },
    audit: {
      action: 'report_exported',
      entity: 'reports',
      meta: { report: 'insights', period: periodLabel, pages: 1 },
    },
  };
}
