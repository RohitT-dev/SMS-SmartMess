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
  CivilianPiiSchema,
  CreateBookingRequestSchema,
  canShareRoom,
  pairParty,
  findAlternateWindows,
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

  it('A bed that changes hands mid-stay must suit every occupant, not just the last one', () => {
    const day = (n: number) => `2030-01-0${n}`;
    const occ = (gender: 'M' | 'F', booking: string) => ({
      allocationId: `${booking}-1`,
      bookingId: booking,
      bedSlot: 1 as const,
      gender,
      rankCode: 'WG_CDR' as const,
      category: 'LEAVE' as const,
      bookingStatus: 'CONFIRMED' as const,
      checkIn: day(1),
      checkOut: day(5),
      allowSharing: true,
    });
    const state = (date: string, o: ReturnType<typeof occ>): RoomDayState => ({
      roomId: 'R1',
      roomType: 'NORMAL',
      displayOrder: 1,
      date,
      bedsTaken: 1,
      isClosed: false,
      occupants: [o],
    });
    // Bed 1: a man on nights 1-2, a woman on nights 3-4. Bed 2 is free throughout.
    const states = [
      state(day(1), occ('M', 'a')),
      state(day(2), occ('M', 'a')),
      state(day(3), occ('F', 'b')),
      state(day(4), occ('F', 'b')),
    ];
    const plan = planAllotment(
      {
        category: 'LEAVE',
        checkIn: day(1),
        checkOut: day(5),
        allowSharing: true,
        guests: [{ gender: 'M', rankCode: 'FO', relation: 'PRIMARY' }],
      } as BookingPlanRequest,
      states,
    );
    assert.notStrictEqual(plan.kind, 'ALLOT');
  });

  it('Eviction eligibility matrix (all priority combinations)', () => {
    // MFA can displace PI, LEAVE, TD
    assert.strictEqual(canDisplace('MFA', 'PI'), true);
    assert.strictEqual(canDisplace('MFA', 'LEAVE'), true);
    assert.strictEqual(canDisplace('MFA', 'TD'), true);
    assert.strictEqual(canDisplace('MFA', 'MFA'), false); // Cannot displace other MFA

    // PI can displace LEAVE, TD
    assert.strictEqual(canDisplace('PI', 'LEAVE'), true);
    assert.strictEqual(canDisplace('PI', 'TD'), true);
    assert.strictEqual(canDisplace('PI', 'PI'), false);
    assert.strictEqual(canDisplace('PI', 'MFA'), false); // Cannot displace MFA

    // LEAVE and TD can NEVER displace anyone
    assert.strictEqual(canDisplace('LEAVE', 'LEAVE'), false);
    assert.strictEqual(canDisplace('LEAVE', 'TD'), false);
    assert.strictEqual(canDisplace('LEAVE', 'PI'), false);
    assert.strictEqual(canDisplace('LEAVE', 'MFA'), false);

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
      category: 'MFA',
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
        { day: dayStr, category: 'MFA', roomType: 'NORMAL', people: M[day - 1] },
        { day: dayStr, category: 'PI', roomType: 'NORMAL', people: P[day - 1] },
        { day: dayStr, category: 'LEAVE', roomType: 'NORMAL', people: L[day - 1] },
        { day: dayStr, category: 'TD', roomType: 'NORMAL', people: T[day - 1] },
      );
    }

    const bedsTotal = 92;
    const insights = reportInsights(dailyRows, bedsTotal, 0);

    // Expected: total 661, average 55.1, peak 71 on day 10, MFA+PI share 62%, 92 beds, peak occupancy 77%.
    assert.strictEqual(insights.totalPeopleDays, 661);
    assert.strictEqual(insights.dailyAverage, 55.1);
    assert.strictEqual(insights.peakDay, '2026-10-10'); // Day 10
    assert.strictEqual(insights.peakCount, 71);
    assert.strictEqual(insights.mfaPiSharePercentage, 62);
    assert.strictEqual(insights.bedsTotal, 92);
    assert.strictEqual(insights.peakOccupancyPercentage, 77);
    assert.ok(insights.writtenInsights.length >= 3);
  });

  it('Error mappings provide user-facing guidance', () => {
    const shareErr = getErrorMessage('Database returned ERR_SHARE_RULE');
    assert.strictEqual(shareErr.code, 'ERR_SHARE_RULE');
    assert.ok(shareErr.message.includes('same gender'));
    assert.ok(!shareErr.message.includes('same rank'));

    const exclusiveErr = getErrorMessage('ERR_ROOM_EXCLUSIVE');
    assert.strictEqual(exclusiveErr.code, 'ERR_ROOM_EXCLUSIVE');

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

    // ID number is now optional; Aadhaar/Passport is not required
    const withoutId = {
      name: 'Major General V. Rao',
      phone: '+91 9876543210',
    };
    const parsedWithoutId = GuestPiiSchema.parse(withoutId);
    assert.strictEqual(parsedWithoutId.name, 'Major General V. Rao');
    assert.strictEqual(parsedWithoutId.idNumber, null);

    assert.throws(() => {
      GuestPiiSchema.parse({ name: '' });
    });
  });

  it('Schema validation: DenyRequestSchema blocks priority categories', () => {
    assert.throws(() => {
      DenyRequestSchema.parse({
        category: 'MFA',
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
          category: 'MFA',
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

  it('Sharing rule: civilians share only within their own booking', () => {
    const officer = { gender: 'M' as const, rankCode: 'WG_CDR' as const, bookingId: 'b1' };
    const spouse = { gender: 'F' as const, rankCode: null, bookingId: 'b1' };
    assert.strictEqual(canShareRoom(officer, spouse), true);
    assert.strictEqual(canShareRoom(spouse, { ...spouse, bookingId: 'b2' }), false);
    assert.strictEqual(canShareRoom(spouse, { gender: 'F', rankCode: null }), false);
    assert.strictEqual(canShareRoom(officer, { gender: 'M', rankCode: 'WG_CDR', bookingId: 'b2' }), true);
    assert.strictEqual(canShareRoom(officer, { gender: 'F', rankCode: 'WG_CDR', bookingId: 'b1' }), false);
  });

  it('Sharing rule: ranked people of the same gender may share whatever their ranks', () => {
    const wgCdr = { gender: 'M' as const, rankCode: 'WG_CDR' as const, bookingId: 'b1' };
    assert.strictEqual(canShareRoom(wgCdr, { gender: 'M', rankCode: 'FO', bookingId: 'b2' }), true);
    assert.strictEqual(canShareRoom(wgCdr, { gender: 'M', rankCode: 'AIR_CDRE', bookingId: 'b1' }), true);
    assert.strictEqual(canShareRoom(wgCdr, { gender: 'F', rankCode: 'WG_CDR', bookingId: 'b2' }), false);
    assert.strictEqual(canShareRoom(wgCdr, { gender: 'F', rankCode: 'FO', bookingId: 'b2' }), false);
  });

  it('Sharing rule: a booking that does not allow sharing never shares with another booking', () => {
    const base = { gender: 'M' as const, rankCode: 'WG_CDR' as const };
    const exclusive = { ...base, bookingId: 'b1', allowSharing: false };
    const open = { ...base, bookingId: 'b2', allowSharing: true };
    assert.strictEqual(canShareRoom(exclusive, open), false);
    assert.strictEqual(canShareRoom(open, exclusive), false);
    assert.strictEqual(canShareRoom(open, { ...open, bookingId: 'b3' }), true);
    // Missing flag = the row predates the option = shareable.
    assert.strictEqual(canShareRoom(open, { ...base, bookingId: 'b3' }), true);
    // Its own party always shares with itself.
    assert.strictEqual(canShareRoom(exclusive, { ...exclusive, rankCode: 'FO' }), true);
    assert.strictEqual(
      canShareRoom(exclusive, { gender: 'F', rankCode: null, bookingId: 'b1', allowSharing: false }),
      true,
    );
  });

  it('pairParty: primary with spouse, children together', () => {
    const { pairs, singles } = pairParty([
      { gender: 'M', rankCode: 'GP_CAPT', relation: 'PRIMARY' },
      { gender: 'M', rankCode: null, relation: 'CHILD' },
      { gender: 'F', rankCode: null, relation: 'SPOUSE' },
      { gender: 'F', rankCode: null, relation: 'CHILD' },
      { gender: 'F', rankCode: null, relation: 'PARENT' },
    ]);
    const idx = pairs.map(([a, b]) => [a.guestIndex, b.guestIndex]);
    assert.deepStrictEqual(idx, [[0, 2], [1, 3]]);
    assert.deepStrictEqual(singles.map((s) => s.guestIndex), [4]);
  });

  it('Allotment Engine: family of three fits one room + one bed, never beside a stranger', () => {
    const day = '2026-10-20';
    const states: RoomDayState[] = [
      {
        roomId: 'shared', roomType: 'NORMAL', displayOrder: 1, date: day, bedsTaken: 1, isClosed: false,
        occupants: [{
          allocationId: 'a1', bookingId: 'other', bedSlot: 1, gender: 'F', rankCode: null, relation: 'OTHER',
          category: 'LEAVE', bookingStatus: 'CONFIRMED', checkIn: day, checkOut: '2026-10-21',
        }],
      },
      { roomId: 'r2', roomType: 'NORMAL', displayOrder: 2, date: day, bedsTaken: 0, isClosed: false, occupants: [] },
      { roomId: 'r3', roomType: 'NORMAL', displayOrder: 3, date: day, bedsTaken: 0, isClosed: false, occupants: [] },
    ];
    const plan = planAllotment(
      {
        category: 'PI', checkIn: day, checkOut: '2026-10-21', allowSharing: true, preferSharing: true,
        guests: [
          { gender: 'M', rankCode: 'WG_CDR', relation: 'PRIMARY' },
          { gender: 'F', rankCode: null, relation: 'SPOUSE' },
          { gender: 'F', rankCode: null, relation: 'CHILD' },
        ],
      },
      states,
    );
    assert.strictEqual(plan.kind, 'ALLOT');
    if (plan.kind !== 'ALLOT') return;
    const roomOf = (i: number) => plan.assignments.find((a) => a.guestIndex === i)!.roomId;
    assert.strictEqual(roomOf(0), roomOf(1));
    assert.notStrictEqual(roomOf(2), 'shared');
  });

  it('Schema validation: booking needs one ranked primary; civilians carry no rank', () => {
    const base = { category: 'PI', checkIn: '2026-10-01', checkOut: '2026-10-03', partySize: 2 };
    assert.ok(
      CreateBookingRequestSchema.safeParse({
        ...base,
        guests: [
          { gender: 'M', rankCode: 'FO', relation: 'PRIMARY' },
          { gender: 'F', rankCode: null, relation: 'SPOUSE' },
        ],
      }).success,
    );
    assert.ok(
      !CreateBookingRequestSchema.safeParse({
        ...base,
        guests: [
          { gender: 'F', rankCode: null, relation: 'SPOUSE' },
          { gender: 'F', rankCode: null, relation: 'CHILD' },
        ],
      }).success,
    );
    assert.ok(CivilianPiiSchema.safeParse({ name: 'Asha' }).success);
    assert.ok(!CivilianPiiSchema.safeParse({ name: ' ' }).success);
  });

  describe('Allow room sharing', () => {
    const DAY = '2026-10-20';
    const NEXT = '2026-10-21';

    type Occ = { gender: 'M' | 'F'; rankCode: 'WG_CDR' | 'FO' | 'SQN_LDR' | null; bookingId: string; bedSlot?: 1 | 2; allowSharing?: boolean };

    /** One room for the night of DAY. */
    const room = (roomId: string, order: number, occupants: Occ[] = []): RoomDayState => ({
      roomId,
      roomType: 'NORMAL',
      displayOrder: order,
      date: DAY,
      bedsTaken: occupants.length,
      isClosed: false,
      occupants: occupants.map((o, i) => ({
        allocationId: `${roomId}-${i}`,
        bookingId: o.bookingId,
        bedSlot: o.bedSlot ?? ((i + 1) as 1 | 2),
        gender: o.gender,
        rankCode: o.rankCode,
        category: 'LEAVE' as const,
        bookingStatus: 'CONFIRMED' as const,
        checkIn: DAY,
        checkOut: NEXT,
        ...(o.allowSharing === undefined ? {} : { allowSharing: o.allowSharing }),
      })),
    });

    const plan = (allowSharing: boolean | undefined, guests: BookingPlanRequest['guests'], states: RoomDayState[]) =>
      planAllotment({ category: 'LEAVE', checkIn: DAY, checkOut: NEXT, guests, allowSharing }, states);

    const manFo = [{ gender: 'M' as const, rankCode: 'FO' as const, relation: 'PRIMARY' as const }];
    const roomOf = (res: ReturnType<typeof planAllotment>, guestIndex = 0) => {
      assert.strictEqual(res.kind, 'ALLOT');
      return res.kind === 'ALLOT' ? res.assignments.find((a) => a.guestIndex === guestIndex)!.roomId : '';
    };

    it('unchecked: only fully unoccupied rooms are offered, even when a shareable bed comes first', () => {
      const states = [
        room('shared', 1, [{ gender: 'M', rankCode: 'FO', bookingId: 'x', allowSharing: true }]),
        room('empty', 2),
      ];
      assert.strictEqual(roomOf(plan(false, manFo, states)), 'empty');
      // Nothing is picked by default either.
      assert.strictEqual(roomOf(plan(undefined, manFo, states)), 'empty');
    });

    it('unchecked: with no vacant room the request cannot be allotted, however many beds are free', () => {
      const states = [
        room('shared', 1, [{ gender: 'M', rankCode: 'FO', bookingId: 'x', allowSharing: true }]),
        room('full', 2, [
          { gender: 'F', rankCode: 'FO', bookingId: 'y', allowSharing: true },
          { gender: 'F', rankCode: 'FO', bookingId: 'y', allowSharing: true },
        ]),
      ];
      assert.notStrictEqual(plan(false, manFo, states).kind, 'ALLOT');
      assert.strictEqual(plan(true, manFo, states).kind, 'ALLOT');
    });

    it('checked: empty rooms are used first, a shareable bed once the empty rooms run out', () => {
      const withEmpty = [
        room('shared', 1, [{ gender: 'M', rankCode: 'FO', bookingId: 'x', allowSharing: true }]),
        room('empty', 2),
      ];
      assert.strictEqual(roomOf(plan(true, manFo, withEmpty)), 'empty');
      assert.strictEqual(roomOf(plan(true, manFo, [withEmpty[0]])), 'shared');
      // preferSharing flips the order: the shared bed is offered before the empty room.
      const preferShared = planAllotment(
        { category: 'LEAVE', checkIn: DAY, checkOut: NEXT, guests: manFo, allowSharing: true, preferSharing: true },
        withEmpty,
      );
      assert.strictEqual(roomOf(preferShared), 'shared');
    });

    it('checked: different ranks of the same gender can share', () => {
      const states = [room('shared', 1, [{ gender: 'M', rankCode: 'WG_CDR', bookingId: 'x', allowSharing: true }])];
      const res = plan(true, manFo, states);
      assert.strictEqual(roomOf(res), 'shared');
      assert.strictEqual(res.kind === 'ALLOT' && res.assignments[0].bedSlot, 2);
    });

    it('checked: a different gender cannot share, whatever the rank', () => {
      const states = [room('shared', 1, [{ gender: 'F', rankCode: 'FO', bookingId: 'x', allowSharing: true }])];
      assert.notStrictEqual(plan(true, manFo, states).kind, 'ALLOT');
    });

    it('checked: a civilian occupant is never shared with another booking', () => {
      const states = [room('shared', 1, [{ gender: 'F', rankCode: null, bookingId: 'x', allowSharing: true }])];
      assert.notStrictEqual(plan(true, manFo, states).kind, 'ALLOT');
    });

    it('an exclusive booking blocks the second bed for every other booking', () => {
      const states = [
        room('held', 1, [{ gender: 'M', rankCode: 'FO', bookingId: 'x', allowSharing: false }]),
        room('empty', 2),
      ];
      // Even a same-gender request that allows sharing is sent to the empty room.
      assert.strictEqual(roomOf(plan(true, manFo, states)), 'empty');
      assert.notStrictEqual(plan(true, manFo, [states[0]]).kind, 'ALLOT');
    });

    it('a party of two in one exclusive booking still fills its own room', () => {
      const states = [room('empty', 1)];
      const pair = [
        { gender: 'M' as const, rankCode: 'WG_CDR' as const, relation: 'PRIMARY' as const },
        { gender: 'M' as const, rankCode: 'FO' as const, relation: 'SERVICE' as const },
      ];
      const res = plan(false, pair, states);
      assert.strictEqual(roomOf(res, 0), 'empty');
      assert.strictEqual(roomOf(res, 1), 'empty');
    });

    it('occupants from before the option (no flag) count as shareable', () => {
      const states = [room('legacy', 1, [{ gender: 'M', rankCode: 'FO', bookingId: 'x' }])];
      assert.strictEqual(roomOf(plan(true, manFo, states)), 'legacy');
    });

    it('a party shares a vacant room only between guests who may share; otherwise each needs a room', () => {
      const states = [room('only', 1)];
      assert.strictEqual(roomOf(plan(true, [...manFo, { gender: 'M', rankCode: 'WG_CDR', relation: 'SERVICE' }], states), 1), 'only');
      // A man and a woman cannot share, and with a single room neither option can seat both.
      const mixed = [
        { gender: 'M' as const, rankCode: 'FO' as const, relation: 'PRIMARY' as const },
        { gender: 'F' as const, rankCode: 'FO' as const, relation: 'SERVICE' as const },
      ];
      assert.notStrictEqual(plan(false, mixed, states).kind, 'ALLOT');
      assert.notStrictEqual(plan(true, mixed, states).kind, 'ALLOT');
    });

    it('alternate windows follow the option: unchecked skips windows that only offer a shared bed', () => {
      const d = (n: number) => `2026-10-${String(20 + n)}`;
      const states: RoomDayState[] = [];
      for (let n = 0; n < 4; n++) {
        states.push({ ...room('r1', 1, [{ gender: 'M', rankCode: 'FO', bookingId: 'x', allowSharing: true }]), date: d(n) });
      }
      // Room r2 is occupied for the first two nights only.
      for (let n = 0; n < 4; n++) {
        const occupied = n < 2 ? [{ gender: 'F' as const, rankCode: 'FO' as const, bookingId: 'y', allowSharing: true }, { gender: 'F' as const, rankCode: 'FO' as const, bookingId: 'y', allowSharing: true }] : [];
        states.push({ ...room('r2', 2, occupied), date: d(n) });
      }
      const request = { category: 'LEAVE' as const, checkIn: d(0), checkOut: d(1), guests: manFo };
      const unchecked = findAlternateWindows({ ...request, allowSharing: false }, states, 5, 2);
      const checked = findAlternateWindows({ ...request, allowSharing: true }, states, 5, 2);
      // Unchecked needs a wholly empty room: r2 from the 22nd on.
      assert.deepStrictEqual(unchecked.map((w) => w.checkIn), [d(2)]);
      // Checked can also sit beside the man in r1 on the 21st.
      assert.deepStrictEqual(checked.map((w) => w.checkIn), [d(1), d(2)]);
    });

    it('pairParty: equal ranks pair first, then the same gender whatever the rank', () => {
      const { pairs, singles } = pairParty([
        { gender: 'M', rankCode: 'WG_CDR', relation: 'PRIMARY' },
        { gender: 'M', rankCode: 'FO', relation: 'SERVICE' },
        { gender: 'M', rankCode: 'WG_CDR', relation: 'SERVICE' },
        { gender: 'F', rankCode: 'SQN_LDR', relation: 'SERVICE' },
        { gender: 'M', rankCode: 'SQN_LDR', relation: 'SERVICE' },
      ]);
      const idx = pairs.map(([a, b]) => [a.guestIndex, b.guestIndex]);
      // WG_CDR + WG_CDR (0,2) by equal rank; the leftover FO (1) and SQN_LDR (4) share as men.
      assert.deepStrictEqual(idx, [[0, 2], [1, 4]]);
      assert.deepStrictEqual(singles.map((x) => x.guestIndex), [3]);
    });
  });
});
