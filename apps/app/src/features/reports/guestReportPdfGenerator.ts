import { buildGuestReport, type GuestReportOptions } from './guestReportHtml';
import { openReportPreview } from './reportPreviewStore';
import { reportContext } from './reportMeta';

export { buildGuestReport, type GuestReportOptions };

/** Opens the guest report on the preview screen (print / save / share from there). */
export function previewGuestReport(options: GuestReportOptions): void {
  openReportPreview(buildGuestReport({ ...reportContext(), ...options }));
}
