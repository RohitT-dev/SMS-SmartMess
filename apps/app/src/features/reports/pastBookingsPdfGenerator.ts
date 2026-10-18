import { Platform } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { supabase } from '../../lib/supabase';
import {
  buildPastBookingsHtml,
  type PastBookingPdfItem,
  type PastBookingsPdfOptions,
} from './pastBookingsHtml';

export {
  buildPastBookingsHtml,
  type PastBookingPdfItem,
  type PastBookingsPdfOptions,
};

export async function exportPastBookingsPdf(options: PastBookingsPdfOptions): Promise<void> {
  const html = buildPastBookingsHtml(options);

  try {
    await supabase.rpc('log_event', {
      p_action: 'past_bookings_exported',
      p_entity: 'bookings',
      p_entity_id: null,
      p_meta: { total_records: options.bookings.length, filter: options.filterLabel },
    });
  } catch {
    // Non-fatal if offline
  }

  if (Platform.OS === 'web') {
    await Print.printAsync({ html });
  } else {
    const { uri } = await Print.printToFileAsync({ html });
    await Sharing.shareAsync(uri, {
      UTI: '.pdf',
      mimeType: 'application/pdf',
      dialogTitle: "Export Officers' Mess Past Bookings",
    });
  }
}
