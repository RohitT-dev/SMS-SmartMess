import { describe, expect, it } from 'vitest';
import { dailyBreakdown, occupancyPercent, reportInsights } from './reports.ts';
import type { ReportDailyRow } from './types.ts';

const rows: ReportDailyRow[] = [
  { day: '2026-10-02', category: 'PI', roomType: 'NORMAL', people: 6 },
  { day: '2026-10-01', category: 'MFA', roomType: 'NORMAL', people: 4 },
  { day: '2026-10-01', category: 'LEAVE', roomType: 'VIP', people: 2 },
  { day: '2026-10-01', category: 'MFA', roomType: 'SUITE', people: 1 },
  { day: '2026-10-01', category: 'TD', roomType: 'SEMI_VIP', people: 3 },
];

describe('dailyBreakdown', () => {
  it('collapses rows into one sorted row per day, by category', () => {
    expect(dailyBreakdown(rows)).toEqual([
      { day: '2026-10-01', mfa: 4, pi: 0, leave: 2, td: 3, suite: 1, total: 9 },
      { day: '2026-10-02', mfa: 0, pi: 6, leave: 0, td: 0, suite: 0, total: 6 },
    ]);
  });

  it('keeps suites out of the general total', () => {
    const [day] = dailyBreakdown(rows);
    expect(day.total).toBe(day.mfa + day.pi + day.leave + day.td);
  });

  it('agrees with reportInsights on the grand total and the peak', () => {
    const days = dailyBreakdown(rows);
    const insights = reportInsights(rows, 92);
    expect(days.reduce((sum, d) => sum + d.total, 0)).toBe(insights.totalGuestDays);
    expect(Math.max(...days.map((d) => d.total))).toBe(insights.peakCount);
  });

  it('is empty for no rows', () => {
    expect(dailyBreakdown([])).toEqual([]);
  });
});

describe('occupancyPercent', () => {
  it('rounds to whole percent and is zero without inventory', () => {
    expect(occupancyPercent(46, 92)).toBe(50);
    expect(occupancyPercent(1, 3)).toBe(33);
    expect(occupancyPercent(5, 0)).toBe(0);
  });
});
