import { describe, it } from 'vitest';
import assert from 'node:assert';

import {
  planAllotment,
  canDisplace,
  roomStatus,
  reportInsights,
  getRank,
  compareRanks,
  getErrorMessage,
  GuestPiiSchema,
  DenyRequestSchema,
  ApproveEvictionSchema,
} from './index.ts';

import type { BookingPlanRequest, ReportDailyRow, RoomDayState } from './index.ts';

describe('packages/core - Domain Logic & Allotment Engine Suite', () => {
  it('Rank metadata, comparison, and seniority', () => {
    const fo = getRank('FO');
    const airCdre = getRank('AIR_CDRE');
    const miaf = getRank('MIAF');

    assert.strictEqual(fo.seniority, 1);
    assert.strictEqual(airCdre.seniority, 6);
    assert.strictEqual(miaf.seniority, 10);

    assert.ok(compareRanks('FO', 'FLT_LT') < 0);
    assert.ok(compareRanks('AIR_CDRE', 'WG_CDR') > 0);
    assert.strictEqual(compareRanks('SQN_LDR', 'SQN_LDR'), 0);
  });

  it('Room status calculation: free, one_bed_free, full, out_of_service', () => {
    const baseState: RoomDayState = {
      roomId: 'r1',
      roomType: 'NORMAL',
      displayOrder: 1,
      date: '2026-10-20',
      bedsTaken: 0,
      isClosed: false,
      occupants: [],
    };

    assert.strictEqual(roomStatus(baseState), 'free');
    assert.strictEqual(roomStatus({ ...baseState, bedsTaken: 1 }), 'one_bed_free');
    assert.strictEqual(roomStatus({ ...baseState, bedsTaken: 2 }), 'full');
    assert.strictEqual(roomStatus({ ...baseState, isClosed: true }), 'out_of_service');
  });

  it('Eviction eligibility matrix (all priority combinations)', () => {
    // MSA can displace PI, LEAVE, TD
    assert.strictEqual(canDisplace('MSA', 'PI'), true);
    assert.strictEqual(canDisplace('MSA', 'LEAVE'), true);
    assert.strictEqual(canDisplace('MSA', 'TD'), true);
    assert.strictEqual(canDisplace('MSA', 'MSA'), false); // Cannot displace other MSA

    // PI can displace LEAVE, TD
    assert.strictEqual(canDisplace('PI', 'LEAVE'), true);
    assert.strictEqual(canDisplace('PI', 'TD'), true);
    assert.strictEqual(canDisplace('PI', 'PI'), false);
    assert.strictEqual(canDisplace('PI', 'MSA'), false); // Cannot displace MSA

    // LEAVE and TD can NEVER displace anyone
    assert.strictEqual(canDisplace('LEAVE', 'LEAVE'), false);
    assert.strictEqual(canDisplace('LEAVE', 'TD'), false);
    assert.strictEqual(canDisplace('LEAVE', 'PI'), false);
    assert.strictEqual(canDisplace('LEAVE', 'MSA'), false);

    assert.strictEqual(canDisplace('TD', 'TD'), false);
    assert.strictEqual(canDisplace('TD', 'LEAVE'), false);
  });

  it('Allotment Engine: pairs same gender and same rank into one room', () => {
    const states: RoomDayState[] = [
      {
        roomId: 'room-1',
        roomType: 'NORMAL',
        displayOrder: 1,
        date: '2026-10-20',
        bedsTaken: 0,
        isClosed: false,
        occupants: [],
      },
      {
        roomId: 'room-1',
        roomType: 'NORMAL',
        displayOrder: 1,
        date: '2026-10-21',
        bedsTaken: 0,
        isClosed: false,
        occupants: [],
      },
    ];

    const req: BookingPlanRequest = {
      category: 'LEAVE',
      checkIn: '2026-10-20',
      checkOut: '2026-10-22',
      guests: [
        { gender: 'M', rankCode: 'SQN_LDR' },
        { gender: 'M', rankCode: 'SQN_LDR' },
      ],
    };

    const res = planAllotment(req, states);
    assert.strictEqual(res.kind, 'ALLOT');
    if (res.kind === 'ALLOT') {
      assert.strictEqual(res.assignments.length, 2);
      // Both assigned to room-1, slots 1 and 2
      assert.strictEqual(res.assignments[0].roomId, 'room-1');
      assert.strictEqual(res.assignments[1].roomId, 'room-1');
      assert.notStrictEqual(res.assignments[0].bedSlot, res.assignments[1].bedSlot);
    }
  });

  it('Allotment Engine: 3 people (2 same gender/rank, 1 different) spans several rooms', () => {
    const states: RoomDayState[] = [
      {
        roomId: 'room-1',
        roomType: 'NORMAL',
        displayOrder: 1,
        date: '2026-10-20',
        bedsTaken: 0,
        isClosed: false,
        occupants: [],
      },
      {
        roomId: 'room-2',
        roomType: 'NORMAL',
        displayOrder: 2,
        date: '2026-10-20',
        bedsTaken: 0,
        isClosed: false,
        occupants: [],
      },
    ];

    const req: BookingPlanRequest = {
      category: 'PI',
      checkIn: '2026-10-20',
      checkOut: '2026-10-21',
      guests: [
        { gender: 'M', rankCode: 'SQN_LDR' },
        { gender: 'M', rankCode: 'SQN_LDR' },
        { gender: 'F', rankCode: 'FLT_LT' }, // Different gender & rank
      ],
    };

    const res = planAllotment(req, states);
    assert.strictEqual(res.kind, 'ALLOT');
    if (res.kind === 'ALLOT') {
      assert.strictEqual(res.assignments.length, 3);
      const roomIds = new Set(res.assignments.map((a) => a.roomId));
      assert.strictEqual(roomIds.size, 2); // Must span 2 rooms
    }
  });

  it('Allotment Engine: never offers SUITE rooms to standard bookings', () => {
    const states: RoomDayState[] = [
      {
        roomId: 'suite-room',
        roomType: 'SUITE',
        displayOrder: 1,
        date: '2026-10-20',
        bedsTaken: 0,
        isClosed: false,
        occupants: [],
      },
    ];

    const req: BookingPlanRequest = {
      category: 'MSA',
      checkIn: '2026-10-20',
      checkOut: '2026-10-21',
      guests: [{ gender: 'M', rankCode: 'AIR_CDRE' }],
    };

    const res = planAllotment(req, states);
    // Even though suite is free, standard engine must NOT allot it
    assert.notStrictEqual(res.kind, 'ALLOT');
  });

  it('Allotment Engine: fallback room type when preferred type is full', () => {
    const states: RoomDayState[] = [
      {
        roomId: 'vip-1',
        roomType: 'VIP',
        displayOrder: 1,
        date: '2026-10-20',
        bedsTaken: 2, // Full
        isClosed: false,
        occupants: [],
      },
      {
        roomId: 'normal-1',
        roomType: 'NORMAL',
        displayOrder: 2,
        date: '2026-10-20',
        bedsTaken: 0, // Free
        isClosed: false,
        occupants: [],
      },
    ];

    const req: BookingPlanRequest = {
      category: 'LEAVE',
      checkIn: '2026-10-20',
      checkOut: '2026-10-21',
      preferredRoomType: 'VIP',
      guests: [{ gender: 'M', rankCode: 'SQN_LDR' }],
    };

    const res = planAllotment(req, states);
    assert.strictEqual(res.kind, 'ALLOT');
    if (res.kind === 'ALLOT') {
      assert.strictEqual(res.usedFallbackType, true);
      assert.strictEqual(res.assignments[0].roomId, 'normal-1');
      assert.strictEqual(res.assignments[0].roomType, 'NORMAL');
    }
  });

  it('Report Insights: exact benchmark against Section 12 test fixture', () => {
    // 12 days fixture from prompt:
    const M = [10, 10, 12, 12, 14, 15, 14, 16, 18, 18, 15, 14];
    const P = [16, 16, 17, 18, 19, 20, 21, 23, 24, 25, 22, 21];
    const L = [8, 9, 10, 10, 12, 13, 15, 15, 17, 16, 14, 11];
    const T = [6, 7, 7, 6, 6, 7, 9, 10, 11, 12, 10, 10];

    const dailyRows: ReportDailyRow[] = [];
    for (let day = 1; day <= 12; day++) {
      const dayStr = `2026-10-${day.toString().padStart(2, '0')}`;
      dailyRows.push(
        { day: dayStr, category: 'MSA', roomType: 'NORMAL', people: M[day - 1] },
        { day: dayStr, category: 'PI', roomType: 'NORMAL', people: P[day - 1] },
        { day: dayStr, category: 'LEAVE', roomType: 'NORMAL', people: L[day - 1] },
        { day: dayStr, category: 'TD', roomType: 'NORMAL', people: T[day - 1] },
      );
    }

    const bedsTotal = 92;
    const insights = reportInsights(dailyRows, bedsTotal, 0);

    // Expected: total 661, average 55.1, peak 71 on day 10, MSA+PI share 62%, 92 beds, peak occupancy 77%.
    assert.strictEqual(insights.totalPeopleDays, 661);
    assert.strictEqual(insights.dailyAverage, 55.1);
    assert.strictEqual(insights.peakDay, '2026-10-10'); // Day 10
    assert.strictEqual(insights.peakCount, 71);
    assert.strictEqual(insights.msaPiSharePercentage, 62);
    assert.strictEqual(insights.bedsTotal, 92);
    assert.strictEqual(insights.peakOccupancyPercentage, 77);
    assert.ok(insights.writtenInsights.length >= 3);
  });

  it('Error mappings provide user-facing guidance', () => {
    const shareErr = getErrorMessage('Database returned ERR_SHARE_RULE');
    assert.strictEqual(shareErr.code, 'ERR_SHARE_RULE');
    assert.ok(shareErr.message.includes('same gender and the same rank'));

    const denialErr = getErrorMessage('ERR_CANNOT_DENY_PRIORITY');
    assert.strictEqual(denialErr.code, 'ERR_CANNOT_DENY_PRIORITY');
    assert.ok(denialErr.actionGuidance.includes('Eviction Review'));
  });

  it('Schema validation: GuestPiiSchema validates required fields', () => {
    const valid = {
      name: 'Major General V. Rao',
      idNumber: 'ID-99212',
      phone: '+91 9876543210',
    };
    const parsed = GuestPiiSchema.parse(valid);
    assert.strictEqual(parsed.name, 'Major General V. Rao');

    assert.throws(() => {
      GuestPiiSchema.parse({ name: '' });
    });
  });

  it('Schema validation: DenyRequestSchema blocks priority categories', () => {
    assert.throws(() => {
      DenyRequestSchema.parse({
        category: 'MSA',
        checkIn: '2026-10-01',
        checkOut: '2026-10-02',
        partySize: 1,
        reason: 'No space',
      });
    }, /Only LEAVE and TD/i);

    const validDenial = DenyRequestSchema.parse({
      category: 'LEAVE',
      checkIn: '2026-10-01',
      checkOut: '2026-10-02',
      partySize: 1,
      reason: 'No free rooms on requested dates',
    });
    assert.strictEqual(validDenial.category, 'LEAVE');
  });

  it('Schema validation: ApproveEvictionSchema requires 10+ char reason', () => {
    assert.throws(() => {
      ApproveEvictionSchema.parse({
        incomingBooking: {
          category: 'MSA',
          checkIn: '2026-10-01',
          checkOut: '2026-10-03',
          partySize: 1,
          guests: [{ gender: 'M', rankCode: 'WG_CDR' }],
        },
        evictAllocationIds: ['alloc-1'],
        reason: 'Too short', // 9 characters
      });
    }, /10 characters/i);
  });
});
