/**
 * Booking permutation scenarios.
 *
 * Drives the same code path as the New Booking screen: daily_room_state -> mapRoomDayState ->
 * planAllotment -> create_booking, against the dev backend (which mirrors the SQL triggers,
 * exclusion constraints and RPC rules). The pgTAP suite remains the source of truth for the DB.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  planAllotment,
  type AllotmentResult,
  type Category,
  type CivilianRelation,
  type Gender,
  type GuestDemand,
  type RankCode,
  type RoomType,
} from '@sms/core';
import { createDevSupabase, DEV_USERS, messToday } from './devBackend';
import { mapRoomDayState } from '../features/bookings/mapRoomState';
import { userErrorMessage } from '../lib/userError';
import { addDaysToDateString } from '../lib/dates';
import { alternatesHorizonEnd, guestRowsPayload } from '../features/bookings/planBooking';
import { buildPastBookingsHtml } from '../features/reports/pastBookingsHtml';

type Sb = ReturnType<typeof createDevSupabase> & { auth: any };

const today = messToday(); // public.mess_today(): the mess's own calendar date (IST)
const d = (n: number) => addDaysToDateString(today, n);

const G = (gender: Gender, rankCode: RankCode): GuestDemand => ({ gender, rankCode });
const C = (gender: Gender, relation: CivilianRelation): GuestDemand => ({ gender, rankCode: null, relation });

interface BookArgs {
  category?: Category;
  checkIn: string;
  checkOut: string;
  guests: GuestDemand[];
  pref?: RoomType;
  sharing?: boolean;
}

let sb: Sb;
let roomIds: Record<string, string>; // name -> id

async function signInAs(key: 'admin' | 'clerk') {
  await sb.auth.signInWithPassword({ email: DEV_USERS[key].email });
}

async function addRoom(name: string, type: RoomType, order: number) {
  const id = crypto.randomUUID();
  const { error } = await (sb.from('rooms') as any).insert({
    id,
    room_type: type,
    name_enc: `enc:${name}`,
    display_order: order,
  });
  expect(error, `adding room ${name}`).toBeNull();
  roomIds[name] = id;
}

const nameOf = (id: string) => Object.entries(roomIds).find(([, v]) => v === id)?.[0] ?? id;

async function plan(a: BookArgs): Promise<AllotmentResult> {
  const request = {
    category: a.category ?? 'MFA',
    checkIn: a.checkIn,
    checkOut: a.checkOut,
    guests: a.guests,
    preferredRoomType: a.pref,
    preferSharing: a.sharing,
  };
  const load = async (to: string) => {
    const { data, error } = await sb.rpc('daily_room_state', { p_from: a.checkIn, p_to: to });
    expect(error).toBeNull();
    return (data as any[]).map(mapRoomDayState);
  };
  // Same two-step flow as the New Booking screen: the stay first, the alternates horizon only if needed.
  const first = planAllotment(request, await load(a.checkOut));
  if (first.kind === 'ALLOT') return first;
  return planAllotment(request, await load(alternatesHorizonEnd(a.checkOut)));
}

function bookingPayload(a: BookArgs, allocs: Array<{ guestIndex: number; roomId: string; bedSlot: number }>) {
  return {
    p_booking: {
      category: a.category ?? 'MFA',
      check_in: a.checkIn,
      check_out: a.checkOut,
      party_size: a.guests.length,
      is_suite_booking: false,
    },
    p_guests: guestRowsPayload(a.guests),
    p_allocations: allocs.map((x) => ({ guest_seq: x.guestIndex + 1, room_id: x.roomId, bed_slot: x.bedSlot })),
  };
}

/** Plans and books in one go; returns the booking id and the placements by room name. */
async function book(a: BookArgs) {
  const result = await plan(a);
  expect(result.kind, 'expected the engine to allot').toBe('ALLOT');
  if (result.kind !== 'ALLOT') throw new Error('unreachable');
  const { data, error } = await sb.rpc('create_booking', bookingPayload(a, result.assignments));
  expect(error, error?.message).toBeNull();
  return {
    id: data as string,
    placements: result.assignments.map((x) => ({ guest: x.guestIndex, room: nameOf(x.roomId), bed: x.bedSlot, type: x.roomType })),
    usedFallbackType: result.usedFallbackType,
  };
}

async function rooms(from: string, to: string) {
  const { data } = await sb.rpc('daily_room_state', { p_from: from, p_to: to });
  return data as any[];
}

async function fillAllRooms(checkIn: string, checkOut: string, category: Category = 'LEAVE') {
  // 9 pairs, one per non-suite room, each with a distinct (gender, rank) so nobody can share.
  const profiles: Array<[Gender, RankCode]> = [
    ['M', 'FO'], ['M', 'FLT_LT'], ['M', 'SQN_LDR'], ['M', 'WG_CDR'], ['M', 'GP_CAPT'],
    ['F', 'FO'], ['F', 'FLT_LT'], ['F', 'SQN_LDR'], ['F', 'WG_CDR'],
  ];
  const ids: string[] = [];
  for (const [g, r] of profiles) {
    const res = await book({ category, checkIn, checkOut, guests: [G(g, r), G(g, r)] });
    ids.push(res.id);
  }
  return ids;
}

beforeEach(async () => {
  sb = createDevSupabase('mock') as Sb;
  roomIds = {};
  await signInAs('admin');
  // 3 Normal, 3 Semi VIP, 3 VIP, 1 Suite — same inventory as the manual run.
  await addRoom('N-01', 'NORMAL', 1);
  await addRoom('N-02', 'NORMAL', 2);
  await addRoom('N-03', 'NORMAL', 3);
  await addRoom('S-01', 'SEMI_VIP', 4);
  await addRoom('S-02', 'SEMI_VIP', 5);
  await addRoom('S-03', 'SEMI_VIP', 6);
  await addRoom('V-01', 'VIP', 7);
  await addRoom('V-02', 'VIP', 8);
  await addRoom('V-03', 'VIP', 9);
  await addRoom('SU-01', 'SUITE', 10);
});

describe('placement permutations', () => {
  it('single guest, preferred type honoured', async () => {
    const r = await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'WG_CDR')], pref: 'VIP' });
    expect(r.placements).toEqual([{ guest: 0, room: 'V-01', bed: 1, type: 'VIP' }]);
    expect(r.usedFallbackType).toBe(false);
  });

  it('two guests with same gender and rank share one room', async () => {
    const r = await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO'), G('M', 'FO')], pref: 'NORMAL' });
    expect(new Set(r.placements.map((p) => p.room)).size).toBe(1);
    expect(r.placements.map((p) => p.bed).sort()).toEqual([1, 2]);
  });

  it('different gender → separate rooms', async () => {
    const r = await book({ checkIn: d(0), checkOut: d(1), guests: [G('M', 'FO'), G('F', 'FO')], pref: 'NORMAL' });
    expect(new Set(r.placements.map((p) => p.room)).size).toBe(2);
  });

  it('same gender but different rank → separate rooms', async () => {
    const r = await book({ checkIn: d(0), checkOut: d(1), guests: [G('M', 'FO'), G('M', 'FLT_LT')], pref: 'NORMAL' });
    expect(new Set(r.placements.map((p) => p.room)).size).toBe(2);
  });

  it('party of 5 with a mix pairs what it can (3 rooms)', async () => {
    const r = await book({
      checkIn: d(0),
      checkOut: d(3),
      guests: [G('M', 'FO'), G('M', 'FO'), G('F', 'FO'), G('F', 'FO'), G('M', 'WG_CDR')],
      pref: 'VIP',
    });
    expect(new Set(r.placements.map((p) => p.room)).size).toBe(3);
    expect(r.placements.every((p) => p.type === 'VIP')).toBe(true);
  });

  it('falls back to other room types when the preferred type is full', async () => {
    for (let i = 0; i < 3; i++) {
      await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO'), G('M', 'FO')], pref: 'VIP' });
    }
    const r = await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO'), G('M', 'FO')], pref: 'VIP' });
    expect(r.usedFallbackType).toBe(true);
    expect(r.placements[0].type).not.toBe('VIP');
  });

  it('no preference picks the lowest display order that fits', async () => {
    const r = await book({ checkIn: d(0), checkOut: d(1), guests: [G('M', 'FO')] });
    expect(r.placements[0].room).toBe('N-01');
  });

  it('18 identical guests fill all nine non-suite rooms; 19th has nowhere to go', async () => {
    const guests = Array.from({ length: 18 }, () => G('M', 'FO'));
    const r = await book({ checkIn: d(0), checkOut: d(1), guests });
    expect(new Set(r.placements.map((p) => p.room)).size).toBe(9);
    const extra = await plan({ checkIn: d(0), checkOut: d(1), guests: [G('M', 'FO')] });
    // Nothing free that day: the engine proposes a later window instead.
    expect(extra.kind).toBe('ALTERNATES');
  });

  it('a party of 19 can never fit (no alternates, NONE)', async () => {
    const guests = Array.from({ length: 19 }, () => G('M', 'FO'));
    const res = await plan({ checkIn: d(0), checkOut: d(1), guests });
    expect(res.kind).toBe('NONE');
  });

  it('a lone guest leaves the second bed open to a compatible guest once whole rooms run out', async () => {
    // Nine singles, each in their own room, with distinct profiles except the last two rooms.
    const profiles: Array<[Gender, RankCode]> = [
      ['M', 'FO'], ['M', 'FLT_LT'], ['M', 'SQN_LDR'], ['M', 'WG_CDR'], ['M', 'GP_CAPT'],
      ['F', 'FO'], ['F', 'FLT_LT'], ['F', 'SQN_LDR'], ['F', 'WG_CDR'],
    ];
    for (const [g, rk] of profiles) await book({ checkIn: d(0), checkOut: d(2), guests: [G(g, rk)] });
    // Compatible with an existing single (M/FO) → shares that room's second bed.
    const share = await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')] });
    expect(share.placements[0]).toMatchObject({ room: 'N-01', bed: 2 });
    // Incompatible with every occupant → nothing free.
    const none = await plan({ checkIn: d(0), checkOut: d(2), guests: [G('F', 'AVM')] });
    expect(none.kind).not.toBe('ALLOT');
  });

  it('partially overlapping stays never share a bed', async () => {
    await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP' });
    const r = await book({ checkIn: d(1), checkOut: d(3), guests: [G('M', 'FO')], pref: 'VIP' });
    expect(r.placements[0].room).toBe('V-02'); // V-01 bed 1 is busy on day 1; whole rooms preferred
  });

  it('back-to-back stays reuse the same bed (check-out day is free)', async () => {
    const a = await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP' });
    const b = await book({ checkIn: d(2), checkOut: d(4), guests: [G('F', 'AVM')], pref: 'VIP' });
    expect(a.placements[0]).toMatchObject({ room: 'V-01', bed: 1 });
    expect(b.placements[0]).toMatchObject({ room: 'V-01', bed: 1 });
  });

  it('single-night stay and a 100-night stay both work', async () => {
    await book({ checkIn: d(0), checkOut: d(1), guests: [G('M', 'FO')] });
    await book({ checkIn: d(0), checkOut: d(100), guests: [G('M', 'FO')] });
  });

  it('suites are never proposed by the engine, even with everything else full', async () => {
    await fillAllRooms(d(0), d(2));
    const res = await plan({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'MIAF')] });
    if (res.kind === 'ALLOT') throw new Error('engine proposed a room on a full house');
  });
});

describe('prefer shared rooms', () => {
  it('seats a lone guest beside a compatible guest instead of opening an empty room', async () => {
    await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP' }); // V-01 bed 1
    // Default: an empty room is used.
    const normal = await plan({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP' });
    expect(normal.kind === 'ALLOT' && nameOf(normal.assignments[0].roomId)).toBe('V-02');
    // With sharing on: V-01 bed 2.
    const shared = await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP', sharing: true });
    expect(shared.placements[0]).toMatchObject({ room: 'V-01', bed: 2 });
  });

  it('shared rooms win even when they are in a different room type than the preferred one', async () => {
    await book({ checkIn: d(0), checkOut: d(2), guests: [G('F', 'SQN_LDR')], pref: 'NORMAL' }); // N-01 bed 1
    const r = await book({ checkIn: d(0), checkOut: d(2), guests: [G('F', 'SQN_LDR')], pref: 'VIP', sharing: true });
    expect(r.placements[0]).toMatchObject({ room: 'N-01', bed: 2 });
    expect(r.usedFallbackType).toBe(true);
  });

  it('incompatible guests are not shared; falls back to an empty room in the preferred type', async () => {
    await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'NORMAL' });
    const r = await book({ checkIn: d(0), checkOut: d(2), guests: [G('F', 'FO')], pref: 'VIP', sharing: true });
    expect(r.placements[0].room).toBe('V-01');
    expect(r.usedFallbackType).toBe(false);
  });

  it('pairs still take whole rooms; only the odd guest out is seated in a shared bed', async () => {
    await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'NORMAL' }); // N-01 bed 1
    const r = await book({
      checkIn: d(0), checkOut: d(2), pref: 'NORMAL', sharing: true,
      guests: [G('M', 'FO'), G('M', 'FO'), G('M', 'FO')],
    });
    const byRoom = r.placements.reduce<Record<string, number>>((m, p) => ({ ...m, [p.room]: (m[p.room] ?? 0) + 1 }), {});
    expect(byRoom['N-01']).toBe(1); // the third guest joined the existing M/FO
    expect(Object.values(byRoom).sort()).toEqual([1, 2]);
  });

  it('with no shareable bed anywhere it behaves like the default', async () => {
    const r = await book({ checkIn: d(0), checkOut: d(1), guests: [G('M', 'FO')], pref: 'SEMI_VIP', sharing: true });
    expect(r.placements[0].room).toBe('S-01');
  });
});

describe('full house: alternates, denial, eviction', () => {
  it('offers the first free window after the existing stays', async () => {
    await fillAllRooms(d(0), d(2));
    const res = await plan({ category: 'LEAVE', checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')] });
    expect(res.kind).toBe('ALTERNATES');
    if (res.kind === 'ALTERNATES') {
      expect(res.windows[0]).toMatchObject({ checkIn: d(2), checkOut: d(4) });
      expect(res.windows.length).toBeGreaterThan(1);
    }
  });

  it('LEAVE/TD can be denied, MFA/PI cannot', async () => {
    const ok = await sb.rpc('record_denial', {
      p_category: 'LEAVE', p_check_in: d(0), p_check_out: d(2), p_party_size: 1, p_reason_enc: 'enc', p_key_version: 1, p_id: crypto.randomUUID(),
    });
    expect(ok.error).toBeNull();
    for (const cat of ['MFA', 'PI']) {
      const bad = await sb.rpc('record_denial', {
        p_category: cat, p_check_in: d(0), p_check_out: d(2), p_party_size: 1, p_reason_enc: 'enc', p_key_version: 1,
      });
      expect(bad.error?.message).toContain('ERR_CANNOT_DENY_PRIORITY');
      expect(userErrorMessage(bad.error)).toMatch(/cannot be turned away|Eviction Review/i);
    }
  });

  it('MFA evicts LEAVE: candidates exclude MFA/PI and the incoming booking takes the freed beds', async () => {
    await fillAllRooms(d(0), d(2), 'LEAVE');
    const { data: cands } = await sb.rpc('eviction_candidates', {
      p_category: 'MFA', p_check_in: d(0), p_check_out: d(2), p_guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }],
    });
    expect(cands.length).toBe(18);
    expect(cands.every((c: any) => c.category === 'LEAVE')).toBe(true);

    // Evict both beds of the first room so the whole room is clean for an M/AVM guest.
    const firstRoom = cands[0].room_id;
    const leaveId = cands[0].booking_id;
    const ids = cands.filter((c: any) => c.room_id === firstRoom).map((c: any) => c.allocation_id);
    expect(ids.length).toBe(2);
    const { data: newId, error } = await sb.rpc('approve_eviction', {
      p_incoming: { category: 'MFA', check_in: d(0), check_out: d(2), party_size: 1, guests: [{ seq: 1, gender: 'M', rank_code: 'AVM' }] },
      p_evict_allocation_ids: ids,
      p_reason_enc: 'enc:official-duty-reason',
      p_key_version: 1,
      p_reason_aad_id: crypto.randomUUID(),
    });
    expect(error, error?.message).toBeNull();
    const { data: displaced } = await sb.from('bookings').select('*').eq('id', leaveId).single();
    expect(displaced.status).toBe('DISPLACED');
    const { data: incoming } = await (sb.from('bookings') as any).select('*, allocations(*)').eq('id', newId).single();
    expect(incoming.allocations).toHaveLength(1);
  });

  it('PI can evict LEAVE/TD only; PI cannot evict PI or MFA', async () => {
    await book({ category: 'MFA', checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO'), G('M', 'FO')], pref: 'VIP' });
    await book({ category: 'PI', checkIn: d(0), checkOut: d(2), guests: [G('M', 'FLT_LT'), G('M', 'FLT_LT')], pref: 'VIP' });
    await book({ category: 'TD', checkIn: d(0), checkOut: d(2), guests: [G('M', 'SQN_LDR'), G('M', 'SQN_LDR')], pref: 'VIP' });
    const { data } = await sb.rpc('eviction_candidates', {
      p_category: 'PI', p_check_in: d(0), p_check_out: d(2), p_guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }],
    });
    expect(data.map((c: any) => c.category).every((c: string) => c === 'TD')).toBe(true);
    const none = await sb.rpc('eviction_candidates', {
      p_category: 'LEAVE', p_check_in: d(0), p_check_out: d(2), p_guests: [],
    });
    expect(none.data).toEqual([]);
  });

  it('evicting a bed whose roommate stays rejects an incompatible incoming guest (share rule)', async () => {
    // Pair of M/FO in V-01 (LEAVE). Evict only one bed and seat an F guest next to the other.
    await book({ category: 'LEAVE', checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO'), G('M', 'FO')], pref: 'VIP' });
    const { data: cands } = await sb.rpc('eviction_candidates', {
      p_category: 'MFA', p_check_in: d(0), p_check_out: d(2), p_guests: [{ seq: 1, gender: 'F', rank_code: 'FO' }],
    });
    const res = await sb.rpc('approve_eviction', {
      p_incoming: { category: 'MFA', check_in: d(0), check_out: d(2), party_size: 1, guests: [{ seq: 1, gender: 'F', rank_code: 'FO' }] },
      p_evict_allocation_ids: [cands[0].allocation_id],
      p_reason_enc: 'enc:official-duty-reason',
      p_key_version: 1,
      p_reason_aad_id: crypto.randomUUID(),
    });
    expect(res.error?.message).toContain('ERR_SHARE_RULE');
    // Atomic: nothing was evicted.
    const after = await sb.rpc('eviction_candidates', {
      p_category: 'MFA', p_check_in: d(0), p_check_out: d(2), p_guests: [],
    });
    expect(after.data).toHaveLength(2);
  });

  it('partial eviction of a multi-room party must not strand the rest of the party', async () => {
    // One LEAVE booking of two different people (two rooms). Evict just one of them.
    const party = await book({ category: 'LEAVE', checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO'), G('F', 'FO')], pref: 'VIP' });
    const { data: cands } = await sb.rpc('eviction_candidates', {
      p_category: 'MFA', p_check_in: d(0), p_check_out: d(2), p_guests: [{ seq: 1, gender: 'M', rank_code: 'WG_CDR' }],
    });
    const target = cands.find((c: any) => c.occupant_gender === 'M');
    const res = await sb.rpc('approve_eviction', {
      p_incoming: { category: 'MFA', check_in: d(0), check_out: d(2), party_size: 1, guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }] },
      p_evict_allocation_ids: [target.allocation_id],
      p_reason_enc: 'enc:official-duty-reason',
      p_key_version: 1,
      p_reason_aad_id: crypto.randomUUID(),
    });
    expect(res.error, res.error?.message).toBeNull();
    const { data: booking } = await (sb.from('bookings') as any).select('*, allocations(*)').eq('id', party.id).single();
    const stillActive = booking.allocations.filter((a: any) => a.status === 'ACTIVE').length;
    // Either the booking is still CONFIRMED (and can be cancelled to free the remaining bed),
    // or it is DISPLACED with no active beds. Never DISPLACED with a live bed nobody can release.
    if (stillActive > 0) expect(booking.status).toBe('CONFIRMED');
  });

  it('server refuses to evict a booking the incoming category may not displace', async () => {
    const mfa = await book({ category: 'MFA', checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP' });
    const { data: bookingRow } = await (sb.from('bookings') as any).select('*, allocations(*)').eq('id', mfa.id).single();
    const res = await sb.rpc('approve_eviction', {
      p_incoming: { category: 'LEAVE', check_in: d(0), check_out: d(2), party_size: 1, guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }] },
      p_evict_allocation_ids: [bookingRow.allocations[0].id],
      p_reason_enc: 'enc:official-duty-reason',
      p_key_version: 1,
      p_reason_aad_id: crypto.randomUUID(),
    });
    expect(res.error).not.toBeNull();
  });

  it('eviction without enough beds for the incoming party is rejected', async () => {
    await book({ category: 'LEAVE', checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP' });
    const { data: cands } = await sb.rpc('eviction_candidates', {
      p_category: 'MFA', p_check_in: d(0), p_check_out: d(2), p_guests: [],
    });
    const res = await sb.rpc('approve_eviction', {
      p_incoming: {
        category: 'MFA', check_in: d(0), check_out: d(2), party_size: 2,
        guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }, { seq: 2, gender: 'M', rank_code: 'FO' }],
      },
      p_evict_allocation_ids: [cands[0].allocation_id],
      p_reason_enc: 'enc:official-duty-reason',
      p_key_version: 1,
      p_reason_aad_id: crypto.randomUUID(),
    });
    expect(res.error?.message).toContain('ERR_NOT_ENOUGH_BEDS');
  });
});

describe('closures, concurrency, rules', () => {
  it('closed rooms are skipped by the engine and rejected by the server', async () => {
    const { error } = await (sb.from('room_closures') as any).insert({
      id: crypto.randomUUID(), room_id: roomIds['V-01'], period: `[${d(0)},${d(3)})`, reason_enc: 'enc',
    });
    expect(error).toBeNull();
    const r = await book({ checkIn: d(1), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP' });
    expect(r.placements[0].room).toBe('V-02');

    const forced = await sb.rpc('create_booking', {
      p_booking: { category: 'MFA', check_in: d(1), check_out: d(2), party_size: 1, is_suite_booking: false },
      p_guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }],
      p_allocations: [{ guest_seq: 1, room_id: roomIds['V-01'], bed_slot: 1 }],
    });
    expect(forced.error?.message).toContain('ERR_ROOM_CLOSED');
    // closure ending the day the guest arrives is fine ([from, to) is half-open)
    const edge = await book({ checkIn: d(3), checkOut: d(4), guests: [G('M', 'FO')], pref: 'VIP' });
    expect(edge.placements[0].room).toBe('V-01');
  });

  it('cannot close a room that still has active bookings in the period; cancelling unblocks it', async () => {
    const a = await book({ checkIn: d(1), checkOut: d(3), guests: [G('M', 'FO')], pref: 'VIP' });
    const closure = (from: number, to: number) =>
      (sb.from('room_closures') as any).insert({
        id: crypto.randomUUID(), room_id: roomIds['V-01'], period: `[${d(from)},${d(to)})`, reason_enc: 'enc',
      });
    const blocked = await closure(0, 5);
    expect(blocked.error?.message).toContain('ERR_ROOM_OCCUPIED');
    expect(userErrorMessage(blocked.error)).toMatch(/cancel or move/i);
    // a closure that ends the day the guest arrives doesn't overlap
    expect((await closure(0, 1)).error).toBeNull();
    await sb.rpc('cancel_booking', { p_id: a.id, p_reason_enc: 'enc', p_key_version: 1 });
    expect((await closure(1, 5)).error).toBeNull();
    // empty / inverted ranges are rejected
    expect((await closure(3, 3)).error?.message).toContain('ERR_INVALID_DATES');
  });

  it('a closure can be ended: removed if future, shortened if in progress', async () => {
    const mk = async (from: number, to: number, room: string) => {
      const id = crypto.randomUUID();
      const { error } = await (sb.from('room_closures') as any).insert({
        id, room_id: roomIds[room], period: `[${d(from)},${d(to)})`, reason_enc: 'enc',
      });
      expect(error).toBeNull();
      return id;
    };
    const future = await mk(2, 6, 'V-01');
    const running = await mk(-1, 5, 'V-02');
    expect((await sb.rpc('end_room_closure', { p_closure_id: future })).error).toBeNull();
    expect((await sb.rpc('end_room_closure', { p_closure_id: running })).error).toBeNull();
    const { data } = await sb.from('room_closures').select('*');
    expect(data).toHaveLength(1);
    expect(data[0].period).toBe(`[${d(-1)},${d(0)})`);
    // V-01 is bookable on the days the cancelled closure covered, V-02 from today
    const r = await book({ checkIn: d(0), checkOut: d(3), guests: [G('M', 'FO')], pref: 'VIP' });
    expect(r.placements[0].room).toBe('V-01');
    // clerks cannot end closures
    await signInAs('clerk');
    expect((await sb.rpc('end_room_closure', { p_closure_id: running })).error?.message).toContain('ERR_PERMISSION');
  });

  it('a stale plan loses the race cleanly with a friendly message (double booking)', async () => {
    const stale = await plan({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP' });
    await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP' }); // someone else gets V-01 bed 1
    if (stale.kind !== 'ALLOT') throw new Error('expected ALLOT');
    const res = await sb.rpc('create_booking', bookingPayload(
      { checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')] },
      stale.assignments,
    ));
    expect(res.error?.message).toContain('no_double_booking');
    expect(userErrorMessage(res.error)).toMatch(/just taken/i);
    // atomic: the failed booking left nothing behind
    const { data: all } = await sb.from('bookings').select('*');
    expect(all).toHaveLength(1);
  });

  it('manual placement that breaks the share rule is rejected atomically', async () => {
    const res = await sb.rpc('create_booking', {
      p_booking: { category: 'MFA', check_in: d(0), check_out: d(1), party_size: 2, is_suite_booking: false },
      p_guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }, { seq: 2, gender: 'F', rank_code: 'FO' }],
      p_allocations: [
        { guest_seq: 1, room_id: roomIds['N-01'], bed_slot: 1 },
        { guest_seq: 2, room_id: roomIds['N-01'], bed_slot: 2 },
      ],
    });
    expect(res.error?.message).toContain('ERR_SHARE_RULE');
    expect((await sb.from('bookings').select('*')).data).toHaveLength(0);
  });

  it('input validation: party mismatch, bad dates, bad party size, unknown category', async () => {
    const base = { category: 'MFA', check_in: d(0), check_out: d(1), party_size: 1, is_suite_booking: false };
    const g = [{ seq: 1, gender: 'M', rank_code: 'FO' }];
    const a = [{ guest_seq: 1, room_id: roomIds['N-01'], bed_slot: 1 }];
    expect((await sb.rpc('create_booking', { p_booking: { ...base, party_size: 2 }, p_guests: g, p_allocations: a })).error?.message).toContain('ERR_PARTY_MISMATCH');
    expect((await sb.rpc('create_booking', { p_booking: { ...base, check_out: d(0) }, p_guests: g, p_allocations: a })).error?.message).toContain('ERR_INVALID_DATES');
    expect((await sb.rpc('create_booking', { p_booking: { ...base, check_out: d(-1) }, p_guests: g, p_allocations: a })).error?.message).toContain('ERR_INVALID_DATES');
    expect((await sb.rpc('create_booking', { p_booking: { ...base, category: 'VIP' }, p_guests: g, p_allocations: a })).error).not.toBeNull();
    expect((await sb.rpc('create_booking', { p_booking: { ...base, party_size: 0 }, p_guests: [], p_allocations: [] })).error).not.toBeNull();
  });

  it('cancelling frees the beds for a new booking and a second cancel is rejected without touching anything', async () => {
    const a = await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP' });
    expect((await sb.rpc('cancel_booking', { p_id: a.id, p_reason_enc: 'enc', p_key_version: 1 })).error).toBeNull();
    const b = await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP' });
    expect(b.placements[0].room).toBe('V-01');
    expect((await sb.rpc('cancel_booking', { p_id: a.id, p_reason_enc: 'enc', p_key_version: 1 })).error?.message).toContain('ERR_BOOKING_NOT_ACTIVE');
    expect((await sb.rpc('cancel_booking', { p_id: crypto.randomUUID(), p_reason_enc: 'enc', p_key_version: 1 })).error?.message).toContain('ERR_NOT_FOUND');
    // the second booking is untouched
    const { data } = await sb.from('bookings').select('*').eq('id', b.id).single();
    expect(data.status).toBe('CONFIRMED');
  });
});

describe('roles and suites', () => {
  it('manage_rooms covers normal rooms and closures but never suites (0019)', async () => {
    // admin is signed in from beforeEach: grant the clerk room management
    const grant = await sb.rpc('set_user_permissions', {
      p_user_id: DEV_USERS.clerk.id,
      p_permissions: ['create_booking', 'manage_rooms'],
    });
    expect(grant.error).toBeNull();
    const { data: suiteClosure } = await (sb.from('room_closures') as any)
      .insert({ room_id: roomIds['SU-01'], period: `[${d(30)},${d(32)})` })
      .select()
      .single();

    await signInAs('clerk');
    const normal = await (sb.from('rooms') as any).insert({ room_type: 'NORMAL', name_enc: 'enc:N-09', display_order: 20 });
    expect(normal.error).toBeNull();
    const suite = await (sb.from('rooms') as any).insert({ room_type: 'SUITE', name_enc: 'enc:SUITE-09', display_order: 21 });
    expect(suite.error?.message).toContain('row-level security');
    expect(userErrorMessage(suite.error)).toMatch(/Administrator/);

    const closeNormal = await (sb.from('room_closures') as any).insert({ room_id: roomIds['N-01'], period: `[${d(30)},${d(31)})` });
    expect(closeNormal.error).toBeNull();
    const closeSuite = await (sb.from('room_closures') as any).insert({ room_id: roomIds['SU-01'], period: `[${d(40)},${d(41)})` });
    expect(closeSuite.error?.message).toContain('row-level security');

    const { data: visible } = await sb.from('room_closures').select('*');
    expect((visible as any[]).some((c) => c.room_id === roomIds['SU-01'])).toBe(false);
    const end = await sb.rpc('end_room_closure', { p_closure_id: suiteClosure.id });
    expect(end.error?.message).toContain('ERR_SUITE_ONLY_ADMIN');
  });

  it('clerk cannot backdate; admin can', async () => {
    await signInAs('clerk');
    const res = await sb.rpc('create_booking', {
      p_booking: { category: 'MFA', check_in: d(-3), check_out: d(-1), party_size: 1, is_suite_booking: false },
      p_guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }],
      p_allocations: [{ guest_seq: 1, room_id: roomIds['N-01'], bed_slot: 1 }],
    });
    expect(res.error?.message).toContain('backdate');
    expect(userErrorMessage(res.error)).toMatch(/Administrator/);
    await signInAs('admin');
    const ok = await sb.rpc('create_booking', {
      p_booking: { category: 'MFA', check_in: d(-3), check_out: d(-1), party_size: 1, is_suite_booking: false },
      p_guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }],
      p_allocations: [{ guest_seq: 1, room_id: roomIds['N-01'], bed_slot: 1 }],
    });
    expect(ok.error).toBeNull();
  });

  it('suite booking: admin only, invisible to clerks, never in clerk room state', async () => {
    await signInAs('clerk');
    const denied = await sb.rpc('create_booking', {
      p_booking: { category: 'MFA', check_in: d(0), check_out: d(2), party_size: 1, is_suite_booking: true },
      p_guests: [{ seq: 1, gender: 'M', rank_code: 'AM' }],
      p_allocations: [{ guest_seq: 1, room_id: roomIds['SU-01'], bed_slot: 1 }],
    });
    expect(denied.error?.message).toContain('ERR_SUITE_ONLY_ADMIN');

    await signInAs('admin');
    const ok = await sb.rpc('create_booking', {
      p_booking: { category: 'MFA', check_in: d(0), check_out: d(2), party_size: 1, is_suite_booking: true },
      p_guests: [{ seq: 1, gender: 'M', rank_code: 'AM' }],
      p_allocations: [{ guest_seq: 1, room_id: roomIds['SU-01'], bed_slot: 1 }],
    });
    expect(ok.error).toBeNull();
    // non-suite booking into the suite room is also refused
    const wrong = await sb.rpc('create_booking', {
      p_booking: { category: 'MFA', check_in: d(5), check_out: d(6), party_size: 1, is_suite_booking: false },
      p_guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }],
      p_allocations: [{ guest_seq: 1, room_id: roomIds['SU-01'], bed_slot: 1 }],
    });
    expect(wrong.error?.message).toContain('ERR_SUITE_ONLY_ADMIN');

    expect((await rooms(d(0), d(1))).some((r) => r.room_type === 'SUITE')).toBe(true);
    await signInAs('clerk');
    expect((await rooms(d(0), d(1))).some((r) => r.room_type === 'SUITE')).toBe(false);
    expect((await sb.from('bookings').select('*')).data).toHaveLength(0);
    expect((await sb.from('rooms').select('*')).data).toHaveLength(9);
  });

  it('clerk permissions: no cancel, no PII reveal, no eviction, no room management', async () => {
    const a = await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP' });
    await signInAs('clerk');
    expect((await sb.rpc('cancel_booking', { p_id: a.id, p_reason_enc: 'x', p_key_version: 1 })).error?.message).toContain('ERR_PERMISSION');
    expect((await sb.rpc('get_guest_pii', { p_guest_id: crypto.randomUUID() })).error?.message).toContain('ERR_PERMISSION');
    expect((await sb.rpc('approve_eviction', {
      p_incoming: {}, p_evict_allocation_ids: [], p_reason_enc: 'enc:long-enough-reason', p_key_version: 1, p_reason_aad_id: crypto.randomUUID(),
    })).error?.message).toContain('ERR_PERMISSION');
    const addRoomRes = await (sb.from('rooms') as any).insert({ room_type: 'NORMAL', name_enc: 'x' });
    expect(addRoomRes.error).not.toBeNull();
    expect((await sb.rpc('report_daily', { p_from: d(0), p_to: d(1) })).error).toBeNull(); // view_reports is a default clerk permission
  });

  it('guest PII round trip, blind-index search, and per-guest completion status', async () => {
    const a = await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO'), G('M', 'FO')], pref: 'VIP' });
    const { data: guests } = await sb.from('booking_guests').select('*').eq('booking_id', a.id).order('seq');
    expect(guests.map((g: any) => g.details)).toEqual(['PENDING', 'PENDING']);
    await sb.rpc('set_guest_pii', { p_guest_id: guests[0].id, p_pii_enc: 'cipher-1', p_blind: 'blind-A', p_key_version: 1 });
    const { data: after } = await sb.from('booking_guests').select('*').eq('booking_id', a.id).order('seq');
    expect(after.map((g: any) => g.details)).toEqual(['COMPLETE', 'PENDING']);
    expect((await sb.rpc('get_guest_pii', { p_guest_id: guests[0].id })).data).toBe('cipher-1');
    expect((await sb.rpc('search_guests_by_blind_index', { p_blind: 'blind-A' })).data).toEqual([{ booking_id: a.id }]);
    expect((await sb.rpc('search_guests_by_blind_index', { p_blind: 'nope' })).data).toEqual([]);
    // guest_pii has no SELECT path for anyone
    expect((await sb.from('guest_pii').select('*')).error).not.toBeNull();
  });

  it('reports count people per day, category and room type; dashboard counts add up', async () => {
    await book({ category: 'MFA', checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO'), G('M', 'FO')], pref: 'VIP' });
    await book({ category: 'LEAVE', checkIn: d(1), checkOut: d(2), guests: [G('F', 'FO')], pref: 'NORMAL' });
    const { data: rep } = await sb.rpc('report_daily', { p_from: d(0), p_to: d(2) });
    const total = rep.reduce((n: number, r: any) => n + r.people, 0);
    expect(total).toBe(2 + 3); // day0: 2, day1: 3
    const { data: c } = await sb.rpc('dashboard_counts', { p_date: d(1) });
    expect(c[0]).toMatchObject({ full_rooms: 1, one_bed_free_rooms: 1, free_rooms: 7, people_in_house: 3 });
  });

  it('cannot demote or deactivate the last administrator', async () => {
    expect((await sb.rpc('set_user_role', { p_user_id: DEV_USERS.admin.id, p_role: 'clerk' })).error?.message).toContain('ERR_LAST_ADMIN');
    expect((await sb.rpc('deactivate_user', { p_user_id: DEV_USERS.admin.id })).error?.message).toContain('ERR_LAST_ADMIN');
  });

  describe('room deletion and booking date modification', () => {
    it('delete_room: soft deletes room and removes it from inventory, but blocks rooms with active bookings', async () => {
      await signInAs('admin');
      // Create a temporary room
      const tempId = crypto.randomUUID();
      await (sb.from('rooms') as any).insert({
        id: tempId,
        room_type: 'NORMAL',
        name_enc: 'enc:TEMP-ROOM',
        display_order: 99,
      });

      const beforeList = (await sb.from('rooms').select('*')).data;
      expect(beforeList.some((r: any) => r.id === tempId)).toBe(true);

      // Book into the room
      const bookRes = await sb.rpc('create_booking', {
        p_booking: { category: 'MFA', check_in: d(0), check_out: d(3), party_size: 1, is_suite_booking: false },
        p_guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }],
        p_allocations: [{ guest_seq: 1, room_id: tempId, bed_slot: 1 }],
      });
      expect(bookRes.error).toBeNull();

      // Deleting room with active booking must fail
      const failDel = await sb.rpc('delete_room', { p_room_id: tempId });
      expect(failDel.error?.message).toContain('ERR_ROOM_HAS_ACTIVE_BOOKINGS');

      // Cancel the booking to free the room
      const bId = bookRes.data as string;
      await sb.rpc('cancel_booking', { p_id: bId, p_reason_enc: 'enc:cancelled', p_key_version: 1 });

      // Now deleting the room should succeed
      const okDel = await sb.rpc('delete_room', { p_room_id: tempId });
      expect(okDel.error).toBeNull();

      // Room should no longer be visible in rooms query
      const afterList = (await sb.from('rooms').select('*')).data;
      expect(afterList.some((r: any) => r.id === tempId)).toBe(false);

      // Unprivileged clerk cannot delete rooms
      await signInAs('clerk');
      expect((await sb.rpc('delete_room', { p_room_id: roomIds['V-01'] })).error?.message).toContain('ERR_PERMISSION');

      // Grant manage_rooms to clerk
      await signInAs('admin');
      await sb.rpc('set_user_permissions', {
        p_user_id: DEV_USERS.clerk.id,
        p_permissions: ['create_booking', 'manage_rooms'],
      });

      // Privileged clerk cannot delete suite room
      await signInAs('clerk');
      const suiteDel = await sb.rpc('delete_room', { p_room_id: roomIds['SU-01'] });
      expect(suiteDel.error?.message).toContain('ERR_SUITE_ONLY_ADMIN');
    });

    it('update_booking_dates: guest leaves early, releasing inventory', async () => {
      await signInAs('admin');
      const b = await book({ category: 'MFA', checkIn: d(0), checkOut: d(5), guests: [G('M', 'FO')], pref: 'NORMAL' });

      // Check daily room state before early departure: day 4 is occupied
      const { data: stBefore } = await sb.rpc('daily_room_state', { p_from: d(4), p_to: d(5) });
      const bAlloc = (await sb.from('allocations').select('*').eq('booking_id', b.id).single()).data;
      const day4Room = (stBefore as any[]).find((r) => r.room_id === bAlloc.room_id);
      expect(day4Room.beds_taken).toBe(1);

      // Guest leaves early on day 2 instead of day 5
      const res = await sb.rpc('update_booking_dates', {
        p_booking_id: b.id,
        p_new_check_in: d(0),
        p_new_check_out: d(2),
      });
      expect(res.error).toBeNull();

      // Verify booking and allocation dates updated
      const updatedBooking = (await sb.from('bookings').select('*').eq('id', b.id).single()).data;
      expect(updatedBooking.check_out).toBe(d(2));

      const updatedAlloc = (await sb.from('allocations').select('*').eq('booking_id', b.id).single()).data;
      expect(updatedAlloc.stay).toBe(`[${d(0)},${d(2)})`);

      // Inventory on day 4 is now free!
      const { data: stAfter } = await sb.rpc('daily_room_state', { p_from: d(4), p_to: d(5) });
      const day4RoomAfter = (stAfter as any[]).find((r) => r.room_id === bAlloc.room_id);
      expect(day4RoomAfter.beds_taken).toBe(0);
    });

    it('update_booking_dates: stay extension succeeds when free, fails on conflicting booking or closure', async () => {
      await signInAs('admin');
      // Booking 1 in Room V-01 days 0 to 2
      const b1 = await sb.rpc('create_booking', {
        p_booking: { category: 'MFA', check_in: d(0), check_out: d(2), party_size: 1, is_suite_booking: false },
        p_guests: [{ seq: 1, gender: 'M', rank_code: 'WG_CDR' }],
        p_allocations: [{ guest_seq: 1, room_id: roomIds['V-01'], bed_slot: 1 }],
      });
      expect(b1.error).toBeNull();

      // Booking 2 in Room V-01 Bed 1 days 4 to 6
      const b2 = await sb.rpc('create_booking', {
        p_booking: { category: 'MFA', check_in: d(4), check_out: d(6), party_size: 1, is_suite_booking: false },
        p_guests: [{ seq: 1, gender: 'M', rank_code: 'WG_CDR' }],
        p_allocations: [{ guest_seq: 1, room_id: roomIds['V-01'], bed_slot: 1 }],
      });
      expect(b2.error).toBeNull();

      // Extending b1 from d(2) to d(3) succeeds (bed 1 is free on day 2)
      const extOk = await sb.rpc('update_booking_dates', {
        p_booking_id: b1.data,
        p_new_check_in: d(0),
        p_new_check_out: d(3),
      });
      expect(extOk.error).toBeNull();

      // Extending b1 to d(5) overlaps with b2 on day 4 -> fails with double booking
      const extFail = await sb.rpc('update_booking_dates', {
        p_booking_id: b1.data,
        p_new_check_in: d(0),
        p_new_check_out: d(5),
      });
      expect(extFail.error?.message).toContain('no_double_booking');

      // Put V-01 out of service on day 3
      await (sb.from('room_closures') as any).insert({
        room_id: roomIds['V-01'],
        period: `[${d(3)},${d(4)})`,
        reason_enc: 'enc:repair',
      });

      // Extending b1 to d(4) overlaps closure -> fails with ERR_ROOM_CLOSED
      const extClosure = await sb.rpc('update_booking_dates', {
        p_booking_id: b1.data,
        p_new_check_in: d(0),
        p_new_check_out: d(4),
      });
      expect(extClosure.error?.message).toContain('ERR_ROOM_CLOSED');
    });
  });

  describe('multi-guest booking requests and allotment suggestions', () => {
    it('creates a multi-guest booking request with status PENDING_ALLOTMENT and no allocations', async () => {
      await signInAs('clerk');
      const guests = [
        { seq: 1, gender: 'M' as Gender, rank_code: 'WG_CDR' as RankCode },
        { seq: 2, gender: 'M' as Gender, rank_code: 'WG_CDR' as RankCode },
        { seq: 3, gender: 'F' as Gender, rank_code: 'SQN_LDR' as RankCode },
      ];

      const res = await sb.rpc('create_booking_request', {
        p_booking: {
          category: 'MFA',
          check_in: d(1),
          check_out: d(4),
          party_size: 3,
        },
        p_guests: guests,
      });

      expect(res.error).toBeNull();
      const bookingId = res.data as string;

      // Verify booking record
      const bRow = (await sb.from('bookings').select('*').eq('id', bookingId).single()).data;
      expect(bRow.status).toBe('PENDING_ALLOTMENT');
      expect(bRow.party_size).toBe(3);

      // Verify guests exist
      const gRows = (await sb.from('booking_guests').select('*').eq('booking_id', bookingId)).data;
      expect(gRows.length).toBe(3);

      // Verify allocations do NOT exist yet
      const aRows = (await sb.from('allocations').select('*').eq('booking_id', bookingId)).data;
      expect(aRows.length).toBe(0);

      // Room states remain 0 beds taken for those dates
      const { data: st } = await sb.rpc('daily_room_state', { p_from: d(1), p_to: d(4) });
      const taken = (st as any[]).reduce((sum, r) => sum + r.beds_taken, 0);
      expect(taken).toBe(0);
    });

    it('computes allotment suggestions for pending request and allots rooms to confirm booking', async () => {
      await signInAs('clerk');
      const guests = [
        { seq: 1, gender: 'M' as const, rank_code: 'WG_CDR' as const },
        { seq: 2, gender: 'M' as const, rank_code: 'WG_CDR' as const },
        { seq: 3, gender: 'F' as const, rank_code: 'SQN_LDR' as const },
      ];

      // 1. Create booking request
      const createRes = await sb.rpc('create_booking_request', {
        p_booking: {
          category: 'PI',
          check_in: d(2),
          check_out: d(5),
          party_size: 3,
        },
        p_guests: guests,
      });
      expect(createRes.error).toBeNull();
      const bookingId = createRes.data as string;

      // 2. Fetch daily room states and compute suggestions via planAllotment
      const { data: rawStates } = await sb.rpc('daily_room_state', { p_from: d(2), p_to: d(5) });
      const roomStates = (rawStates as any[]).map(mapRoomDayState);
      const planResult = planAllotment(
        {
          category: 'PI',
          checkIn: d(2),
          checkOut: d(5),
          guests: guests.map((g) => ({ gender: g.gender, rankCode: g.rank_code })),
        },
        roomStates,
      );

      expect(planResult.kind).toBe('ALLOT');
      if (planResult.kind !== 'ALLOT') throw new Error('expected kind ALLOT');

      // The 2 WG_CDR Male guests must be paired into the same room
      const g1 = planResult.assignments.find((a) => a.guestIndex === 0)!;
      const g2 = planResult.assignments.find((a) => a.guestIndex === 1)!;
      const g3 = planResult.assignments.find((a) => a.guestIndex === 2)!;

      expect(g1.roomId).toBe(g2.roomId);
      expect(g1.bedSlot).not.toBe(g2.bedSlot);
      expect(g3.roomId).not.toBe(g1.roomId);

      // 3. Confirm allotment using allot_booking_rooms
      const allotRes = await sb.rpc('allot_booking_rooms', {
        p_booking_id: bookingId,
        p_allocations: planResult.assignments.map((a) => ({
          guest_seq: a.guestIndex + 1,
          room_id: a.roomId,
          bed_slot: a.bedSlot,
        })),
      });
      expect(allotRes.error).toBeNull();

      // 4. Verify booking is now CONFIRMED
      const bRow = (await sb.from('bookings').select('*').eq('id', bookingId).single()).data;
      expect(bRow.status).toBe('CONFIRMED');

      // 5. Verify active allocations are in place
      const aRows = (await sb.from('allocations').select('*').eq('booking_id', bookingId)).data;
      expect(aRows.length).toBe(3);
      expect(aRows.every((a: any) => a.status === 'ACTIVE')).toBe(true);

      // 6. Cannot allot again once already confirmed
      const allotAgain = await sb.rpc('allot_booking_rooms', {
        p_booking_id: bookingId,
        p_allocations: planResult.assignments.map((a) => ({
          guest_seq: a.guestIndex + 1,
          room_id: a.roomId,
          bed_slot: a.bedSlot,
        })),
      });
      expect(allotAgain.error?.message).toContain('ERR_BOOKING_NOT_PENDING');
    });

    it('allows updating stay dates on a pending booking request before room allotment', async () => {
      await signInAs('clerk');
      const createRes = await sb.rpc('create_booking_request', {
        p_booking: {
          category: 'LEAVE',
          check_in: d(2),
          check_out: d(5),
          party_size: 2,
        },
        p_guests: [
          { seq: 1, gender: 'M' as const, rank_code: 'FLT_LT' as const },
          { seq: 2, gender: 'M' as const, rank_code: 'FLT_LT' as const },
        ],
      });
      const bookingId = createRes.data as string;

      // Update dates to d(3) -> d(7)
      const updateRes = await sb.rpc('update_booking_dates', {
        p_booking_id: bookingId,
        p_new_check_in: d(3),
        p_new_check_out: d(7),
      });
      expect(updateRes.error).toBeNull();

      const bRow = (await sb.from('bookings').select('*').eq('id', bookingId).single()).data;
      expect(bRow.check_in).toBe(d(3));
      expect(bRow.check_out).toBe(d(7));
      expect(bRow.status).toBe('PENDING_ALLOTMENT');
    });
  });

  describe('unique guest IDs, universal search, and occupancy grid daily room state', () => {
    it('assigns unique human-readable GST-XXXX guest code to every guest', async () => {
      await signInAs('clerk');
      const createRes = await sb.rpc('create_booking_request', {
        p_booking: {
          category: 'MFA',
          check_in: d(1),
          check_out: d(3),
          party_size: 2,
        },
        p_guests: [
          { seq: 1, gender: 'M' as const, rank_code: 'WG_CDR' as const },
          { seq: 2, gender: 'F' as const, rank_code: 'SQN_LDR' as const },
        ],
      });
      const bookingId = createRes.data as string;

      const guestsRes = await sb
        .from('booking_guests')
        .select('*')
        .eq('booking_id', bookingId)
        .order('seq', { ascending: true });

      expect(guestsRes.error).toBeNull();
      expect(guestsRes.data).toHaveLength(2);
      expect(guestsRes.data![0].guest_code).toMatch(/^GST-\d{4}$/);
      expect(guestsRes.data![1].guest_code).toMatch(/^GST-\d{4}$/);
      expect(guestsRes.data![0].guest_code).not.toEqual(guestsRes.data![1].guest_code);
    });

    it('allows guest PII without Aadhaar / Passport and enables universal search', async () => {
      await signInAs('clerk');
      const createRes = await sb.rpc('create_booking_request', {
        p_booking: {
          category: 'LEAVE',
          check_in: d(2),
          check_out: d(4),
          party_size: 1,
        },
        p_guests: [{ seq: 1, gender: 'M' as const, rank_code: 'GP_CAPT' as const }],
      });
      const bookingId = createRes.data as string;
      const guests = (await sb.from('booking_guests').select('*').eq('booking_id', bookingId)).data!;
      const guestId = guests[0].id;
      const guestCode = guests[0].guest_code;

      // Enter guest PII with NO blind index (Aadhaar/passport omitted)
      const piiRes = await sb.rpc('set_guest_pii', {
        p_guest_id: guestId,
        p_pii_enc: 'dummy-enc-pii',
        p_blind: null,
        p_key_version: 1,
      });
      expect(piiRes.error).toBeNull();

      // Details should now be COMPLETE
      const updatedGuest = (await sb.from('booking_guests').select('*').eq('id', guestId).single()).data;
      expect(updatedGuest.details).toBe('COMPLETE');

      // Search by unique guest code
      const searchByCode = await sb.rpc('search_bookings_and_guests', { p_query: guestCode });
      expect(searchByCode.error).toBeNull();
      expect(searchByCode.data?.map((r: any) => r.booking_id)).toContain(bookingId);

      // Search by rank code
      const searchByRank = await sb.rpc('search_bookings_and_guests', { p_query: 'GP_CAPT' });
      expect(searchByRank.error).toBeNull();
      expect(searchByRank.data?.map((r: any) => r.booking_id)).toContain(bookingId);

      // Search by category
      const searchByCategory = await sb.rpc('search_bookings_and_guests', { p_query: 'LEAVE' });
      expect(searchByCategory.error).toBeNull();
      expect(searchByCategory.data?.map((r: any) => r.booking_id)).toContain(bookingId);
    });

    it('populates guestCode in daily_room_state for grid view occupancy matrix', async () => {
      await signInAs('clerk');
      const bRes = await book({
        category: 'MFA',
        checkIn: d(1),
        checkOut: d(3),
        guests: [G('M', 'WG_CDR')],
      });
      expect(bRes.id).toBeDefined();

      const roomStateRes = await sb.rpc('daily_room_state', {
        p_from: d(1),
        p_to: d(2),
      });
      expect(roomStateRes.error).toBeNull();

      const day1 = (roomStateRes.data || []).find((r: any) => r.beds_taken > 0);
      expect(day1).toBeDefined();
      expect(day1.occupants).toHaveLength(1);
      expect(day1.occupants[0].guestCode).toMatch(/^GST-\d{4}$/);
      expect(day1.occupants[0].category).toBe('MFA');
      expect(day1.occupants[0].rankCode).toBe('WG_CDR');
    });

    it('generates past bookings HTML report with military mess register headers and counts', () => {
      const html = buildPastBookingsHtml({
        title: "OFFICERS' MESS - PAST BOOKINGS REGISTER",
        bookings: [
          {
            id: 'bkg-101-alpha',
            category: 'MFA',
            checkIn: '2026-10-01',
            checkOut: '2026-10-04',
            nights: 3,
            partySize: 1,
            status: 'COMPLETED',
            guestName: 'Air Marshal S. Mukherjee',
            guestRank: 'AM',
            serviceNumber: '10023-F',
            unit: 'Air HQ (VB)',
            rooms: 'VIP Suite 1 (Bed 1)',
          },
          {
            id: 'bkg-102-beta',
            category: 'LEAVE',
            checkIn: '2026-10-05',
            checkOut: '2026-10-08',
            nights: 3,
            partySize: 2,
            status: 'COMPLETED',
            guestName: 'Wing Commander R. Nair',
            guestRank: 'WG_CDR',
            serviceNumber: '24567-K',
            unit: '12 Wing',
            rooms: 'Room V-01 (Bed 1), Room V-01 (Bed 2)',
          },
        ],
      });

      expect(html).toContain('OFFICERS&#39; MESS - PAST BOOKINGS REGISTER');
      expect(html).toContain('Air Marshal S. Mukherjee');
      expect(html).toContain('10023-F');
      expect(html).toContain('Wing Commander R. Nair');
      expect(html).toContain('badge-mfa');
      expect(html).toContain('badge-leave');
      expect(html).toContain('Total Past Stays');
      expect(html).toContain('Total Nights Hosted');
    });

    it('wizard multi-guest request creation with optional fields and subsequent allotment', async () => {
      await signInAs('clerk');
      // Create a pending request with 2 guests (none of the fields mandatory)
      const reqRes = await sb.rpc('create_booking_request', {
        p_booking: {
          category: 'MFA',
          check_in: d(2),
          check_out: d(5),
          party_size: 2,
          is_suite_booking: false,
        },
        p_guests: [
          { seq: 1, gender: 'M', rank_code: 'WG_CDR', guest_name: 'Wing Commander K. Sharma' },
          { seq: 2, gender: 'M', rank_code: 'WG_CDR', guest_name: 'Squadron Leader M. Patel' },
        ],
      });
      expect(reqRes.error).toBeNull();
      const bookingId = reqRes.data;

      // Check request is stored in PENDING_ALLOTMENT status
      const bRecord = (await sb.from('bookings').select('*').eq('id', bookingId).single()).data;
      expect(bRecord.status).toBe('PENDING_ALLOTMENT');

      // Check both guests have unique GST-XXXX codes and names preserved
      const guests = (await sb.from('booking_guests').select('*').eq('booking_id', bookingId).order('seq')).data;
      expect(guests).toHaveLength(2);
      expect(guests[0].guest_code).toMatch(/^GST-\d{4}$/);
      expect(guests[1].guest_code).toMatch(/^GST-\d{4}$/);
      expect(guests[0].guest_name).toBe('Wing Commander K. Sharma');
      expect(guests[1].guest_name).toBe('Squadron Leader M. Patel');

      // Perform allotment from requests queue
      const allotRes = await sb.rpc('allot_booking_rooms', {
        p_booking_id: bookingId,
        p_allocations: [
          { guest_id: guests[0].id, room_id: roomIds['V-01'], bed_slot: 1 },
          { guest_id: guests[1].id, room_id: roomIds['V-01'], bed_slot: 2 },
        ],
      });
      expect(allotRes.error).toBeNull();

      // Booking status is now CONFIRMED
      const confirmed = (await sb.from('bookings').select('*').eq('id', bookingId).single()).data;
      expect(confirmed.status).toBe('CONFIRMED');

      // Allocations are ACTIVE in Room V-01
      const allocs = (await sb.from('allocations').select('*').eq('booking_id', bookingId)).data;
      expect(allocs).toHaveLength(2);
      expect(allocs.every((a: any) => a.status === 'ACTIVE')).toBe(true);
    });

    it('individual bookings creation, universal search by unit/service number/phone, and preferred room type filter', async () => {
      await signInAs('clerk');

      // 1. Create individual booking request with unit, service_number, phone, and preferred_room_type
      const req1 = await sb.rpc('create_booking_request', {
        p_booking: {
          category: 'TD',
          check_in: d(3),
          check_out: d(6),
          party_size: 1,
          is_suite_booking: false,
          preferred_room_type: 'VIP',
        },
        p_guests: [
          {
            seq: 1,
            gender: 'M',
            rank_code: 'COL',
            guest_name: 'Col Vikram Batra',
            unit: '13 JAK RIF',
            service_number: 'IC-52140M',
            phone: '+91 9876543210',
          },
        ],
      });
      expect(req1.error).toBeNull();
      const bkgId1 = req1.data;

      // 2. Create another individual booking request
      const req2 = await sb.rpc('create_booking_request', {
        p_booking: {
          category: 'LEAVE',
          check_in: d(3),
          check_out: d(6),
          party_size: 1,
          is_suite_booking: false,
          preferred_room_type: 'NORMAL',
        },
        p_guests: [
          {
            seq: 1,
            gender: 'M',
            rank_code: 'MAJ',
            guest_name: 'Maj Somnath Sharma',
            unit: '4 KUMAON',
            service_number: 'IC-00123A',
            phone: '+91 9123456780',
          },
        ],
      });
      expect(req2.error).toBeNull();
      const bkgId2 = req2.data;

      // Verify individual records in ledger / bookings
      const b1 = (await sb.from('bookings').select('*').eq('id', bkgId1).single()).data;
      expect(b1.party_size).toBe(1);
      expect(b1.preferred_room_type).toBe('VIP');

      const b2 = (await sb.from('bookings').select('*').eq('id', bkgId2).single()).data;
      expect(b2.party_size).toBe(1);
      expect(b2.preferred_room_type).toBe('NORMAL');

      // 3. Test Universal Search by Name
      const searchByName = await sb.rpc('search_bookings_and_guests', { p_query: 'Vikram Batra' });
      expect(searchByName.data?.some((r: any) => r.booking_id === bkgId1)).toBe(true);

      // 4. Test Universal Search by Unit
      const searchByUnit = await sb.rpc('search_bookings_and_guests', { p_query: 'JAK RIF' });
      expect(searchByUnit.data?.some((r: any) => r.booking_id === bkgId1)).toBe(true);

      // 5. Test Universal Search by Service Number
      const searchByServiceNo = await sb.rpc('search_bookings_and_guests', { p_query: 'IC-00123A' });
      expect(searchByServiceNo.data?.some((r: any) => r.booking_id === bkgId2)).toBe(true);

      // 6. Test Universal Search by Phone Number
      const searchByPhone = await sb.rpc('search_bookings_and_guests', { p_query: '9876543210' });
      expect(searchByPhone.data?.some((r: any) => r.booking_id === bkgId1)).toBe(true);

      // 7. Verify booking guests store unit, service_number, and phone
      const g1 = (await sb.from('booking_guests').select('*').eq('booking_id', bkgId1).single()).data;
      expect(g1.unit).toBe('13 JAK RIF');
      expect(g1.service_number).toBe('IC-52140M');
      expect(g1.phone).toBe('+91 9876543210');
    });

    it('multi-guest requests without initial room type selection, distinct room allotment, and real-time daily_room_state reflection', async () => {
      await signInAs('clerk');

      // 1. Create 2 individual booking requests without initial room type selection (preferred_room_type = null)
      const bkgRes1 = await sb.rpc('create_booking_request', {
        p_booking: {
          category: 'MFA',
          check_in: d(10),
          check_out: d(12),
          party_size: 1,
          is_suite_booking: false,
          preferred_room_type: null,
        },
        p_guests: [
          { seq: 1, gender: 'M', rank_code: 'WG_CDR', guest_name: 'Wing Commander Abhinandan' },
        ],
      });
      expect(bkgRes1.error).toBeNull();
      const bkgId1 = bkgRes1.data;

      const bkgRes2 = await sb.rpc('create_booking_request', {
        p_booking: {
          category: 'MFA',
          check_in: d(10),
          check_out: d(12),
          party_size: 1,
          is_suite_booking: false,
          preferred_room_type: null,
        },
        p_guests: [
          { seq: 1, gender: 'M', rank_code: 'WG_CDR', guest_name: 'Wing Commander R. Sharma' },
        ],
      });
      expect(bkgRes2.error).toBeNull();
      const bkgId2 = bkgRes2.data;

      // 2. Allot both guests to distinct beds in Room V-01 (Bed 1 and Bed 2)
      const allot1 = await sb.rpc('allot_booking_rooms', {
        p_booking_id: bkgId1,
        p_allocations: [
          { guest_seq: 1, room_id: roomIds['V-01'], bed_slot: 1 },
        ],
      });
      expect(allot1.error).toBeNull();

      const allot2 = await sb.rpc('allot_booking_rooms', {
        p_booking_id: bkgId2,
        p_allocations: [
          { guest_seq: 1, room_id: roomIds['V-01'], bed_slot: 2 },
        ],
      });
      expect(allot2.error).toBeNull();

      // 3. Verify both bookings transitioned to CONFIRMED
      const b1 = (await sb.from('bookings').select('*').eq('id', bkgId1).single()).data;
      const b2 = (await sb.from('bookings').select('*').eq('id', bkgId2).single()).data;
      expect(b1.status).toBe('CONFIRMED');
      expect(b2.status).toBe('CONFIRMED');

      // 4. Verify daily_room_state reflects Room V-01 as FULL (both beds taken)
      const stateRes = await sb.rpc('daily_room_state', {
        p_from: d(10),
        p_to: d(12),
      });
      expect(stateRes.error).toBeNull();

      const v01Day10 = (stateRes.data || []).find(
        (r: any) => r.room_id === roomIds['V-01'] && r.date === d(10)
      );
      expect(v01Day10).toBeDefined();
      expect(v01Day10.beds_taken).toBe(2);
      expect(v01Day10.occupants).toHaveLength(2);

      // 5. Attempting to allot a 3rd guest to Room V-01 for the same period must fail (room is full)
      const bkgRes3 = await sb.rpc('create_booking_request', {
        p_booking: {
          category: 'MFA',
          check_in: d(10),
          check_out: d(12),
          party_size: 1,
          is_suite_booking: false,
        },
        p_guests: [
          { seq: 1, gender: 'M', rank_code: 'WG_CDR', guest_name: 'Wing Commander 3' },
        ],
      });
      const bkgId3 = bkgRes3.data;

      const allot3 = await sb.rpc('allot_booking_rooms', {
        p_booking_id: bkgId3,
        p_allocations: [
          { guest_seq: 1, room_id: roomIds['V-01'], bed_slot: 1 },
        ],
      });
      expect(allot3.error).not.toBeNull();
      expect(allot3.error?.message).toContain('no_double_booking');
    });

    it('single request intake wizard flow, strict exclusion of booked rooms from availability, and successful allotment', async () => {
      await signInAs('clerk');

      // 1. Fully book Room V-02 for dates d(15) -> d(18)
      const bkg1 = await sb.rpc('create_booking', {
        p_booking: {
          category: 'MFA',
          check_in: d(15),
          check_out: d(18),
          party_size: 2,
          is_suite_booking: false,
        },
        p_guests: [
          { seq: 1, gender: 'M', rank_code: 'WG_CDR', guest_name: 'Occupant One' },
          { seq: 2, gender: 'M', rank_code: 'WG_CDR', guest_name: 'Occupant Two' },
        ],
        p_allocations: [
          { guest_seq: 1, room_id: roomIds['V-02'], bed_slot: 1, check_in: d(15), check_out: d(18) },
          { guest_seq: 2, room_id: roomIds['V-02'], bed_slot: 2, check_in: d(15), check_out: d(18) },
        ],
      });
      expect(bkg1.error).toBeNull();

      // 2. Create a pending booking request for a new guest via the single-guest wizard
      const reqRes = await sb.rpc('create_booking_request', {
        p_booking: {
          category: 'MFA',
          check_in: d(15),
          check_out: d(18),
          party_size: 1,
          is_suite_booking: false,
          preferred_room_type: 'VIP',
        },
        p_guests: [
          {
            seq: 1,
            gender: 'M',
            rank_code: 'WG_CDR',
            guest_name: 'New Pending Guest',
            service_number: '29102-K',
            unit: 'Command HQ',
            phone: '9811223344',
          },
        ],
      });
      expect(reqRes.error).toBeNull();
      const pendingBookingId = reqRes.data;

      // 3. Query room states for d(15) -> d(18)
      const statesRes = await sb.rpc('daily_room_state', {
        p_from: d(15),
        p_to: d(18),
      });
      expect(statesRes.error).toBeNull();
      const states = statesRes.data || [];

      // Room V-02 must have beds_taken = 2
      const v02State = states.find((r: any) => r.room_id === roomIds['V-02'] && r.date === d(15));
      expect(v02State).toBeDefined();
      expect(v02State.beds_taken).toBe(2);

      // 4. Room vacancy check: Room V-02 has NO free beds, while Room V-03 has 2 free beds
      const v02Occupants = states.filter((s: any) => s.room_id === roomIds['V-02']).flatMap((s: any) => s.occupants);
      const v02TakenBeds = new Set(v02Occupants.map((o: any) => o.bedSlot));
      const v02FreeBeds = [1, 2].filter((b) => !v02TakenBeds.has(b));
      expect(v02FreeBeds).toHaveLength(0); // Fully booked room has 0 free beds!

      const v03Occupants = states.filter((s: any) => s.room_id === roomIds['V-03']).flatMap((s: any) => s.occupants);
      const v03TakenBeds = new Set(v03Occupants.map((o: any) => o.bedSlot));
      const v03FreeBeds = [1, 2].filter((b) => !v03TakenBeds.has(b));
      expect(v03FreeBeds).toHaveLength(2); // Vacant room has both beds free!

      // 5. Operator allots the new guest to Room V-03 Bed 1
      const allotRes = await sb.rpc('allot_booking_rooms', {
        p_booking_id: pendingBookingId,
        p_allocations: [
          { guest_seq: 1, room_id: roomIds['V-03'], bed_slot: 1 },
        ],
      });
      expect(allotRes.error).toBeNull();

      // 6. Verify booking transitioned from PENDING_ALLOTMENT to CONFIRMED
      const confirmedBooking = (await sb.from('bookings').select('*').eq('id', pendingBookingId).single()).data;
      expect(confirmedBooking.status).toBe('CONFIRMED');

      // 7. Verify Room V-03 now has an active allocation for the guest
      const allocs = (await sb.from('allocations').select('*').eq('booking_id', pendingBookingId)).data;
      expect(allocs).toHaveLength(1);
      expect(allocs![0].room_id).toBe(roomIds['V-03']);
      expect(allocs![0].bed_slot).toBe(1);
      expect(allocs![0].status).toBe('ACTIVE');
    });

    it('guarantees guest details saved in booking wizard are immediately persisted and reflected in ledger and requests', async () => {
      await signInAs('clerk');

      // 1. Clerk enters request with officer name, unit, service number, and phone
      const officerName = 'Wing Commander Vikram Malhotra';
      const officerUnit = '17 Squadron Golden Arrows';
      const officerServiceNo = '28491-A';
      const officerPhone = '+91 9876543210';

      const createRes = await sb.rpc('create_booking', {
        p_booking: {
          category: 'MFA',
          check_in: d(2),
          check_out: d(5),
          party_size: 1,
          is_suite_booking: false,
          status: 'PENDING_ALLOTMENT',
        },
        p_guests: [
          {
            seq: 1,
            gender: 'M',
            rank_code: 'WG_CDR',
            guest_name: officerName,
            unit: officerUnit,
            service_number: officerServiceNo,
            phone: officerPhone,
          },
        ],
        p_allocations: [],
      });
      expect(createRes.error).toBeNull();
      const bookingId = createRes.data;

      // 2. Fetch created guest record safely
      const guestRows = (await sb.from('booking_guests').select('*').eq('booking_id', bookingId)).data;
      expect(guestRows).toHaveLength(1);
      const guestId = guestRows![0].id;

      // 3. Save guest details via set_booking_guest_details RPC
      const setDetailsRes = await sb.rpc('set_booking_guest_details', {
        p_guest_id: guestId,
        p_guest_name: officerName,
        p_unit: officerUnit,
        p_service_number: officerServiceNo,
        p_phone: officerPhone,
      });
      expect(setDetailsRes.error).toBeNull();

      // 4. Save encrypted PII via set_guest_pii
      const piiRes = await sb.rpc('set_guest_pii', {
        p_guest_id: guestId,
        p_pii_enc: 'dummy-cipher-vikram',
        p_blind: null,
        p_key_version: 1,
      });
      expect(piiRes.error).toBeNull();

      // 5. Verify booking_guests columns are populated and details is COMPLETE
      const updatedGuest = (await sb.from('booking_guests').select('*').eq('id', guestId).single()).data;
      expect(updatedGuest.guest_name).toBe(officerName);
      expect(updatedGuest.unit).toBe(officerUnit);
      expect(updatedGuest.service_number).toBe(officerServiceNo);
      expect(updatedGuest.phone).toBe(officerPhone);
      expect(updatedGuest.details).toBe('COMPLETE');

      // 6. Universal search matches by name
      const searchByName = await sb.rpc('search_bookings_and_guests', { p_query: 'Vikram' });
      expect(searchByName.data?.map((r: any) => r.booking_id)).toContain(bookingId);

      // 7. Universal search matches by unit
      const searchByUnit = await sb.rpc('search_bookings_and_guests', { p_query: 'Golden Arrows' });
      expect(searchByUnit.data?.map((r: any) => r.booking_id)).toContain(bookingId);

      // 8. Universal search matches by service number
      const searchBySvc = await sb.rpc('search_bookings_and_guests', { p_query: '28491-A' });
      expect(searchBySvc.data?.map((r: any) => r.booking_id)).toContain(bookingId);

      // 9. Verify Ledger query (bookings with booking_guests) includes the officer details
      const ledgerBookings = (await sb.from('bookings').select('*, booking_guests(*)').eq('id', bookingId).single()).data;
      expect(ledgerBookings.booking_guests[0].guest_name).toBe(officerName);
      expect(ledgerBookings.booking_guests[0].unit).toBe(officerUnit);
      expect(ledgerBookings.booking_guests[0].service_number).toBe(officerServiceNo);
    });

    it('enables taking request for later allotment, populating in requests queue, and allotting room successfully', async () => {
      // 1. Operator takes guest request with "Save for Later Allotment"
      const { data: bkgId, error: createErr } = await sb.rpc('create_booking', {
        p_booking: {
          category: 'MFA',
          check_in: d(1),
          check_out: d(3),
          party_size: 1,
          is_suite_booking: false,
          status: 'PENDING_ALLOTMENT',
        },
        p_guests: [
          {
            seq: 1,
            gender: 'M',
            rank_code: 'WG_CDR',
            guest_name: 'Wg Cdr Abhinav Sharma',
            service_number: '29811-M',
            unit: 'Tactical Air Centre',
            phone: '9811223344',
          },
        ],
        p_allocations: [],
      });
      expect(createErr).toBeNull();
      expect(bkgId).toBeTruthy();

      // 2. Pending allotment booking populates in pending requests queue
      const { data: pendingRequests } = await sb
        .from('bookings')
        .select('*, booking_guests(*), allocations(*)')
        .eq('status', 'PENDING_ALLOTMENT');

      const foundReq = pendingRequests?.find((r: any) => r.id === bkgId);
      expect(foundReq).toBeTruthy();
      expect(foundReq.status).toBe('PENDING_ALLOTMENT');
      expect(foundReq.booking_guests[0].guest_name).toBe('Wg Cdr Abhinav Sharma');
      expect(foundReq.booking_guests[0].rank_code).toBe('WG_CDR');
      expect(foundReq.allocations).toHaveLength(0);

      // 3. Operator clicks the guest name / Choose Room & Bed, selects available room
      const targetRoomId = roomIds['V-03'];
      const { error: allotErr } = await sb.rpc('allot_booking_rooms', {
        p_booking_id: bkgId,
        p_allocations: [
          {
            guest_seq: 1,
            room_id: targetRoomId,
            bed_slot: 1,
          },
        ],
      });
      expect(allotErr).toBeNull();

      // 4. Booking is now CONFIRMED with active allocation
      const confirmedBkg = (await sb.from('bookings').select('*, allocations(*)').eq('id', bkgId).single()).data;
      expect(confirmedBkg.status).toBe('CONFIRMED');
      expect(confirmedBkg.allocations).toHaveLength(1);
      expect(confirmedBkg.allocations[0].status).toBe('ACTIVE');
      expect(confirmedBkg.allocations[0].room_id).toBe(targetRoomId);

      // 5. Booking is no longer in pending requests queue
      const { data: updatedPending } = await sb
        .from('bookings')
        .select('id')
        .eq('status', 'PENDING_ALLOTMENT');
      expect(updatedPending?.some((r: any) => r.id === bkgId)).toBe(false);

      // 6. Room inventory / daily_room_state shows the bed is taken
      const dayStates = await rooms(d(1), d(2));
      const rm01State = dayStates.find((r: any) => r.room_id === targetRoomId);
      expect(rm01State?.beds_taken).toBeGreaterThanOrEqual(1);
      expect(rm01State?.occupants.some((o: any) => o.rankCode === 'WG_CDR')).toBe(true);
    });

    it('direct room allotment from wizard persists full guest details immediately and blocks room availability in subsequent searches', async () => {
      // 1. Direct allotment from wizard: operator fills guest details and chooses room immediately
      const chosenRoomId = roomIds['V-02'];
      const { data: bkgId, error: createErr } = await sb.rpc('create_booking', {
        p_booking: {
          category: 'MFA',
          check_in: d(3),
          check_out: d(6),
          party_size: 1,
          is_suite_booking: false,
          preferred_room_type: 'VIP',
        },
        p_guests: [
          {
            seq: 1,
            gender: 'M',
            rank_code: 'SQN_LDR',
            guest_name: 'Sqn Ldr Vikram Roy',
            service_number: '31092-B',
            unit: '12 Wing IAF',
            phone: '9988776655',
          },
        ],
        p_allocations: [
          {
            guest_seq: 1,
            room_id: chosenRoomId,
            bed_slot: 1,
          },
        ],
      });
      expect(createErr).toBeNull();
      expect(bkgId).toBeTruthy();

      // 2. Fetch created guest record and verify guest details are immediately in DB without backfilling
      const { data: guestRows } = await sb
        .from('booking_guests')
        .select('*')
        .eq('booking_id', bkgId);
      expect(guestRows).toHaveLength(1);
      const g = guestRows![0];
      expect(g.guest_name).toBe('Sqn Ldr Vikram Roy');
      expect(g.service_number).toBe('31092-B');
      expect(g.unit).toBe('12 Wing IAF');
      expect(g.phone).toBe('9988776655');

      // 3. Verify room state for stay dates reflects the bed as taken
      const dayStates = await rooms(d(3), d(6));
      const roomState = dayStates.find((r: any) => r.room_id === chosenRoomId);
      expect(roomState).toBeTruthy();
      expect(roomState?.beds_taken).toBe(1);
      expect(roomState?.occupants).toHaveLength(1);
      expect(roomState?.occupants[0].rankCode).toBe('SQN_LDR');

      // 4. Verify resilient pending requests query correctly excludes this confirmed/allotted booking
      const { data: allActiveBookings } = await sb
        .from('bookings')
        .select('*, booking_guests(*), allocations(*)')
        .not('status', 'in', '("CANCELLED","DISPLACED","COMPLETED")');

      const unallotted = (allActiveBookings || []).filter((b: any) => {
        if (b.status === 'CANCELLED' || b.status === 'DISPLACED' || b.status === 'COMPLETED') return false;
        if (b.status === 'PENDING_ALLOTMENT') return true;
        const activeAllocs = (b.allocations || []).filter((a: any) => a.status === 'ACTIVE');
        return activeAllocs.length === 0;
      });

      // The directly allotted booking is not pending
      expect(unallotted.some((b: any) => b.id === bkgId)).toBe(false);

      // Now create a booking without allocations (pending allotment)
      const { data: pendingBkgId } = await sb.rpc('create_booking', {
        p_booking: {
          category: 'PI',
          check_in: d(4),
          check_out: d(7),
          party_size: 1,
          is_suite_booking: false,
          status: 'PENDING_ALLOTMENT',
        },
        p_guests: [
          {
            seq: 1,
            gender: 'F',
            rank_code: 'FLT_LT',
            guest_name: 'Flt Lt Priya Singh',
            service_number: '34102-K',
            unit: 'Air HQ',
            phone: '9123456780',
          },
        ],
        p_allocations: [],
      });

      // Query active bookings again
      const { data: refreshedActiveBookings } = await sb
        .from('bookings')
        .select('*, booking_guests(*), allocations(*)')
        .not('status', 'in', '("CANCELLED","DISPLACED","COMPLETED")');

      const updatedUnallotted = (refreshedActiveBookings || []).filter((b: any) => {
        if (b.status === 'CANCELLED' || b.status === 'DISPLACED' || b.status === 'COMPLETED') return false;
        if (b.status === 'PENDING_ALLOTMENT') return true;
        const activeAllocs = (b.allocations || []).filter((a: any) => a.status === 'ACTIVE');
        return activeAllocs.length === 0;
      });

      // Pending allotment booking is found in the unallotted list
      const foundPending = updatedUnallotted.find((b: any) => b.id === pendingBkgId);
      expect(foundPending).toBeTruthy();
      expect(foundPending?.booking_guests[0].guest_name).toBe('Flt Lt Priya Singh');
      expect(foundPending?.booking_guests[0].service_number).toBe('34102-K');
    });

    it('handles 12:00 PM check-in and check-out turnover without bed collision', async () => {
      const targetRoomId = roomIds['N-01'];

      // Guest 1: Stays d(0) to d(2) (Check-out on d(2) at 12:00 PM)
      const { data: bkg1Id, error: err1 } = await sb.rpc('create_booking', {
        p_booking: {
          category: 'MFA',
          check_in: d(0),
          check_out: d(2),
          party_size: 1,
          is_suite_booking: false,
          status: 'CONFIRMED',
        },
        p_guests: [
          {
            seq: 1,
            gender: 'M',
            rank_code: 'FLT_LT',
            guest_name: 'Flt Lt Rajesh Kumar',
            service_number: '28114-A',
            unit: '4 Wing',
            phone: '9811122233',
          },
        ],
        p_allocations: [
          {
            guest_seq: 1,
            room_id: targetRoomId,
            bed_slot: 1,
          },
        ],
      });
      expect(err1).toBeNull();
      expect(bkg1Id).toBeTruthy();

      // Guest 2: Stays d(2) to d(5) (Check-in on d(2) at 12:00 PM - turnover date)
      // Because check-in is 12 PM and previous check-out is 12 PM (half-open [check_in, check_out)),
      // Bed 1 in N-01 is free for Guest 2 starting at 12:00 PM on d(2).
      const { data: bkg2Id, error: err2 } = await sb.rpc('create_booking', {
        p_booking: {
          category: 'MFA',
          check_in: d(2),
          check_out: d(5),
          party_size: 1,
          is_suite_booking: false,
          status: 'CONFIRMED',
        },
        p_guests: [
          {
            seq: 1,
            gender: 'M',
            rank_code: 'SQN_LDR',
            guest_name: 'Sqn Ldr Anish Verma',
            service_number: '29871-S',
            unit: 'Air HQ',
            phone: '9844455566',
          },
        ],
        p_allocations: [
          {
            guest_seq: 1,
            room_id: targetRoomId,
            bed_slot: 1,
          },
        ],
      });
      expect(err2).toBeNull();
      expect(bkg2Id).toBeTruthy();

      // Verify room state on d(1): occupied by Guest 1
      const stateD1 = await rooms(d(1), d(2));
      const roomD1 = stateD1.find((r: any) => r.room_id === targetRoomId);
      expect(roomD1?.beds_taken).toBe(1);
      expect(roomD1?.occupants[0].rankCode).toBe('FLT_LT');

      // Verify room state on d(2) (turnover day): occupied by Guest 2 (from 12 PM onward)
      const stateD2 = await rooms(d(2), d(3));
      const roomD2 = stateD2.find((r: any) => r.room_id === targetRoomId);
      expect(roomD2?.beds_taken).toBe(1);
      expect(roomD2?.occupants[0].rankCode).toBe('SQN_LDR');
    });

    it('facilitates direct booking from room inventory with pre-selected room and bed', async () => {
      // Simulate booking initiated from Room Inventory for S-02, Bed 2
      const targetRoomId = roomIds['S-02'];
      const targetBedSlot = 2;

      const { data: bkgId, error } = await sb.rpc('create_booking', {
        p_booking: {
          category: 'TD',
          check_in: d(1),
          check_out: d(4),
          party_size: 1,
          is_suite_booking: false,
          status: 'CONFIRMED',
        },
        p_guests: [
          {
            seq: 1,
            gender: 'F',
            rank_code: 'WG_CDR',
            guest_name: 'Wg Cdr Sunita Rao',
            service_number: '31220-R',
            unit: '12 Wing',
            phone: '9876501234',
          },
        ],
        p_allocations: [
          {
            guest_seq: 1,
            room_id: targetRoomId,
            bed_slot: targetBedSlot,
          },
        ],
      });

      expect(error).toBeNull();
      expect(bkgId).toBeTruthy();

      // Verify allocation row
      const { data: allocRows } = await sb
        .from('allocations')
        .select('*')
        .eq('booking_id', bkgId);
      expect(allocRows).toHaveLength(1);
      expect(allocRows![0].room_id).toBe(targetRoomId);
      expect(allocRows![0].bed_slot).toBe(targetBedSlot);

      // Verify guest details
      const { data: guestRows } = await sb
        .from('booking_guests')
        .select('*')
        .eq('booking_id', bkgId);
      expect(guestRows![0].guest_name).toBe('Wg Cdr Sunita Rao');
      expect(guestRows![0].service_number).toBe('31220-R');
    });
  });
});

describe('civilian guests', () => {
  it('officer + spouse share a room; children share the next one', async () => {
    const r = await book({
      checkIn: d(0),
      checkOut: d(2),
      guests: [G('M', 'WG_CDR'), C('F', 'SPOUSE'), C('M', 'CHILD'), C('F', 'CHILD')],
      pref: 'VIP',
    });
    const roomOf = (i: number) => r.placements.find((p) => p.guest === i)!.room;
    expect(roomOf(0)).toBe(roomOf(1));
    expect(roomOf(2)).toBe(roomOf(3));
    expect(roomOf(0)).not.toBe(roomOf(2));
    const { data: guests } = await sb.from('booking_guests').select('*').eq('booking_id', r.id).order('seq');
    expect(guests.map((g: any) => [g.relation, g.rank_code])).toEqual([
      ['PRIMARY', 'WG_CDR'], ['SPOUSE', null], ['CHILD', null], ['CHILD', null],
    ]);
    const states = await rooms(d(0), d(1));
    const occ = states.flatMap((s) => s.occupants).find((o: any) => o.relation === 'SPOUSE');
    expect(occ).toMatchObject({ rankCode: null, bookingId: r.id });
  });

  it('a lone civilian is never seated beside another booking’s guest', async () => {
    const first = await book({ checkIn: d(0), checkOut: d(1), guests: [G('F', 'FO'), C('F', 'OTHER'), C('F', 'OTHER')], pref: 'NORMAL' });
    const lone = first.placements.find((p) => p.guest === 2)!;
    const r = await book({ checkIn: d(0), checkOut: d(1), guests: [G('F', 'FO')], pref: 'NORMAL', sharing: true });
    expect(r.placements[0].room).not.toBe(lone.room);
    // Forcing it through the RPC hits the DB sharing rule.
    const res = await sb.rpc('create_booking', bookingPayload(
      { checkIn: d(0), checkOut: d(1), guests: [G('F', 'FO')] },
      [{ guestIndex: 0, roomId: roomIds[lone.room], bedSlot: lone.bed === 1 ? 2 : 1 }],
    ));
    expect(res.error?.message).toContain('ERR_SHARE_RULE');
  });

  it('a booking must have exactly one ranked primary, and civilians carry no rank', async () => {
    const civiliansOnly = await sb.rpc('create_booking', {
      p_booking: { category: 'LEAVE', check_in: d(0), check_out: d(1), party_size: 1, is_suite_booking: false },
      p_guests: [{ seq: 1, gender: 'F', rank_code: null, relation: 'SPOUSE' }],
      p_allocations: [],
    });
    expect(civiliansOnly.error?.message).toContain('ERR_PRIMARY_GUEST');
    const rankedCivilian = await sb.rpc('create_booking', {
      p_booking: { category: 'LEAVE', check_in: d(0), check_out: d(1), party_size: 2, is_suite_booking: false },
      p_guests: [
        { seq: 1, gender: 'M', rank_code: 'FO', relation: 'PRIMARY' },
        { seq: 2, gender: 'F', rank_code: 'FO', relation: 'SPOUSE' },
      ],
      p_allocations: [],
    });
    expect(rankedCivilian.error?.message).toContain('check_guest_rank_matches_relation');
  });

  it('civilian details save without an ID number', async () => {
    const r = await book({ checkIn: d(0), checkOut: d(1), guests: [G('M', 'FO'), C('M', 'CHILD')] });
    const { data: guests } = await sb.from('booking_guests').select('*').eq('booking_id', r.id).order('seq');
    const res = await sb.rpc('set_guest_pii', { p_guest_id: guests[1].id, p_pii_enc: 'cipher', p_blind: null, p_key_version: 1 });
    expect(res.error).toBeNull();
    expect((await sb.rpc('search_guests_by_blind_index', { p_blind: null })).data).toEqual([]);
  });
});

describe('booking logic review fixes', () => {
  const requestFor = async (guests: GuestDemand[], category: Category = 'LEAVE', checkIn = d(0), checkOut = d(2)) => {
    const { data, error } = await sb.rpc('create_booking_request', {
      p_booking: { category, check_in: checkIn, check_out: checkOut, party_size: guests.length, is_suite_booking: false },
      p_guests: guestRowsPayload(guests),
    });
    expect(error, error?.message).toBeNull();
    return data as string;
  };
  const allocationsOf = async (bookingId: string) =>
    ((await sb.from('allocations').select('*').eq('booking_id', bookingId)).data ?? []) as any[];

  it('allotment must seat every guest: a partial allotment is rejected and nothing is saved', async () => {
    const id = await requestFor([G('M', 'FO'), G('M', 'FO')]);
    const res = await sb.rpc('allot_booking_rooms', {
      p_booking_id: id,
      p_allocations: [{ guest_seq: 1, room_id: roomIds['N-01'], bed_slot: 1 }],
    });
    expect(res.error?.message).toContain('ERR_INCOMPLETE_ALLOTMENT');
    expect((await sb.from('bookings').select('*').eq('id', id).single()).data.status).toBe('PENDING_ALLOTMENT');
    expect(await allocationsOf(id)).toHaveLength(0);
  });

  it('allotment never falls back to guest #1 for an unknown guest or a repeated guest', async () => {
    const id = await requestFor([G('M', 'FO'), G('M', 'FO')]);
    const unknown = await sb.rpc('allot_booking_rooms', {
      p_booking_id: id,
      p_allocations: [
        { guest_seq: 1, room_id: roomIds['N-01'], bed_slot: 1 },
        { guest_seq: 9, room_id: roomIds['N-01'], bed_slot: 2 },
      ],
    });
    expect(unknown.error?.message).toContain('ERR_INVALID_GUEST');
    const repeated = await sb.rpc('allot_booking_rooms', {
      p_booking_id: id,
      p_allocations: [
        { guest_seq: 1, room_id: roomIds['N-01'], bed_slot: 1 },
        { guest_seq: 1, room_id: roomIds['N-01'], bed_slot: 2 },
      ],
    });
    expect(repeated.error?.message).toContain('ERR_INVALID_GUEST');
    expect(await allocationsOf(id)).toHaveLength(0);
  });

  it('create_booking rejects allocations that leave a guest without a bed', async () => {
    const a = { checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO'), G('M', 'FO')] };
    const payload = bookingPayload(a, [{ guestIndex: 0, roomId: roomIds['N-01'], bedSlot: 1 }]);
    const res = await sb.rpc('create_booking', payload);
    expect(res.error?.message).toContain('ERR_INCOMPLETE_ALLOTMENT');
    expect(((await sb.from('bookings').select('*')).data ?? []).length).toBe(0);
  });

  it('a pending-allotment request cannot carry allocations', async () => {
    const a = { checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')] };
    const payload = bookingPayload(a, [{ guestIndex: 0, roomId: roomIds['N-01'], bedSlot: 1 }]);
    payload.p_booking = { ...payload.p_booking, status: 'PENDING_ALLOTMENT' } as typeof payload.p_booking;
    const res = await sb.rpc('create_booking', payload);
    expect(res.error?.message).toContain('ERR_INVALID_REQUEST');
  });

  it('cancelling an unknown booking fails instead of writing an audit row', async () => {
    const before = ((await sb.from('audit_log').select('*')).data ?? []).length;
    const res = await sb.rpc('cancel_booking', { p_id: crypto.randomUUID(), p_reason_enc: 'x', p_key_version: 1 });
    expect(res.error?.message).toContain('ERR_NOT_FOUND');
    expect(((await sb.from('audit_log').select('*')).data ?? []).length).toBe(before);
  });

  it('eviction rejects a bed that is not occupied during the incoming stay', async () => {
    await fillAllRooms(d(0), d(2), 'LEAVE');
    const { data: cands } = await sb.rpc('eviction_candidates', {
      p_category: 'MFA', p_check_in: d(0), p_check_out: d(2), p_guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }],
    });
    const res = await sb.rpc('approve_eviction', {
      p_incoming: { category: 'MFA', check_in: d(5), check_out: d(6), party_size: 1, guests: [{ seq: 1, gender: 'M', rank_code: 'AVM', relation: 'PRIMARY' }] },
      p_evict_allocation_ids: [cands[0].allocation_id],
      p_reason_enc: 'enc:official-duty-reason',
      p_key_version: 1,
      p_reason_aad_id: crypto.randomUUID(),
    });
    expect(res.error?.message).toContain('ERR_EVICTION_NO_OVERLAP');
  });

  it('eviction allots the existing pending request in place instead of creating a second booking', async () => {
    await fillAllRooms(d(0), d(2), 'LEAVE');
    const pendingId = await requestFor([G('M', 'AVM')], 'MFA');
    const countBefore = ((await sb.from('bookings').select('*')).data ?? []).length;
    const { data: cands } = await sb.rpc('eviction_candidates', {
      p_category: 'MFA', p_check_in: d(0), p_check_out: d(2), p_guests: [{ seq: 1, gender: 'M', rank_code: 'AVM' }],
    });
    const ids = cands.filter((c: any) => c.room_id === cands[0].room_id).map((c: any) => c.allocation_id);
    const { data: newId, error } = await sb.rpc('approve_eviction', {
      // The payload's category is ignored: the stored request decides who may be displaced.
      p_incoming: { booking_id: pendingId, category: 'LEAVE', check_in: d(0), check_out: d(2), party_size: 1, guests: [] },
      p_evict_allocation_ids: ids,
      p_reason_enc: 'enc:official-duty-reason',
      p_key_version: 1,
      p_reason_aad_id: crypto.randomUUID(),
    });
    expect(error, error?.message).toBeNull();
    expect(newId).toBe(pendingId);
    expect(((await sb.from('bookings').select('*')).data ?? []).length).toBe(countBefore);
    expect((await sb.from('bookings').select('*').eq('id', pendingId).single()).data.status).toBe('CONFIRMED');
    expect((await allocationsOf(pendingId)).filter((x) => x.status === 'ACTIVE')).toHaveLength(1);
  });

  it('denying a pending request cancels it and records the denial', async () => {
    const id = await requestFor([G('M', 'FO')], 'LEAVE');
    const res = await sb.rpc('record_denial', {
      p_category: 'LEAVE', p_check_in: d(0), p_check_out: d(2), p_party_size: 1, p_reason_enc: 'enc', p_key_version: 1,
      p_id: crypto.randomUUID(), p_booking_id: id,
    });
    expect(res.error, res.error?.message).toBeNull();
    expect((await sb.from('bookings').select('*').eq('id', id).single()).data.status).toBe('CANCELLED');
    const again = await sb.rpc('record_denial', {
      p_category: 'LEAVE', p_check_in: d(0), p_check_out: d(2), p_party_size: 1, p_reason_enc: 'enc', p_key_version: 1,
      p_booking_id: id,
    });
    expect(again.error?.message).toContain('ERR_BOOKING_NOT_PENDING');
  });
});
