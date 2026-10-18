import type { ReportDailyRow, ReportInsights } from '@sms/core';
import {
  buildInsightsReport,
  buildOccupancyReport,
  type OccupancyReportOptions,
} from './occupancyHtml';
import { openReportPreview } from './reportPreviewStore';
import { reportContext } from './reportMeta';

export interface GeneratePdfOptions {
  periodLabel: string;
  insights: ReportInsights;
  dailyRows: ReportDailyRow[];
  denials?: Array<{ category: string; count: number }>;
}

export { buildInsightsReport, buildOccupancyReport, type OccupancyReportOptions };

/** Opens the occupancy report (chart + day-by-day table) on the preview screen. */
export function previewOccupancyReport(options: GeneratePdfOptions): void {
  openReportPreview(buildOccupancyReport({ ...reportContext(), ...options }));
}

/** Opens the one-page insights summary on the preview screen. */
export function previewInsightsReport(options: GeneratePdfOptions): void {
  openReportPreview(buildInsightsReport({ ...reportContext(), ...options }));
}

/** Kept for existing callers: the occupancy report. */
export async function exportReportPdf(options: GeneratePdfOptions): Promise<void> {
  previewOccupancyReport(options);
}
