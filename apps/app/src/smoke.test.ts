import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from './state/sessionStore';
import { CreateBookingRequestSchema } from '@sms/core';

describe('App Smoke Tests', () => {
  beforeEach(() => {
    useSessionStore.getState().lockSession();
  });

  it('1. Lock screen appears after idle: lockSession zeroes keys and sets isUnlocked to false', () => {
    const store = useSessionStore.getState();
    // Simulate user unlocked
    store.setUnlocked(true);
    store.setUserProfile('admin', ['create_booking', 'approve_eviction']);
    expect(useSessionStore.getState().isUnlocked).toBe(true);

    // Simulate idle timeout / background lock trigger
    useSessionStore.getState().lockSession();

    // Verify session is locked and sensitive reveal state is purged
    expect(useSessionStore.getState().isUnlocked).toBe(false);
    expect(useSessionStore.getState().revealedPii).toEqual({});
  });

  it('2. Masked value stays masked until Reveal, and re-masks after 15 seconds', () => {
    const store = useSessionStore.getState();
    const guestId = 'guest-uuid-1234';

    // By default guest value is not revealed
    expect(store.isGuestRevealed(guestId)).toBe(false);

    // User triggers reveal (15-second window)
    store.revealGuest(guestId, 15);
    expect(store.isGuestRevealed(guestId)).toBe(true);

    // After 15 seconds elapses, value is re-masked
    const futureTime = Date.now() + 16000;
    vi.spyOn(Date, 'now').mockReturnValue(futureTime);

    expect(store.isGuestRevealed(guestId)).toBe(false);

    vi.restoreAllMocks();
  });

  it('3. Booking form blocks submit when guests are missing gender or rank', () => {
    // Attempt to validate booking with guest missing rank
    const invalidRankBooking = {
      category: 'MSA',
      checkIn: '2026-11-01',
      checkOut: '2026-11-05',
      partySize: 1,
      guests: [{ gender: 'M', rankCode: '' }]
    };
    const resRank = CreateBookingRequestSchema.safeParse(invalidRankBooking);
    expect(resRank.success).toBe(false);
    if (!resRank.success) {
      expect(resRank.error.message).toContain('Invalid rank code');
    }

    // Attempt to validate booking with guest missing gender
    const invalidGenderBooking = {
      category: 'MSA',
      checkIn: '2026-11-01',
      checkOut: '2026-11-05',
      partySize: 1,
      guests: [{ gender: '', rankCode: 'WG_CDR' }]
    };
    const resGender = CreateBookingRequestSchema.safeParse(invalidGenderBooking);
    expect(resGender.success).toBe(false);
    if (!resGender.success) {
      expect(resGender.error.message).toContain('Gender must be M or F');
    }

    // Valid booking passes
    const validBooking = {
      category: 'MSA',
      checkIn: '2026-11-01',
      checkOut: '2026-11-05',
      partySize: 1,
      guests: [{ gender: 'M', rankCode: 'WG_CDR' }]
    };
    const resValid = CreateBookingRequestSchema.safeParse(validBooking);
    expect(resValid.success).toBe(true);
  });
});
