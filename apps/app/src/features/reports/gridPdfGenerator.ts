import {
  buildGridHtml,
  buildGridReport,
  type GridPdfDayState,
  type GridPdfOccupant,
  type GridPdfOptions,
  type GridPdfRoom,
} from './gridHtml';
import { openReportPreview } from './reportPreviewStore';
import { reportContext } from './reportMeta';

export {
  buildGridHtml,
  buildGridReport,
  type GridPdfDayState,
  type GridPdfOccupant,
  type GridPdfOptions,
  type GridPdfRoom,
};

/** Opens the room occupancy grid on the preview screen (print / save / share from there). */
export async function exportGridPdf(options: GridPdfOptions): Promise<void> {
  openReportPreview(buildGridReport({ ...reportContext(), ...options }));
}
