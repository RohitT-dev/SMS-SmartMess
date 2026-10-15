export interface AppErrorDetails {
  code: string;
  title: string;
  message: string;
  actionGuidance: string;
}

export const ERROR_MAPPINGS: Record<string, AppErrorDetails> = {
  ERR_SHARE_RULE: {
    code: 'ERR_SHARE_RULE',
    title: 'Room Sharing Rule Violation',
    message: 'Two guests may share a room only if they share both the same gender and the same rank.',
    actionGuidance: 'Select separate whole rooms or pair guests with identical gender and rank.'
  },
  ERR_DOUBLE_BOOKED: {
    code: 'ERR_DOUBLE_BOOKED',
    title: 'Bed Already Reserved',
    message: 'The selected bed was just reserved by another clerk or already has an active overlapping stay.',
    actionGuidance: 'Refresh the room inventory to view updated availability and select an alternate bed.'
  },
  ERR_SUITE_ONLY_ADMIN: {
    code: 'ERR_SUITE_ONLY_ADMIN',
    title: 'Restricted VVIP Suite',
    message: 'Suites are reserved exclusively for VVIP / Air Marshal guests and require Administrator authorization.',
    actionGuidance: 'Please ask the Administrator to book this suite from the Suite Management console.'
  },
  ERR_ROOM_CLOSED: {
    code: 'ERR_ROOM_CLOSED',
    title: 'Room Out of Service',
    message: 'This room is closed for maintenance or repairs during the selected dates.',
    actionGuidance: 'Choose a different room or adjust the stay dates to outside the closure period.'
  },
  ERR_PERMISSION: {
    code: 'ERR_PERMISSION',
    title: 'Permission Denied',
    message: 'You do not have the required authorization to perform this operation.',
    actionGuidance: 'Contact the Administrator to request the necessary permission flag on your profile.'
  },
  ERR_CANNOT_DENY_PRIORITY: {
    code: 'ERR_CANNOT_DENY_PRIORITY',
    title: 'Priority Request Cannot Be Denied',
    message: 'BA MSA and Posted In (PI) visitors have mandatory priority and cannot be turned away.',
    actionGuidance: 'Initiate the Eviction Review process to displace lower-priority bookings.'
  },
  ERR_INVALID_DATES: {
    code: 'ERR_INVALID_DATES',
    title: 'Invalid Date Range',
    message: 'Check-out date must be strictly after the check-in date.',
    actionGuidance: 'Verify the arrival and departure dates and try again.'
  },
  ERR_PARTY_MISMATCH: {
    code: 'ERR_PARTY_MISMATCH',
    title: 'Party Size Mismatch',
    message: 'The number of allocated beds or guest profiles does not equal the specified party size.',
    actionGuidance: 'Ensure each member of the party has their gender and rank recorded.'
  },
  ERR_LAST_ADMIN: {
    code: 'ERR_LAST_ADMIN',
    title: 'Cannot Remove Last Administrator',
    message: 'System security requires at least one active Administrator at all times.',
    actionGuidance: 'Promote another staff member to Administrator before modifying this account.'
  }
};

export function getErrorMessage(errorCodeOrMessage: string): AppErrorDetails {
  for (const [code, details] of Object.entries(ERROR_MAPPINGS)) {
    if (errorCodeOrMessage.includes(code)) {
      return details;
    }
  }

  return {
    code: 'ERR_UNKNOWN',
    title: 'Operation Failed',
    message: errorCodeOrMessage || 'An unexpected error occurred.',
    actionGuidance: 'Please refresh the screen or check your connection.'
  };
}
