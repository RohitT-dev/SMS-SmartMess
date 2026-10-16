import type { RoomDayState } from '@sms/core';
import { supabase } from '../../lib/supabase';
import { mapRoomDayState, type DailyRoomStateRow } from './mapRoomState';

export { mapRoomDayState } from './mapRoomState';

/** Per-room, per-day state for [from, to) in the shape the allotment engine expects. */
export async function fetchRoomDayStates(from: string, to: string): Promise<RoomDayState[]> {
  const { data, error } = await supabase.rpc('daily_room_state', { p_from: from, p_to: to });
  if (error) throw error;
  return ((data || []) as DailyRoomStateRow[]).map(mapRoomDayState);
}
