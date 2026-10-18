import {
  buildPastBookingsHtml,
  buildPastBookingsReport,
  type PastBookingGuestItem,
  type PastBookingPdfItem,
  type PastBookingsPdfOptions,
} from './pastBookingsHtml';
import { openReportPreview } from './reportPreviewStore';
import { reportContext } from './reportMeta';

export {
  buildPastBookingsHtml,
  buildPastBookingsReport,
  type PastBookingGuestItem,
  type PastBookingPdfItem,
  type PastBookingsPdfOptions,
};

/** Opens the past bookings register on the preview screen (print / save / share from there). */
export async function exportPastBookingsPdf(options: PastBookingsPdfOptions): Promise<void> {
  openReportPreview(buildPastBookingsReport({ ...reportContext(), ...options }));
}
