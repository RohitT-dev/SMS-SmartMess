import { create } from 'zustand';
import { router } from 'expo-router';
import type { ReportDocument } from './reportDocument';

/**
 * The report currently shown on the preview screen. Held in memory (not in the route) because a
 * report can be large and carries guest names, which must not travel in a URL.
 */
interface ReportPreviewState {
  doc: ReportDocument | null;
  setDoc: (doc: ReportDocument | null) => void;
}

export const useReportPreviewStore = create<ReportPreviewState>((set) => ({
  doc: null,
  setDoc: (doc) => set({ doc }),
}));

/** Shows the report on the preview screen, where it can be printed, saved or shared. */
export function openReportPreview(doc: ReportDocument): void {
  useReportPreviewStore.getState().setDoc(doc);
  router.push('/(app)/reports/pdf-preview' as any);
}
