import { getErrorMessage } from '@sms/core';

/**
 * Server errors the core mapping doesn't know about yet. Keys are matched as substrings of the
 * raw message (Postgres constraint names appear in the message text, RPC codes appear verbatim).
 */
const EXTRA_MESSAGES: Array<[match: string, message: string]> = [
  ['no_double_booking', 'That bed was just taken by another booking for overlapping dates. Refresh availability and choose another bed.'],
  ['one_bed_per_guest', 'A guest cannot occupy two beds on overlapping dates.'],
  ['Clerks cannot backdate', 'Only an Administrator can create a booking that starts in the past.'],
  ['ERR_NOT_ENOUGH_BEDS', 'Select at least one bed for every incoming guest before approving the eviction.'],
  ['ERR_CANNOT_EVICT', 'That booking has equal or higher priority than the incoming request and cannot be displaced.'],
  ['ERR_ROOM_OCCUPIED', 'This room still has active bookings in that period. Cancel or move them first, then mark the room out of service.'],
  ['ERR_NO_EVICTIONS', 'Select at least one occupant to displace.'],
  ['ERR_ALLOCATION_NOT_ACTIVE', 'One of the selected occupants has already moved or left. Go back and reload the candidate list.'],
  ['ERR_DEVICE_REVOKED', 'This device has been revoked. Contact an Administrator.'],
  ['check_stay_dates', 'Check-out must be after check-in.'],
  ['ERR_INVALID_DATES', 'The selected dates are not valid for this booking.'],
  ['Eviction reason must be', 'The eviction reason must be at least 10 characters.'],
  ['row-level security policy for table "rooms"', 'Only an Administrator can add or change suites.'],
  ['row-level security policy for table "room_closures"', 'Only an Administrator can mark a suite out of service.'],
  ['ERR_ROOM_HAS_ACTIVE_BOOKINGS', 'Cannot delete this room because it has active or upcoming bookings. Relocate or cancel those bookings first.'],
  ['ERR_ROOM_CLOSED', 'Cannot extend stay: the room is scheduled for maintenance during the requested period.'],
  ['ERR_DOUBLE_BOOKING', 'Cannot extend stay: the room or bed is already booked by another guest for overlapping dates.'],
  ['ERR_BOOKING_NOT_ACTIVE', 'Only confirmed bookings can have their dates modified.'],
  ['ERR_CANNOT_CHANGE_PAST_CHECKIN', 'Cannot change the check-in date for a booking that has already started.'],
  ['not-null constraint', 'A required field is missing. Check the form and try again.'],
];

/** Turns a Supabase/Postgres error (or any thrown value) into text a front-desk user can act on. */
export function userErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const raw =
    typeof err === 'string' ? err : err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : '';
  if (!raw) return fallback;

  for (const [match, message] of EXTRA_MESSAGES) {
    if (raw.includes(match)) return message;
  }
  const mapped = getErrorMessage(raw);
  if (mapped.code === 'ERR_UNKNOWN') return raw;
  return `${mapped.message} ${mapped.actionGuidance}`;
}
