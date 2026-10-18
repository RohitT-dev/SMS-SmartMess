const LABELS: Record<string, string> = {
  booking_created: 'Booking created',
  booking_cancelled: 'Booking cancelled',
  booking_denied: 'Request denied',
  eviction_approved: 'Eviction approved',
  guest_pii_set: 'Guest details saved',
  guest_pii_revealed: 'Guest details revealed',
  blind_index_search: 'Searched by guest ID',
  room_created: 'Room added',
  room_closure_created: 'Room taken out of service',
  room_closure_ended: 'Room closure ended',
  access_code_verified: 'Access code accepted',
  access_code_failed: 'Wrong access code',
  access_code_changed: 'Access code changed',
  access_bootstrapped: 'Access code first set',
  role_updated: 'Role changed',
  permissions_updated: 'Permissions changed',
  user_deactivated: 'User deactivated',
  user_invited: 'User invited',
  device_revoked: 'Device revoked',
  screen_view: 'Screen viewed',
  'bookings.create': 'Booking created (client)',
  'bookings.cancel': 'Booking cancelled (client)',
  'bookings.deny': 'Request denied (client)',
  'bookings.eviction_approved': 'Eviction approved (client)',
  room_deleted: 'Room deleted',
  'rooms.delete': 'Room deleted (client)',
  booking_dates_updated: 'Booking dates updated',
  'bookings.update_dates': 'Booking dates modified (client)',
  booking_request_created: 'Booking request created',
  booking_allotted: 'Room allotted',
  'bookings.allot': 'Room allotted (client)',
};

/** Readable label for an audit action code; unknown codes are title-cased. */
export function describeAuditAction(action: string): string {
  if (LABELS[action]) return LABELS[action];
  const words = action.replace(/[._:-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Entries that only record navigation or sign-in noise rather than a change. */
export const NOISE_ACTIONS = ['screen_view', 'access_code_verified', 'session.unlock'];
