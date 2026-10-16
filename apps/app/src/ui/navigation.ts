import type { AppRole, Permission } from '@sms/core';
import type { IconName } from './primitives/Icon';

export interface NavItem {
  label: string;
  icon: IconName;
  path: string;
  adminOnly?: boolean;
  /** Non-admins with this permission can also see the item (admin always can). */
  permission?: Permission;
  description?: string;
}

/** Shared visibility rule for the Sidebar and the phone "More" menu. */
export function canSeeNavItem(
  item: NavItem,
  userRole: AppRole,
  userPermissions: Permission[],
): boolean {
  if (userRole === 'admin') return true;
  if (item.permission) return userPermissions.includes(item.permission);
  return !item.adminOnly;
}

/** Single source of truth for the desktop Sidebar and the phone "More" menu. */
export const NAV_ITEMS: NavItem[] = [
  { label: 'Room Inventory', icon: 'bed', path: '/', description: 'Live bed occupancy by date' },
  {
    label: 'New Booking',
    icon: 'plus',
    path: '/bookings/new',
    description: 'Allot rooms for a visiting party',
  },
  {
    label: 'Bookings & Ledger',
    icon: 'ledger',
    path: '/bookings',
    description: 'Search and manage bookings',
  },
  {
    label: 'Reports & Insights',
    icon: 'chart',
    path: '/reports',
    description: 'Occupancy and denial reports',
  },
  {
    label: 'VVIP Suites',
    icon: 'star',
    path: '/suites',
    adminOnly: true,
    description: 'Admin-only suite bookings',
  },
  {
    label: 'User Directory',
    icon: 'users',
    path: '/admin/users',
    adminOnly: true,
    description: 'Invite staff, set permissions',
  },
  {
    label: 'Rooms & Data',
    icon: 'building',
    path: '/admin/data',
    adminOnly: true,
    permission: 'manage_rooms',
    description: 'Rooms and out-of-service periods',
  },
  {
    label: 'Audit Trail',
    icon: 'audit',
    path: '/admin/audit',
    adminOnly: true,
    description: 'Every user action, hash-chained',
  },
  {
    label: 'Access Code',
    icon: 'key',
    path: '/admin/keys',
    adminOnly: true,
    description: 'Set the login code, rotate keys',
  },
  {
    label: 'Settings',
    icon: 'settings',
    path: '/settings',
    description: 'Theme, auto-lock, devices, sign out',
  },
];

export function isNavActive(itemPath: string, pathname: string): boolean {
  if (itemPath === '/') return pathname === '/';
  if (itemPath === '/bookings') {
    // "/bookings/new" belongs to the New Booking entry, not the ledger.
    return (
      pathname === '/bookings' ||
      (pathname.startsWith('/bookings/') && !pathname.startsWith('/bookings/new'))
    );
  }
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
}
