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
  type Gender,
  type GuestDemand,
  type RankCode,
  type RoomType,
} from '@sms/core';
import { createDevSupabase, DEV_USERS } from './devBackend';
import { mapRoomDayState } from '../features/bookings/mapRoomState';
import { userErrorMessage } from '../lib/userError';
import { addDaysToDateString } from '../lib/dates';
import { alternatesHorizonEnd } from '../features/bookings/planBooking';

type Sb = ReturnType<typeof createDevSupabase> & { auth: any };

const today = new Date().toISOString().slice(0, 10); // backend CURRENT_DATE is UTC
const d = (n: number) => addDaysToDateString(today, n);

const G = (gender: Gender, rankCode: RankCode): GuestDemand => ({ gender, rankCode });

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
    category: a.category ?? 'MSA',
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
      category: a.category ?? 'MSA',
      check_in: a.checkIn,
      check_out: a.checkOut,
      party_size: a.guests.length,
      is_suite_booking: false,
    },
    p_guests: a.guests.map((g, i) => ({ seq: i + 1, gender: g.gender, rank_code: g.rankCode })),
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

  it('LEAVE/TD can be denied, MSA/PI cannot', async () => {
    const ok = await sb.rpc('record_denial', {
      p_category: 'LEAVE', p_check_in: d(0), p_check_out: d(2), p_party_size: 1, p_reason_enc: 'enc', p_key_version: 1, p_id: crypto.randomUUID(),
    });
    expect(ok.error).toBeNull();
    for (const cat of ['MSA', 'PI']) {
      const bad = await sb.rpc('record_denial', {
        p_category: cat, p_check_in: d(0), p_check_out: d(2), p_party_size: 1, p_reason_enc: 'enc', p_key_version: 1,
      });
      expect(bad.error?.message).toContain('ERR_CANNOT_DENY_PRIORITY');
      expect(userErrorMessage(bad.error)).toMatch(/cannot be turned away|Eviction Review/i);
    }
  });

  it('MSA evicts LEAVE: candidates exclude MSA/PI and the incoming booking takes the freed beds', async () => {
    await fillAllRooms(d(0), d(2), 'LEAVE');
    const { data: cands } = await sb.rpc('eviction_candidates', {
      p_category: 'MSA', p_check_in: d(0), p_check_out: d(2), p_guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }],
    });
    expect(cands.length).toBe(18);
    expect(cands.every((c: any) => c.category === 'LEAVE')).toBe(true);

    // Evict both beds of the first room so the whole room is clean for an M/AVM guest.
    const firstRoom = cands[0].room_id;
    const leaveId = cands[0].booking_id;
    const ids = cands.filter((c: any) => c.room_id === firstRoom).map((c: any) => c.allocation_id);
    expect(ids.length).toBe(2);
    const { data: newId, error } = await sb.rpc('approve_eviction', {
      p_incoming: { category: 'MSA', check_in: d(0), check_out: d(2), party_size: 1, guests: [{ seq: 1, gender: 'M', rank_code: 'AVM' }] },
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

  it('PI can evict LEAVE/TD only; PI cannot evict PI or MSA', async () => {
    await book({ category: 'MSA', checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO'), G('M', 'FO')], pref: 'VIP' });
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
      p_category: 'MSA', p_check_in: d(0), p_check_out: d(2), p_guests: [{ seq: 1, gender: 'F', rank_code: 'FO' }],
    });
    const res = await sb.rpc('approve_eviction', {
      p_incoming: { category: 'MSA', check_in: d(0), check_out: d(2), party_size: 1, guests: [{ seq: 1, gender: 'F', rank_code: 'FO' }] },
      p_evict_allocation_ids: [cands[0].allocation_id],
      p_reason_enc: 'enc:official-duty-reason',
      p_key_version: 1,
      p_reason_aad_id: crypto.randomUUID(),
    });
    expect(res.error?.message).toContain('ERR_SHARE_RULE');
    // Atomic: nothing was evicted.
    const after = await sb.rpc('eviction_candidates', {
      p_category: 'MSA', p_check_in: d(0), p_check_out: d(2), p_guests: [],
    });
    expect(after.data).toHaveLength(2);
  });

  it('partial eviction of a multi-room party must not strand the rest of the party', async () => {
    // One LEAVE booking of two different people (two rooms). Evict just one of them.
    const party = await book({ category: 'LEAVE', checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO'), G('F', 'FO')], pref: 'VIP' });
    const { data: cands } = await sb.rpc('eviction_candidates', {
      p_category: 'MSA', p_check_in: d(0), p_check_out: d(2), p_guests: [{ seq: 1, gender: 'M', rank_code: 'WG_CDR' }],
    });
    const target = cands.find((c: any) => c.occupant_gender === 'M');
    const res = await sb.rpc('approve_eviction', {
      p_incoming: { category: 'MSA', check_in: d(0), check_out: d(2), party_size: 1, guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }] },
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
    const msa = await book({ category: 'MSA', checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP' });
    const { data: bookingRow } = await (sb.from('bookings') as any).select('*, allocations(*)').eq('id', msa.id).single();
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
      p_category: 'MSA', p_check_in: d(0), p_check_out: d(2), p_guests: [],
    });
    const res = await sb.rpc('approve_eviction', {
      p_incoming: {
        category: 'MSA', check_in: d(0), check_out: d(2), party_size: 2,
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
      p_booking: { category: 'MSA', check_in: d(1), check_out: d(2), party_size: 1, is_suite_booking: false },
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
      p_booking: { category: 'MSA', check_in: d(0), check_out: d(1), party_size: 2, is_suite_booking: false },
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
    const base = { category: 'MSA', check_in: d(0), check_out: d(1), party_size: 1, is_suite_booking: false };
    const g = [{ seq: 1, gender: 'M', rank_code: 'FO' }];
    const a = [{ guest_seq: 1, room_id: roomIds['N-01'], bed_slot: 1 }];
    expect((await sb.rpc('create_booking', { p_booking: { ...base, party_size: 2 }, p_guests: g, p_allocations: a })).error?.message).toContain('ERR_PARTY_MISMATCH');
    expect((await sb.rpc('create_booking', { p_booking: { ...base, check_out: d(0) }, p_guests: g, p_allocations: a })).error?.message).toContain('check_stay_dates');
    expect((await sb.rpc('create_booking', { p_booking: { ...base, check_out: d(-1) }, p_guests: g, p_allocations: a })).error?.message).toContain('check_stay_dates');
    expect((await sb.rpc('create_booking', { p_booking: { ...base, category: 'VIP' }, p_guests: g, p_allocations: a })).error).not.toBeNull();
    expect((await sb.rpc('create_booking', { p_booking: { ...base, party_size: 0 }, p_guests: [], p_allocations: [] })).error).not.toBeNull();
  });

  it('cancelling frees the beds for a new booking and double-cancel is harmless', async () => {
    const a = await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP' });
    expect((await sb.rpc('cancel_booking', { p_id: a.id, p_reason_enc: 'enc', p_key_version: 1 })).error).toBeNull();
    const b = await book({ checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO')], pref: 'VIP' });
    expect(b.placements[0].room).toBe('V-01');
    expect((await sb.rpc('cancel_booking', { p_id: a.id, p_reason_enc: 'enc', p_key_version: 1 })).error).toBeNull();
    // the second booking is untouched
    const { data } = await sb.from('bookings').select('*').eq('id', b.id).single();
    expect(data.status).toBe('CONFIRMED');
  });
});

describe('roles and suites', () => {
  it('clerk cannot backdate; admin can', async () => {
    await signInAs('clerk');
    const res = await sb.rpc('create_booking', {
      p_booking: { category: 'MSA', check_in: d(-3), check_out: d(-1), party_size: 1, is_suite_booking: false },
      p_guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }],
      p_allocations: [{ guest_seq: 1, room_id: roomIds['N-01'], bed_slot: 1 }],
    });
    expect(res.error?.message).toContain('backdate');
    expect(userErrorMessage(res.error)).toMatch(/Administrator/);
    await signInAs('admin');
    const ok = await sb.rpc('create_booking', {
      p_booking: { category: 'MSA', check_in: d(-3), check_out: d(-1), party_size: 1, is_suite_booking: false },
      p_guests: [{ seq: 1, gender: 'M', rank_code: 'FO' }],
      p_allocations: [{ guest_seq: 1, room_id: roomIds['N-01'], bed_slot: 1 }],
    });
    expect(ok.error).toBeNull();
  });

  it('suite booking: admin only, invisible to clerks, never in clerk room state', async () => {
    await signInAs('clerk');
    const denied = await sb.rpc('create_booking', {
      p_booking: { category: 'MSA', check_in: d(0), check_out: d(2), party_size: 1, is_suite_booking: true },
      p_guests: [{ seq: 1, gender: 'M', rank_code: 'AM' }],
      p_allocations: [{ guest_seq: 1, room_id: roomIds['SU-01'], bed_slot: 1 }],
    });
    expect(denied.error?.message).toContain('ERR_SUITE_ONLY_ADMIN');

    await signInAs('admin');
    const ok = await sb.rpc('create_booking', {
      p_booking: { category: 'MSA', check_in: d(0), check_out: d(2), party_size: 1, is_suite_booking: true },
      p_guests: [{ seq: 1, gender: 'M', rank_code: 'AM' }],
      p_allocations: [{ guest_seq: 1, room_id: roomIds['SU-01'], bed_slot: 1 }],
    });
    expect(ok.error).toBeNull();
    // non-suite booking into the suite room is also refused
    const wrong = await sb.rpc('create_booking', {
      p_booking: { category: 'MSA', check_in: d(5), check_out: d(6), party_size: 1, is_suite_booking: false },
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
    await book({ category: 'MSA', checkIn: d(0), checkOut: d(2), guests: [G('M', 'FO'), G('M', 'FO')], pref: 'VIP' });
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
});
