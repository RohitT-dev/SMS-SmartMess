import { supabase } from '../../lib/supabase';
import { localDateString } from '../../lib/dates';

interface WithAllocations {
  id: string;
  status: string;
  created_at?: string;
  allocations?: Array<{ status: string }> | null;
}

/**
 * Bookings still waiting for room allotment: requests in PENDING_ALLOTMENT, plus CONFIRMED
 * bookings whose stay has not ended and that hold no ACTIVE bed (nothing to show for them
 * otherwise). Two narrow queries instead of "every booking ever made", so the list stays
 * complete as history grows (a single unfiltered select is cut off at the API row limit).
 *
 * `columns` is a PostgREST select list; `allocations(id,status)` is added to it.
 */
export async function fetchPendingAllotment<T extends WithAllocations>(columns: string): Promise<T[]> {
  const select = `${columns}, allocations(id,status)`;

  const [pending, unseated] = await Promise.all([
    supabase.from('bookings').select(select).eq('status', 'PENDING_ALLOTMENT'),
    supabase
      .from('bookings')
      .select(select)
      .eq('status', 'CONFIRMED')
      .gte('check_out', localDateString()),
  ]);
  if (pending.error) throw pending.error;
  if (unseated.error) throw unseated.error;

  const unseatedRows = ((unseated.data ?? []) as unknown as T[]).filter(
    (b) => !(b.allocations ?? []).some((a) => a.status === 'ACTIVE'),
  );
  const all = [...((pending.data ?? []) as unknown as T[]), ...unseatedRows];
  return all.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
}
