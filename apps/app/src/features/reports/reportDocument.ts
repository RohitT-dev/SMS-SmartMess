/**
 * Standalone report documents.
 *
 * Every report (occupancy, insights, past bookings, room grid) is turned into a self-contained
 * A4 HTML document made of fixed-size `.page` sheets. The document is rendered in an isolated
 * iframe / blob window on the web and handed to expo-print on native - it is never the app page.
 *
 * Pages are laid out by us (not by the browser's fragmentation), so each sheet carries a real
 * "Page X of Y", repeats its own table header, and never cuts a row: builders split their rows
 * into pages with `paginate()` using conservative row-height estimates.
 *
 * This file is pure (no React Native imports) so the builders can be unit-tested in Node.
 */

// ---------------------------------------------------------------------------
// Safe HTML templating
// ---------------------------------------------------------------------------

/** A string that is already HTML and must not be escaped again. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Marks a string as trusted markup. Only use it for markup built by this module. */
export const raw = (value: string): SafeHtml => new SafeHtml(value);

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderValue(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
}

/**
 * Tagged template that escapes every interpolation unless it is a `SafeHtml` (a nested `html`
 * template or `raw()`), so dynamic strings can never inject markup into a report.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += renderValue(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

// ---------------------------------------------------------------------------
// Types shared by all report builders
// ---------------------------------------------------------------------------

export const DEFAULT_MESS_NAME = 'Residential Officers Mess';

export type PageOrientation = 'portrait' | 'landscape';
export type ReportKind = 'occupancy' | 'insights' | 'past_bookings' | 'grid' | 'guest_report';

export interface ReportMeta {
  messName: string;
  title: string;
  /** One line under the title: period, scope or filter. */
  subtitle?: string;
  /** Extra label/value pairs for the masthead strip (Period, Records, ...). */
  details?: Array<{ label: string; value: string }>;
  generatedAt: Date;
  generatedBy?: string;
}

/** What the native preview shows instead of the rendered document. */
export interface ReportSummary {
  kpis: Array<{ label: string; value: string }>;
  lines: string[];
}

/** A finished report: the standalone HTML plus what the preview and the exporter need. */
export interface ReportDocument {
  kind: ReportKind;
  title: string;
  /** Suggested file name, without extension. */
  fileName: string;
  orientation: PageOrientation;
  pageCount: number;
  /** Standalone A4 document (scale 1). */
  html: string;
  summary: ReportSummary;
  /** Audit-log entry written when the user actually prints/saves/shares it. No PII. */
  audit: { action: string; entity: string; meta: Record<string, string | number> };
}

// ---------------------------------------------------------------------------
// Page geometry (CSS px at 96 dpi; A4 = 793 x 1122 so a sheet never overflows the paper)
// ---------------------------------------------------------------------------

export interface PageGeometry {
  orientation: PageOrientation;
  width: number;
  height: number;
  padX: number;
  padTop: number;
  padBottom: number;
  /** Usable width inside the side padding. */
  innerWidth: number;
  /** Usable height between top and bottom padding. */
  innerHeight: number;
}

const SHEET_SHORT = 793;
const SHEET_LONG = 1122;
const PAD_X = 36;
const PAD_TOP = 32;
const PAD_BOTTOM = 24;

export function pageGeometry(orientation: PageOrientation): PageGeometry {
  const width = orientation === 'portrait' ? SHEET_SHORT : SHEET_LONG;
  const height = orientation === 'portrait' ? SHEET_LONG : SHEET_SHORT;
  return {
    orientation,
    width,
    height,
    padX: PAD_X,
    padTop: PAD_TOP,
    padBottom: PAD_BOTTOM,
    innerWidth: width - PAD_X * 2,
    innerHeight: height - PAD_TOP - PAD_BOTTOM,
  };
}

/** Vertical blocks (px, margins included). The CSS below pins these exact heights. */
export const MASTHEAD_BLOCK = 118;
export const RUNNING_HEAD_BLOCK = 30;
export const FOOT_BLOCK = 28;
export const KPI_BLOCK = 68;
export const SECTION_BLOCK = 36;
export const TABLE_HEAD_H = 24;
/** Slack left at the bottom of every page so a wrong text-width estimate cannot clip a row. */
const SAFETY_PX = 16;

/** Height available for body content on a page (first page carries the masthead). */
export function bodyCapacity(geometry: PageGeometry, firstPage: boolean): number {
  return (
    geometry.innerHeight -
    FOOT_BLOCK -
    (firstPage ? MASTHEAD_BLOCK : RUNNING_HEAD_BLOCK) -
    SAFETY_PX
  );
}

/**
 * Splits items into pages. `firstCapacity` / `capacity` are the px available for items on the
 * first and later pages; an item taller than a page still gets a page of its own. Always returns
 * at least one (possibly empty) page.
 */
export function paginate<T>(
  items: T[],
  heightOf: (item: T) => number,
  firstCapacity: number,
  capacity: number,
): T[][] {
  const pages: T[][] = [[]];
  let used = 0;
  let limit = Math.max(0, firstCapacity);
  for (const item of items) {
    const h = heightOf(item);
    const current = pages[pages.length - 1];
    if (current.length > 0 && used + h > limit) {
      pages.push([]);
      used = 0;
      limit = Math.max(0, capacity);
    }
    pages[pages.length - 1].push(item);
    used += h;
  }
  return pages;
}

export interface FlowedTable<T> {
  /** Rows that fit on the first page after the intro content, or null if the table starts on page 2. */
  firstPageRows: T[] | null;
  /** Remaining pages of rows (page 2 onwards). The section title belongs on the first of these when firstPageRows is null. */
  laterPages: T[][];
}

/**
 * Lays a table out after the intro content of page 1. `leftOnFirstPage` is the body height still
 * free on page 1; the section title (if `titled`) and the repeated header row are budgeted here.
 * The table only starts on page 1 when at least two rows fit, so a header is never orphaned.
 */
export function flowTable<T extends { height: number }>(
  rows: T[],
  geometry: PageGeometry,
  leftOnFirstPage: number,
  titled = true,
): FlowedTable<T> {
  if (rows.length === 0) return { firstPageRows: [], laterPages: [] };
  const title = titled ? SECTION_BLOCK : 0;
  const laterBody = bodyCapacity(geometry, false) - TABLE_HEAD_H;
  const available = leftOnFirstPage - title - TABLE_HEAD_H;
  const minimum = rows.slice(0, 2).reduce((sum, r) => sum + r.height, 0);
  if (available >= minimum) {
    const [first, ...rest] = paginate(rows, (r) => r.height, available, laterBody);
    return { firstPageRows: first, laterPages: rest };
  }
  return {
    firstPageRows: null,
    laterPages: paginate(rows, (r) => r.height, laterBody - title, laterBody),
  };
}

// ---------------------------------------------------------------------------
// Text measurement (no DOM in Node/native, so estimate conservatively)
// ---------------------------------------------------------------------------

const NARROW = new Set("iljtfr.,:;!|'()-/[]".split(''));
const WIDE = new Set('mwMW@%&'.split(''));

/** Average glyph advance in em for Arial/Helvetica, rounded up a little so estimates err wide. */
function charEm(ch: string): number {
  if (ch === ' ') return 0.28;
  if (NARROW.has(ch)) return 0.3;
  if (WIDE.has(ch)) return 0.9;
  if (ch >= 'A' && ch <= 'Z') return 0.7;
  if (ch >= '0' && ch <= '9') return 0.56;
  if (ch >= 'a' && ch <= 'z') return 0.55;
  if (ch.charCodeAt(0) > 0x7f) return 1;
  return 0.62;
}

/** Estimated rendered width (px) of one unbroken string. Slightly pessimistic on purpose. */
export function estimateTextWidth(text: string, fontPx: number, bold = false): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * fontPx * (bold ? 1.1 : 1.04);
}

/** Text is only assumed to fit when it uses at most this share of the box (browsers differ a little). */
const WRAP_FILL = 0.95;

/** Number of lines `text` wraps to in a box `widthPx` wide (greedy word wrap, long words broken). */
export function estimateLines(text: string, widthPx: number, fontPx: number, bold = false): number {
  const width = Math.max(10, widthPx * WRAP_FILL);
  const space = estimateTextWidth(' ', fontPx, bold);
  let lines = 0;
  for (const paragraph of String(text ?? '').split('\n')) {
    let count = 1;
    let cursor = 0; // width used on the current line
    for (const word of paragraph.split(' ').filter(Boolean)) {
      const w = estimateTextWidth(word, fontPx, bold);
      if (w > width) {
        // Too long for any line: start on a fresh line and break it mid-word (overflow-wrap: anywhere).
        if (cursor > 0) count += 1;
        const wordLines = Math.ceil(w / width);
        count += wordLines - 1;
        cursor = w - (wordLines - 1) * width;
      } else if (cursor === 0) {
        cursor = w;
      } else if (cursor + space + w <= width) {
        cursor += space + w;
      } else {
        count += 1;
        cursor = w;
      }
    }
    lines += count;
  }
  return Math.max(1, lines);
}

/** Table geometry shared by the CSS and the height estimates. */
export const TABLE_FONT_PX = 10;
export const TABLE_LINE_PX = 13;
export const CELL_PAD_X = 6;
export const CELL_PAD_Y = 4;
export const ROW_BORDER_PX = 1;

/** Rendered height of a table row whose tallest cell wraps to `lines` lines. */
export function tableRowHeight(lines: number): number {
  // +1px: rows holding an inline badge render about a pixel taller than plain text rows.
  return Math.max(1, lines) * TABLE_LINE_PX + CELL_PAD_Y * 2 + ROW_BORDER_PX + 1;
}

/** Lines needed by stacked text pieces in a column `colWidth` wide (cell padding removed). */
export function cellLineCount(pieces: Array<string | null | undefined>, colWidth: number, bold = false): number {
  const inner = colWidth - CELL_PAD_X * 2;
  let total = 0;
  for (const piece of pieces) {
    if (piece === null || piece === undefined || piece === '') continue;
    total += estimateLines(piece, inner, TABLE_FONT_PX, bold);
  }
  return Math.max(1, total);
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export interface TableColumn {
  header: string | SafeHtml;
  /** px width; the table uses fixed layout so these are what the height estimates assume. */
  width: number;
  align?: 'left' | 'center' | 'right';
}

export interface TableRow {
  cells: SafeHtml[];
  /** Estimated rendered height in px (from `tableRowHeight`). */
  height: number;
  className?: string;
  /** Force the zebra shading; by default rows alternate by their position in the table. */
  zebra?: boolean;
  /** Extra class per cell (same order as `cells`). */
  cellClasses?: string[];
}

/** A table chunk for one page. The header row is repeated on every page by the caller. */
export function tableHtml(
  columns: TableColumn[],
  rows: TableRow[],
  firstRowIndex = 0,
  className = '',
): SafeHtml {
  const cols = columns.map((c) => html`<col style="width:${c.width}px" />`);
  const head = columns.map(
    (c) => html`<th class="${c.align ? `a-${c.align}` : ''}">${c.header}</th>`,
  );
  const body = rows.map((row, i) => {
    const zebra = (row.zebra ?? (firstRowIndex + i) % 2 === 1) ? 'z' : '';
    const cells = row.cells.map((cell, ci) => {
      const align = columns[ci]?.align ? `a-${columns[ci].align}` : '';
      return html`<td class="${[align, row.cellClasses?.[ci] ?? ''].filter(Boolean).join(' ')}">${cell}</td>`;
    });
    return html`<tr class="${[zebra, row.className ?? ''].filter(Boolean).join(' ')}">${cells}</tr>`;
  });
  return html`<table class="${['data', className].filter(Boolean).join(' ')}"><colgroup>${cols}</colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function kpiStripHtml(kpis: Array<{ label: string; value: string; hint?: string }>): SafeHtml {
  return html`<div class="kpis">${kpis.map(
    (k) =>
      html`<div class="kpi"><div class="kpi-label">${k.label}</div><div class="kpi-value">${k.value}</div>${k.hint ? html`<div class="kpi-hint">${k.hint}</div>` : ''}</div>`,
  )}</div>`;
}

export function sectionTitleHtml(text: string): SafeHtml {
  return html`<h2 class="sec">${text}</h2>`;
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "2026-10-18 17:42" in the viewer's local time. */
export function formatGeneratedAt(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** File-name safe slug: "Past Bookings Register" -> "Past-Bookings-Register". */
export function fileSlug(text: string): string {
  const slug = text
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'report';
}

export function reportFileName(title: string, generatedAt: Date, extra?: string): string {
  const date = formatGeneratedAt(generatedAt).slice(0, 10);
  return [fileSlug(title), extra ? fileSlug(extra) : '', date].filter(Boolean).join('_');
}

function mastheadHtml(meta: ReportMeta): SafeHtml {
  const details = [
    ...(meta.details ?? []),
    { label: 'Generated', value: formatGeneratedAt(meta.generatedAt) },
    ...(meta.generatedBy ? [{ label: 'Generated by', value: meta.generatedBy }] : []),
  ];
  return html`<header class="masthead">
    <div class="mh-top"><span class="mh-mess">${meta.messName}</span><span class="mh-tag">Official record - confidential</span></div>
    <h1 class="mh-title">${meta.title}</h1>
    <div class="mh-sub">${meta.subtitle ?? ''}</div>
    <div class="mh-meta">${details.map(
      (d) => html`<div class="mh-item"><span class="mh-label">${d.label}</span><span class="mh-value">${d.value}</span></div>`,
    )}</div>
  </header>`;
}

function runningHeadHtml(meta: ReportMeta): SafeHtml {
  const left = [meta.title, meta.subtitle].filter(Boolean).join(' - ');
  return html`<header class="running-head"><span class="rh-left">${left}</span><span class="rh-right">${meta.messName}</span></header>`;
}

function baseCss(geometry: PageGeometry): string {
  const { width, height, padX, padTop, padBottom, orientation } = geometry;
  return `
@page { size: A4 ${orientation}; margin: 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; padding: 0; }
body { font-family: Arial, "Helvetica Neue", Helvetica, sans-serif; font-size: 11px; line-height: 1.3; color: #1B2733; background: #FFFFFF; }
.page { position: relative; width: ${width}px; height: ${height}px; padding: ${padTop}px ${padX}px ${padBottom}px; background: #FFFFFF; display: flex; flex-direction: column; break-after: page; page-break-after: always; break-inside: avoid; page-break-inside: avoid; }
.page:last-child { break-after: auto; page-break-after: auto; }
.page-body { flex: 1 1 auto; min-height: 0; }
@media screen { body { background: #DDE2E8; padding: 16px 0 1px; } .page { margin: 0 auto 16px; box-shadow: 0 1px 8px rgba(18, 40, 63, 0.3); } }
@media print { body { background: #FFFFFF; padding: 0; } .page { margin: 0; box-shadow: none; } }

.masthead { height: 108px; margin-bottom: 10px; border-bottom: 2px solid #12283F; position: relative; padding-left: 10px; overflow: hidden; }
.masthead::before { content: ""; position: absolute; left: 0; top: 2px; bottom: 8px; width: 4px; background: #FF9933; }
.mh-top { height: 14px; line-height: 14px; display: flex; justify-content: space-between; font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: #5B6877; font-weight: 700; }
.mh-title { margin: 2px 0 0; height: 28px; line-height: 28px; font-size: 22px; font-weight: 700; color: #12283F; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mh-sub { height: 16px; line-height: 16px; font-size: 12px; color: #3E4C5C; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mh-meta { margin-top: 8px; height: 30px; display: flex; gap: 14px; }
.mh-item { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
.mh-label { font-size: 8px; letter-spacing: 0.6px; text-transform: uppercase; color: #7A8699; font-weight: 700; line-height: 11px; }
.mh-value { font-size: 11px; font-weight: 700; color: #1B2733; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.running-head { height: 22px; margin-bottom: 8px; border-bottom: 1px solid #C5CDD6; display: flex; justify-content: space-between; align-items: flex-start; font-size: 9px; color: #5B6877; overflow: hidden; }
.rh-left { font-weight: 700; color: #12283F; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 12px; }
.rh-right { white-space: nowrap; }

.page-foot { position: absolute; left: ${padX}px; right: ${padX}px; bottom: ${padBottom}px; height: 22px; border-top: 1px solid #C5CDD6; padding-top: 5px; display: flex; justify-content: space-between; font-size: 8.5px; color: #7A8699; }
.pf-note { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 12px; }
.pf-page { white-space: nowrap; font-weight: 700; color: #3E4C5C; }

.kpis { display: flex; gap: 8px; height: 56px; margin-bottom: 12px; }
.kpi { flex: 1 1 0; min-width: 0; overflow: hidden; border: 1px solid #DDE2E8; border-left: 3px solid #FF9933; background: #F4F6F8; padding: 6px 8px; }
.kpi-label { font-size: 8px; letter-spacing: 0.5px; text-transform: uppercase; color: #5B6877; font-weight: 700; line-height: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kpi-value { font-size: 17px; font-weight: 700; color: #12283F; line-height: 22px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kpi-hint { font-size: 8px; color: #7A8699; line-height: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.sec { height: 22px; margin: 6px 0 8px; font-size: 12px; line-height: 20px; font-weight: 700; color: #12283F; border-bottom: 1px solid #DDE2E8; }
.note { font-size: 10px; color: #5B6877; }

table.data { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: ${TABLE_FONT_PX}px; }
table.data th { height: ${TABLE_HEAD_H}px; padding: 0 ${CELL_PAD_X}px; background: #12283F; color: #FFFFFF; font-size: 8.5px; letter-spacing: 0.4px; text-transform: uppercase; text-align: left; font-weight: 700; white-space: nowrap; overflow: hidden; }
table.data td { padding: ${CELL_PAD_Y}px ${CELL_PAD_X}px; border-bottom: ${ROW_BORDER_PX}px solid #DDE2E8; vertical-align: top; line-height: ${TABLE_LINE_PX}px; overflow-wrap: anywhere; }
table.data tr { break-inside: avoid; page-break-inside: avoid; }
table.data thead { display: table-header-group; }
table.data tr.z td { background: #F4F6F8; }
table.data .a-center { text-align: center; }
table.data .a-right { text-align: right; }
.sub { font-size: 9px; color: #5B6877; }
.mono { font-family: "Courier New", monospace; font-size: 9.5px; }
.badge { display: inline-block; vertical-align: top; padding: 1px 5px; border-radius: 3px; font-size: 8.5px; font-weight: 700; border: 1px solid transparent; line-height: 9px; white-space: nowrap; }
.badge-mfa { background: #FFEBEE; color: #C62828; border-color: #EF9A9A; }
.badge-pi { background: #E3F2FD; color: #1565C0; border-color: #90CAF9; }
.badge-leave { background: #FFF3E0; color: #E65100; border-color: #FFCC80; }
.badge-td { background: #FFFDE7; color: #F57F17; border-color: #FFF59D; }
.badge-ok { background: #E8F5E9; color: #2E7D32; border-color: #A5D6A7; }
.badge-off { background: #ECEFF1; color: #546E7A; border-color: #CFD8DC; }
`;
}

export interface ComposeOptions {
  meta: ReportMeta;
  orientation: PageOrientation;
  /** Body HTML of each page, first page first. The masthead and footer are added here. */
  pages: SafeHtml[];
  footerNote?: string;
  /** Report-specific CSS appended after the base styles. */
  extraCss?: string;
}

export const DEFAULT_FOOTER_NOTE =
  'CONFIDENTIAL - OFFICIAL MESS RECORD - NOT FOR PUBLIC DISSEMINATION';

/** Assembles the standalone document: one `.page` sheet per entry in `pages`. */
export function composeReportHtml({
  meta,
  orientation,
  pages,
  footerNote = DEFAULT_FOOTER_NOTE,
  extraCss = '',
}: ComposeOptions): string {
  const geometry = pageGeometry(orientation);
  const sheets = (pages.length > 0 ? pages : [html``]).map((body, index, all) =>
    html`<section class="page">${index === 0 ? mastheadHtml(meta) : runningHeadHtml(meta)}<div class="page-body">${body}</div><footer class="page-foot"><span class="pf-note">${footerNote}</span><span class="pf-page">Page ${index + 1} of ${all.length}</span></footer></section>`,
  );
  const docTitle = `${meta.title} - ${meta.messName}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:" />
<title>${escapeHtml(docTitle)}</title>
<style>${baseCss(geometry)}${extraCss}</style>
</head>
<body>
${sheets.map((s) => s.value).join('\n')}
</body>
</html>`;
}

/**
 * Scales the whole document. iOS lays a print page out at 72 dpi (595 px for A4) rather than
 * 96 dpi, so the 793 px sheets are zoomed to fit; everywhere else the scale is 1.
 */
export function withScale(documentHtml: string, scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0 || Math.abs(scale - 1) < 0.001) return documentHtml;
  return documentHtml.replace('</head>', `<style>html{zoom:${scale.toFixed(4)}}</style></head>`);
}
