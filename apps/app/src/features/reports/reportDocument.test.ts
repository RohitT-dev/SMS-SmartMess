import { describe, expect, it } from 'vitest';
import {
  composeReportHtml,
  escapeHtml,
  estimateLines,
  fileSlug,
  flowTable,
  html,
  paginate,
  pageGeometry,
  raw,
  bodyCapacity,
  tableHtml,
  tableRowHeight,
  withScale,
} from './reportDocument';

const meta = {
  messName: 'Test Mess',
  title: 'Sample Report',
  subtitle: 'Scope: everything',
  details: [{ label: 'Records', value: '3' }],
  generatedAt: new Date(2026, 9, 18, 17, 42),
  generatedBy: 'clerk@example.mil',
};

describe('html template', () => {
  it('escapes every interpolated value', () => {
    const evil = `<script>alert("x")</script> & 'q'`;
    const out = html`<td title="${evil}">${evil}</td>`.value;
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;');
  });

  it('does not double-escape nested templates and trusted markup', () => {
    const inner = html`<b>${'a & b'}</b>`;
    expect(html`<p>${inner}${raw('<i>ok</i>')}</p>`.value).toBe('<p><b>a &amp; b</b><i>ok</i></p>');
  });

  it('renders arrays, numbers and drops null / undefined / false', () => {
    expect(html`${[1, 'x', null, undefined, false, 0]}`.value).toBe('1x0');
  });

  it('escapeHtml handles non-strings', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(5)).toBe('5');
  });
});

describe('paginate', () => {
  const item = (height: number) => ({ height });

  it('always returns at least one page', () => {
    expect(paginate([], (i: { height: number }) => i.height, 100, 100)).toEqual([[]]);
  });

  it('fills the first page to its own capacity and later pages to theirs', () => {
    const items = Array.from({ length: 10 }, () => item(10));
    const pages = paginate(items, (i) => i.height, 30, 50);
    expect(pages.map((p) => p.length)).toEqual([3, 5, 2]);
  });

  it('never splits an item and keeps a too-tall item on a page of its own', () => {
    const pages = paginate([item(10), item(500), item(10)], (i) => i.height, 100, 100);
    expect(pages.map((p) => p.length)).toEqual([1, 1, 1]);
    expect(pages.flat()).toHaveLength(3);
  });

  it('keeps every page within capacity for ordinary rows', () => {
    const items = Array.from({ length: 200 }, (_, i) => item(22 + (i % 3) * 13));
    const pages = paginate(items, (i) => i.height, 400, 600);
    pages.forEach((p, i) => {
      const total = p.reduce((s, r) => s + r.height, 0);
      expect(total).toBeLessThanOrEqual(i === 0 ? 400 : 600);
    });
  });
});

describe('flowTable', () => {
  const geometry = pageGeometry('landscape');
  const rows = Array.from({ length: 80 }, () => ({ height: tableRowHeight(1) }));

  it('starts on page 1 when there is room and spills the rest', () => {
    const flowed = flowTable(rows, geometry, 400);
    expect(flowed.firstPageRows).not.toBeNull();
    expect((flowed.firstPageRows ?? []).length + flowed.laterPages.flat().length).toBe(80);
  });

  it('moves the whole table to page 2 when page 1 has no room for two rows', () => {
    const flowed = flowTable(rows, geometry, 60);
    expect(flowed.firstPageRows).toBeNull();
    expect(flowed.laterPages.flat()).toHaveLength(80);
  });

  it('later pages stay within the body capacity minus the repeated header', () => {
    const flowed = flowTable(rows, geometry, 400);
    for (const page of flowed.laterPages) {
      const total = page.reduce((s, r) => s + r.height, 0);
      expect(total).toBeLessThanOrEqual(bodyCapacity(geometry, false));
    }
  });
});

describe('estimateLines', () => {
  it('keeps short text on one line and wraps long text', () => {
    expect(estimateLines('Short', 120, 10)).toBe(1);
    expect(estimateLines('Wing Commander Rajesh Kumar Sharma of the Air Force Station', 120, 10)).toBeGreaterThan(1);
  });

  it('breaks an unbroken long word and honours explicit newlines', () => {
    expect(estimateLines('A'.repeat(80), 100, 10)).toBeGreaterThan(2);
    expect(estimateLines('one\ntwo\nthree', 200, 10)).toBe(3);
  });
});

describe('composeReportHtml', () => {
  const pages = [html`<p>first</p>`, html`<p>second</p>`, html`<p>third</p>`];
  const doc = composeReportHtml({ meta, orientation: 'landscape', pages });

  it('produces one sheet per page with Page X of Y', () => {
    expect(doc.match(/<section class="page">/g)).toHaveLength(3);
    expect(doc).toContain('Page 1 of 3');
    expect(doc).toContain('Page 2 of 3');
    expect(doc).toContain('Page 3 of 3');
  });

  it('declares A4 print geometry and page-break rules', () => {
    expect(doc).toContain('@page { size: A4 landscape; margin: 0; }');
    expect(doc).toContain('break-after: page');
    expect(doc).toContain('break-inside: avoid');
    expect(composeReportHtml({ meta, orientation: 'portrait', pages })).toContain('size: A4 portrait');
  });

  it('has a masthead on page 1 and a running header afterwards', () => {
    expect(doc.match(/class="masthead"/g)).toHaveLength(1);
    expect(doc.match(/class="running-head"/g)).toHaveLength(2);
    expect(doc).toContain('Test Mess');
    expect(doc).toContain('Sample Report');
    expect(doc).toContain('2026-10-18 17:42');
    expect(doc).toContain('clerk@example.mil');
  });

  it('is standalone: no app chrome, no scripts, locked down by CSP', () => {
    expect(doc).not.toContain('<script');
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain("default-src 'none'");
    expect(doc.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('escapes the title and masthead values', () => {
    const out = composeReportHtml({
      meta: { ...meta, title: '<img src=x onerror=alert(1)>', messName: "O'Brien & Co", generatedBy: '"><b>' },
      orientation: 'portrait',
      pages,
    });
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('O&#39;Brien &amp; Co');
    expect(out).not.toContain('"><b>');
  });

  it('renders a single empty page when given no pages', () => {
    expect(composeReportHtml({ meta, orientation: 'portrait', pages: [] })).toContain('Page 1 of 1');
  });
});

describe('tableHtml', () => {
  it('renders header, zebra rows and escapes cells', () => {
    const out = tableHtml(
      [{ header: 'Name', width: 100 }, { header: 'N', width: 40, align: 'right' }],
      [
        { cells: [html`${'<b>x</b>'}`, html`1`], height: 22 },
        { cells: [html`b`, html`2`], height: 22 },
      ],
    ).value;
    expect(out).toContain('<thead>');
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(out).toContain('class="z"');
    expect(out).toContain('a-right');
  });
});

describe('helpers', () => {
  it('withScale only changes the document when the scale differs from 1', () => {
    const base = '<html><head></head><body></body></html>';
    expect(withScale(base, 1)).toBe(base);
    expect(withScale(base, 0.75)).toContain('zoom:0.7500');
  });

  it('fileSlug is file-name safe', () => {
    expect(fileSlug("Officers' Mess / Past: 2026")).toBe('Officers-Mess-Past-2026');
    expect(fileSlug('!!!')).toBe('report');
  });
});
