/**
 * Getting a report out of the app.
 *
 * Web:    the standalone report HTML is loaded into an isolated, script-less iframe (or a blob
 *         tab) and printed from there, so only the report is printed - never the app page.
 *         The browser's print dialog offers "Save as PDF".
 * Native: expo-print renders the same HTML to a PDF file (printToFileAsync) which is shared,
 *         or sent to the system print dialog.
 */
import { Platform } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { supabase } from '../../lib/supabase';
import { logAction } from '../../lib/activityLog';
import { pageGeometry, withScale, type ReportDocument } from './reportDocument';

export type ReportAction = 'print' | 'save' | 'share' | 'open';

/** A4 in points (72 dpi), which is what expo-print's width/height mean. */
const A4_POINTS = { short: 595, long: 842 };

function nativePage(doc: ReportDocument) {
  const landscape = doc.orientation === 'landscape';
  const width = landscape ? A4_POINTS.long : A4_POINTS.short;
  const height = landscape ? A4_POINTS.short : A4_POINTS.long;
  // iOS lays a page out at 72 dpi (595 px wide) whereas the sheets are designed at 96 dpi, so
  // zoom them down to fit. Android's print engine lays out at 96 dpi and needs no scaling.
  const scale = Platform.OS === 'ios' ? width / pageGeometry(doc.orientation).width : 1;
  return { width, height, html: withScale(doc.html, scale) };
}

/**
 * Prints a standalone HTML document from a throw-away iframe. The frame is sandboxed without
 * scripts (the report needs none) and the document carries its own CSP, so even markup that
 * slipped past escaping could not run code. Web only.
 */
export function printHtmlInIsolatedFrame(htmlDoc: string, documentTitle: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('Printing is only available in a web browser.'));
      return;
    }
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
    frame.title = documentTitle;
    frame.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;pointer-events:none;';

    const previousTitle = document.title;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      document.title = previousTitle;
      window.setTimeout(() => frame.remove(), 300);
    };

    frame.onload = () => {
      const win = frame.contentWindow;
      if (!win) {
        finish();
        reject(new Error('Could not prepare the report for printing.'));
        return;
      }
      // Browsers suggest the print job's title as the PDF file name.
      document.title = documentTitle;
      win.addEventListener('afterprint', finish);
      // Let layout settle, then print only this frame.
      window.setTimeout(() => {
        try {
          win.focus();
          win.print();
          resolve();
        } catch (err) {
          finish();
          reject(err);
        }
      }, 150);
      // Safari returns from print() immediately; make sure the frame is removed eventually.
      window.setTimeout(finish, 10 * 60_000);
    };

    frame.srcdoc = htmlDoc;
    document.body.appendChild(frame);
  });
}

/** Opens the report in its own browser tab (blob URL) so it can be read, printed or saved. */
export function openHtmlInNewTab(htmlDoc: string): boolean {
  const url = URL.createObjectURL(new Blob([htmlDoc], { type: 'text/html;charset=utf-8' }));
  const win = window.open(url, '_blank');
  window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  return !!win;
}

async function recordExport(doc: ReportDocument, action: ReportAction): Promise<void> {
  try {
    await supabase.rpc('log_event', {
      p_action: doc.audit.action,
      p_entity: doc.audit.entity,
      p_entity_id: null,
      p_meta: { ...doc.audit.meta, via: action },
    });
  } catch {
    // Non-fatal if offline.
  }
  logAction('reports.export', { meta: { report: doc.kind, via: action, pages: doc.pageCount } });
}

/** Prints, saves, shares or opens a finished report. */
export async function exportReportDocument(doc: ReportDocument, action: ReportAction): Promise<void> {
  if (Platform.OS === 'web') {
    if (action === 'open') {
      if (!openHtmlInNewTab(doc.html)) {
        throw new Error('The browser blocked the new tab. Allow pop-ups for this site and try again.');
      }
    } else {
      // Printing and "Save as PDF" are the same browser dialog.
      await printHtmlInIsolatedFrame(doc.html, doc.fileName);
    }
    await recordExport(doc, action);
    return;
  }

  const page = nativePage(doc);
  if (action === 'print') {
    await Print.printAsync({ html: page.html, width: page.width, height: page.height });
  } else {
    const { uri } = await Print.printToFileAsync({
      html: page.html,
      width: page.width,
      height: page.height,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, {
        UTI: 'com.adobe.pdf',
        mimeType: 'application/pdf',
        dialogTitle: doc.title,
      });
    } else {
      await Print.printAsync({ uri });
    }
  }
  await recordExport(doc, action);
}
