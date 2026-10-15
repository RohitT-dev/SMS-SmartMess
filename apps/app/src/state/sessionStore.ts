import { create } from 'zustand';
import { clearSessionKey } from '@sms/crypto';
import type { AppRole, Permission } from '@sms/core';

interface SessionState {
  isUnlocked: boolean;
  autoLockMinutes: number;
  lastActivityAt: number;
  userRole: AppRole;
  userPermissions: Permission[];
  revealedPii: Record<string, number>; // guestId -> timestamp when reveal expires
  setUnlocked: (unlocked: boolean) => void;
  setAutoLockMinutes: (minutes: number) => void;
  recordActivity: () => void;
  lockSession: () => void;
  setUserProfile: (role: AppRole, permissions: Permission[]) => void;
  revealGuest: (guestId: string, durationSeconds?: number) => void;
  isGuestRevealed: (guestId: string) => boolean;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  isUnlocked: false,
  autoLockMinutes: 2,
  lastActivityAt: Date.now(),
  userRole: 'clerk',
  userPermissions: ['create_booking', 'enter_guest_details', 'view_reports', 'deny_request'],
  revealedPii: {},

  setUnlocked: (unlocked: boolean) => {
    set({ isUnlocked: unlocked, lastActivityAt: Date.now() });
  },

  setAutoLockMinutes: (minutes: number) => {
    const clamped = Math.max(1, Math.min(15, minutes));
    set({ autoLockMinutes: clamped });
  },

  recordActivity: () => {
    set({ lastActivityAt: Date.now() });
  },

  lockSession: () => {
    // 1. Wipe cryptographic keys from module closure memory
    clearSessionKey();
    // 2. Wipe temporary reveal tokens
    set({ isUnlocked: false, revealedPii: {} });
  },

  setUserProfile: (role: AppRole, permissions: Permission[]) => {
    set({ userRole: role, userPermissions: permissions });
  },

  revealGuest: (guestId: string, durationSeconds: number = 15) => {
    const expiry = Date.now() + durationSeconds * 1000;
    set((state) => ({
      revealedPii: {
        ...state.revealedPii,
        [guestId]: expiry
      }
    }));
  },

  isGuestRevealed: (guestId: string) => {
    const expiry = get().revealedPii[guestId];
    if (!expiry) return false;
    if (Date.now() > expiry) {
      // Expired, re-mask immediately
      return false;
    }
    return true;
  }
}));
