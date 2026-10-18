import { describe, expect, it } from 'vitest';
import type { GuestDemand } from '@sms/core';
import { seatPartyOnBeds, type FreedBed } from './planBooking';

const bed = (allocationId: string, roomId: string, bedSlot: 1 | 2): FreedBed => ({ allocationId, roomId, bedSlot });

describe('seatPartyOnBeds', () => {
  const couple: GuestDemand[] = [
    { gender: 'M', rankCode: 'WG_CDR', relation: 'PRIMARY' },
    { gender: 'F', rankCode: null, relation: 'SPOUSE' },
  ];

  it('puts a couple into the room whose two beds were both freed, whatever the click order', () => {
    const seated = seatPartyOnBeds(couple, [bed('a1', 'A', 1), bed('b1', 'B', 1), bed('b2', 'B', 2)])!;
    expect(seated.map((s) => s.bed.roomId)).toEqual(['B', 'B']);
    expect(new Set(seated.map((s) => s.bed.allocationId)).size).toBe(2);
  });

  it('splits the couple only when no room has both beds freed', () => {
    const seated = seatPartyOnBeds(couple, [bed('a1', 'A', 1), bed('b1', 'B', 1)])!;
    expect(seated.map((s) => s.bed.roomId)).toEqual(['A', 'B']);
  });

  it('seats singles in selection order and returns null when beds run short', () => {
    const singles: GuestDemand[] = [
      { gender: 'M', rankCode: 'FO', relation: 'PRIMARY' },
      { gender: 'F', rankCode: 'SQN_LDR', relation: 'SERVICE' },
    ];
    const seated = seatPartyOnBeds(singles, [bed('a1', 'A', 1), bed('b1', 'B', 1)])!;
    expect(seated.map((s) => s.bed.allocationId)).toEqual(['a1', 'b1']);
    expect(seatPartyOnBeds(singles, [bed('a1', 'A', 1)])).toBeNull();
  });
});
