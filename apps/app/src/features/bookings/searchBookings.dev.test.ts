/**
 * The ledger's search path end to end against the dev backend (which mirrors the SQL and the
 * grants): the same query the screen runs to load bookings, the RPC it calls for server hits, then
 * the pure matching. Real bookings with plain names, full ranks, units and rooms must come back.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createDevSupabase, DEV_USERS, messToday } from '../../dev/devBackend';
import { addDaysToDateString } from '../../lib/dates';
import { filterBookings, type SearchableBooking } from './searchBookings';

type Sb = ReturnType<typeof createDevSupabase> & { auth: any };
const today = messToday();
const d = (n: number) => addDaysToDateString(today, n);
let sb: Sb;
let roomNames: Record<string, string>;
let ids: { sharma: string; verma: string };

async function loadCorpus() {
  const { data, error } = await sb
    .from('bookings')
    .select('*, booking_guests(*), allocations(*)')
    .order('created_at', { ascending: false })
    .range(0, 999);
  expect(error).toBeNull();
  return data as Array<SearchableBooking & Record<string, any>>;
}

beforeEach(async () => {
  sb = createDevSupabase('mock') as Sb;
  await sb.auth.signInWithPassword({ email: DEV_USERS.admin.email });
  const roomId = crypto.randomUUID();
  expect(
    (await (sb.from('rooms') as any).insert({ id: roomId, room_type: 'VIP', name_enc: 'enc:V-01', display_order: 1 })).error,
  ).toBeNull();
  roomNames = { [roomId]: 'V-01' };

  const sharma = await sb.rpc('create_booking', {
    p_booking: { category: 'MFA', check_in: d(1), check_out: d(4), party_size: 2, is_suite_booking: false, allow_sharing: true },
    p_guests: [
      { seq: 1, gender: 'M', rank_code: 'FLT_LT', guest_name: 'Rohit Sharma', unit: '12 Wing', service_number: '29482-K', phone: '+91 98765 43210' },
      { seq: 2, gender: 'F', rank_code: null, relation: 'SPOUSE', guest_name: 'Meera Sharma' },
    ],
    p_allocations: [
      { guest_seq: 1, room_id: roomId, bed_slot: 1 },
      { guest_seq: 2, room_id: roomId, bed_slot: 2 },
    ],
  });
  expect(sharma.error).toBeNull();
  const verma = await sb.rpc('create_booking_request', {
    p_booking: { category: 'PI', check_in: d(10), check_out: d(12), party_size: 1, is_suite_booking: false },
    p_guests: [{ seq: 1, gender: 'M', rank_code: 'SQN_LDR', guest_name: 'Anil Verma', unit: 'AF Stn Hindan' }],
  });
  expect(verma.error).toBeNull();
  ids = { sharma: sharma.data as string, verma: verma.data as string };
});

describe('ledger search against the dev backend', () => {
  const find = async (text: string, extra: Record<string, string> = {}) => {
    const corpus = await loadCorpus();
    return filterBookings(corpus, { text, ...extra }, { roomNames }).map((b) => b.id);
  };

  it('returns bookings for name, full rank, unit, service number, phone, room, status and dates', async () => {
    for (const q of ['rohit', 'sharma', 'flight lieutenant', 'flight', '12 wing', '29482', '9876543210', 'v-01', 'confirmed', 'spouse']) {
      expect(await find(q), q).toEqual([ids.sharma]);
    }
    for (const q of ['verma', 'squadron leader', 'hindan', 'pending', 'posted in']) {
      expect(await find(q), q).toEqual([ids.verma]);
    }
    expect(await find(d(1))).toEqual([ids.sharma]);
    expect(await find('2 guests')).toEqual([ids.sharma]);
  });

  it('applies the rank, category, status and date-range filters', async () => {
    expect(await find('', { rank: 'SQN_LDR' })).toEqual([ids.verma]);
    expect(await find('', { rank: 'CIVILIAN' })).toEqual([ids.sharma]);
    expect(await find('', { category: 'PI' })).toEqual([ids.verma]);
    expect(await find('', { status: 'PENDING_ALLOTMENT' })).toEqual([ids.verma]);
    const corpus = await loadCorpus();
    const roomId = Object.keys(roomNames)[0];
    expect(filterBookings(corpus, { roomId }, { roomNames }).map((b) => b.id)).toEqual([ids.sharma]);
    expect(filterBookings(corpus, { dateFrom: d(9), dateTo: d(11) }, { roomNames }).map((b) => b.id)).toEqual([ids.verma]);
  });

  it('server search finds guest code, rank label and status words for an admin', async () => {
    const corpus = await loadCorpus();
    const code = corpus.find((b) => b.id === ids.sharma)!.booking_guests![0].guest_code!;
    const hits = async (q: string) => ((await sb.rpc('search_bookings_and_guests', { p_query: q })).data as any[]).map((r) => r.booking_id);
    expect(await hits(code)).toEqual([ids.sharma]);
    expect(await hits('flight lieutenant')).toEqual([ids.sharma]);
    expect(await hits('pending allotment')).toEqual([ids.verma]);
    expect(await hits('rohit')).toEqual([ids.sharma]);
  });

  it('the server keeps personal-detail matching behind reveal_guest_pii, the screen still searches what it can read', async () => {
    await sb.auth.signInWithPassword({ email: DEV_USERS.clerk.email });
    const server = (await sb.rpc('search_bookings_and_guests', { p_query: 'rohit' })).data as any[];
    expect(server).toEqual([]);
    expect(await find('rohit')).toEqual([ids.sharma]);
  });
});
