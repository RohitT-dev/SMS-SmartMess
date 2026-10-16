import type { RoomDayState } from '@sms/core';

/** Row shape returned by the daily_room_state RPC (snake_case columns, camelCase occupants JSON). */
export interface DailyRoomStateRow {
  room_id: string;
  room_type: RoomDayState['roomType'];
  display_order: number;
  date: string;
  beds_taken: number;
  is_closed: boolean;
  occupants: RoomDayState['occupants'] | null;
}

export function mapRoomDayState(row: DailyRoomStateRow): RoomDayState {
  return {
    roomId: row.room_id,
    roomType: row.room_type,
    displayOrder: row.display_order,
    date: row.date,
    bedsTaken: row.beds_taken,
    isClosed: row.is_closed,
    occupants: row.occupants ?? [],
  };
}
