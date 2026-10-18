import type { ReportDailyRow, ReportInsights } from './types.ts';

export interface DailyReportInput {
  dailyRows: ReportDailyRow[];
  bedsTotal: number;
  denialCount?: number;
}

/**
 * Computes deterministic statistics and narrative insights from daily booking records.
 * Matches exact benchmark formula:
 * Total: sum of all people across days
 * Daily average: total / numDays (rounded to 1 decimal place)
 * Peak day & count: maximum total across days
 * MFA+PI share: ((sum(MFA) + sum(PI)) / total) * 100 rounded to whole percent
 * Peak occupancy: (peakCount / bedsTotal) * 100 rounded to whole percent
 */
export function reportInsights(
  dailyRows: ReportDailyRow[],
  bedsTotal: number,
  denialCount: number = 0
): ReportInsights {
  if (dailyRows.length === 0) {
    return {
      totalPeopleDays: 0,
      totalGuestDays: 0,
      dailyAverage: 0,
      peakDay: '',
      peakCount: 0,
      mfaPiSharePercentage: 0,
      bedsTotal,
      peakOccupancyPercentage: 0,
      denialCount,
      writtenInsights: ['No booking data recorded for the selected period.']
    };
  }

  // Aggregate by day and category
  const dayTotals = new Map<string, number>();
  let mfaTotal = 0;
  let piTotal = 0;
  let overallTotal = 0;

  for (const row of dailyRows) {
    // Only non-suite rooms are counted in standard capacity benchmarks
    const isSuite = row.roomType === 'SUITE';
    if (!isSuite) {
      const currentDay = dayTotals.get(row.day) || 0;
      dayTotals.set(row.day, currentDay + row.people);

      overallTotal += row.people;
      if (row.category === 'MFA') mfaTotal += row.people;
      if (row.category === 'PI') piTotal += row.people;
    }
  }

  const numDays = dayTotals.size || 1;
  const dailyAverage = Math.round((overallTotal / numDays) * 10) / 10;

  let peakDay = '';
  let peakCount = 0;

  for (const [day, count] of dayTotals.entries()) {
    if (count > peakCount) {
      peakCount = count;
      peakDay = day;
    }
  }

  const mfaPiSharePercentage =
    overallTotal > 0 ? Math.round(((mfaTotal + piTotal) / overallTotal) * 100) : 0;

  const peakOccupancyPercentage =
    bedsTotal > 0 ? Math.round((peakCount / bedsTotal) * 100) : 0;

  const writtenInsights: string[] = [
    `Total accommodation volume reached ${overallTotal} guest-days over ${numDays} days, averaging ${dailyAverage.toFixed(1)} personnel per day.`,
    `Peak occupancy occurred on ${peakDay || 'N/A'} with ${peakCount} guests in residence (${peakOccupancyPercentage}% of total ${bedsTotal} beds).`,
    `Priority categories (BA MFA and Posted In) constituted ${mfaPiSharePercentage}% of total guest-days.`
  ];

  if (denialCount > 0) {
    writtenInsights.push(
      `${denialCount} booking request${denialCount > 1 ? 's were' : ' was'} denied during this reporting interval due to full capacity.`
    );
  } else {
    writtenInsights.push('No booking requests were denied during this reporting period.');
  }

  writtenInsights.push('VVIP Suite utilization is accounted separately from general mess inventory.');

  return {
    totalPeopleDays: overallTotal,
    totalGuestDays: overallTotal,
    dailyAverage,
    peakDay,
    peakCount,
    mfaPiSharePercentage,
    bedsTotal,
    peakOccupancyPercentage,
    denialCount,
    writtenInsights
  };
}
