import { describe, expect, it } from 'vitest';
import type { RoomDayOccupant } from '@sms/core';
import { isHeldByExclusiveBooking, roomAvailability, roomBedLayout } from './bedLayout';

const occ = (over: Partial<RoomDayOccupant> & Pick<RoomDayOccupant, 'bedSlot'>): RoomDayOccupant => ({
  allocationId: `a${over.bedSlot}`,
  bookingId: 'b1',
  gender: 'M',
  rankCode: 'FO',
  relation: 'PRIMARY',
  category: 'LEAVE',
  bookingStatus: 'CONFIRMED',
  checkIn: '2030-01-01',
  checkOut: '2030-01-03',
  ...over,
});

const room = (occupants: RoomDayOccupant[], is_closed = false) => ({ is_closed, occupants });
const kinds = (r: ReturnType<typeof room>) => roomBedLayout(r).map((b) => [b.slot, b.state.kind]);

describe('roomBedLayout', () => {
  it('an empty room shows two free beds', () => {
    expect(kinds(room([]))).toEqual([[1, 'free'], [2, 'free']]);
  });

  it('a closed room shows two closed beds', () => {
    expect(kinds(room([occ({ bedSlot: 1 })], true))).toEqual([[1, 'closed'], [2, 'closed']]);
  });

  it('a lone occupant of a shareable booking leaves the other bed free, with who it shares with', () => {
    const layout = roomBedLayout(room([occ({ bedSlot: 1, allowSharing: true })]));
    expect(layout.map((b) => b.state.kind)).toEqual(['occupied', 'free']);
    const second = layout[1].state;
    expect(second.kind === 'free' && second.sharesWith?.rankCode).toBe('FO');
  });

  it('rows from before the option (no flag) still show the free second bed', () => {
    expect(kinds(room([occ({ bedSlot: 2 })]))).toEqual([[1, 'free'], [2, 'occupied']]);
  });

  it('a lone occupant of a booking that does not allow sharing shows ONE bed and no free second bed', () => {
    const layout = roomBedLayout(room([occ({ bedSlot: 1, allowSharing: false })]));
    expect(layout).toHaveLength(1);
    expect(layout[0]).toMatchObject({ slot: 1, state: { kind: 'occupied' } });
    // Whichever bed the booking holds, it is the only one drawn.
    expect(kinds(room([occ({ bedSlot: 2, allowSharing: false })]))).toEqual([[2, 'occupied']]);
  });

  it('a party of two in one exclusive booking shows both beds occupied as normal', () => {
    const r = room([occ({ bedSlot: 1, allowSharing: false }), occ({ bedSlot: 2, allowSharing: false })]);
    expect(kinds(r)).toEqual([[1, 'occupied'], [2, 'occupied']]);
    expect(isHeldByExclusiveBooking(r)).toBe(false);
  });

  it('beside a civilian the empty bed is held for that party, not free', () => {
    const civilian = occ({ bedSlot: 1, rankCode: null, relation: 'SPOUSE', allowSharing: true });
    expect(kinds(room([civilian]))).toEqual([[1, 'occupied'], [2, 'held']]);
  });
});

describe('roomAvailability', () => {
  const base = { is_closed: false, beds_taken: 0, occupants: [] as RoomDayOccupant[] };

  it('free, one bed free, full and out of service', () => {
    expect(roomAvailability(base)).toBe('free');
    expect(roomAvailability({ ...base, beds_taken: 1, occupants: [occ({ bedSlot: 1, allowSharing: true })] })).toBe('one_bed_free');
    expect(roomAvailability({ ...base, beds_taken: 2, occupants: [occ({ bedSlot: 1 }), occ({ bedSlot: 2 })] })).toBe('full');
    expect(roomAvailability({ ...base, is_closed: true })).toBe('out_of_service');
  });

  it('a room held by a lone non-sharing booking has no bookable bed: it counts as full', () => {
    expect(roomAvailability({ ...base, beds_taken: 1, occupants: [occ({ bedSlot: 1, allowSharing: false })] })).toBe('full');
  });
});
