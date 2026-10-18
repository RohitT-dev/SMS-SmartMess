/**
 * Domain constants for the Smart Mess System room inventory.
 */

export const STAY_BOUNDS = '[)';

export type VisitorCategory = 'MFA' | 'PI' | 'LEAVE' | 'TD';

export interface CategoryMetadata {
  code: VisitorCategory;
  name: string;
  isFree: boolean;
  priorityOrder: number; // 1 = highest
  canBeDenied: boolean;
}

export const CATEGORIES: Record<VisitorCategory, CategoryMetadata> = {
  MFA: {
    code: 'MFA',
    name: 'BA MFA',
    isFree: true,
    priorityOrder: 1,
    canBeDenied: false
  },
  PI: {
    code: 'PI',
    name: 'Posted In',
    isFree: true,
    priorityOrder: 2,
    canBeDenied: false
  },
  LEAVE: {
    code: 'LEAVE',
    name: 'On leave',
    isFree: false,
    priorityOrder: 3,
    canBeDenied: true
  },
  TD: {
    code: 'TD',
    name: 'Temporary displacement',
    isFree: false,
    priorityOrder: 4,
    canBeDenied: true
  }
};

export type RoomType = 'VIP' | 'SEMI_VIP' | 'NORMAL' | 'SUITE';

export const ROOM_TYPES: readonly RoomType[] = ['VIP', 'SEMI_VIP', 'NORMAL', 'SUITE'] as const;

export type Gender = 'M' | 'F';

export type RankCode =
  | 'FO'
  | 'FLT_LT'
  | 'SQN_LDR'
  | 'WG_CDR'
  | 'GP_CAPT'
  | 'AIR_CDRE'
  | 'AVM'
  | 'AM'
  | 'ACM'
  | 'MIAF';

export interface RankInfo {
  code: RankCode;
  seniority: number;
  label: string;
}

export const RANKS: readonly RankInfo[] = [
  { code: 'FO', seniority: 1, label: 'Flying Officer' },
  { code: 'FLT_LT', seniority: 2, label: 'Flight Lieutenant' },
  { code: 'SQN_LDR', seniority: 3, label: 'Squadron Leader' },
  { code: 'WG_CDR', seniority: 4, label: 'Wing Commander' },
  { code: 'GP_CAPT', seniority: 5, label: 'Group Captain' },
  { code: 'AIR_CDRE', seniority: 6, label: 'Air Commodore' },
  { code: 'AVM', seniority: 7, label: 'Air Vice Marshal' },
  { code: 'AM', seniority: 8, label: 'Air Marshal' },
  { code: 'ACM', seniority: 9, label: 'Air Chief Marshal' },
  { code: 'MIAF', seniority: 10, label: 'Marshal of the Indian Air Force' }
] as const;

export const RANK_ORDER = RANKS;
export type Category = VisitorCategory;

export type BookingStatus = 'CONFIRMED' | 'CANCELLED' | 'DISPLACED' | 'COMPLETED' | 'PENDING_ALLOTMENT';

export type AllocationStatus = 'ACTIVE' | 'RELEASED' | 'EVICTED';

export type DetailsStatus = 'PENDING' | 'COMPLETE';

export type AppRole = 'admin' | 'clerk';

export const PERMISSION_LIST = [
  'create_booking',
  'enter_guest_details',
  'reveal_guest_pii',
  'cancel_booking',
  'approve_eviction',
  'view_reports',
  'deny_request',
  'manage_rooms'
] as const;

export type Permission = (typeof PERMISSION_LIST)[number];

export const DEFAULT_CLERK_PERMISSIONS: Permission[] = [
  'create_booking',
  'enter_guest_details',
  'view_reports',
  'deny_request'
];
