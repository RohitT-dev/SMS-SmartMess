/**
 * The guest report's fetch + filters against the dev backend (which mirrors the migrations'
 * RPCs and RLS), so the real query shape is exercised, not only the pure mapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDevSupabase, DEV_USERS, messToday } from '../../dev/devBackend';
import { addDaysToDateString } from '../../lib/dates';
import { filterGuestReportRows, type ReportRoom } from './guestReport';

const holder = vi.hoisted(() => ({ sb: null as any }));
vi.mock('../../lib/supabase', () => ({
  get supabase() {
    return holder.sb;
  },
}));
vi.mock('../crypto-session/cryptoSession', () => ({
  decryptGuestPii: () => {
    throw new Error('locked');
  },
}));

const { fetchGuestReportRows } = await import('./reportData');

const today = messToday();
const d = (n: number) => addDaysToDateString(today, n);
const roomIds: Record<string, string> = {};

async function signInAs(key: 'admin' | 'clerk') {
  await holder.sb.auth.signInWithPassword({ email: DEV_USERS[key].email });
}

async function addRoom(name: string, type: string, order: number) {
  const id = crypto.randomUUID();
  const { error } = await holder.sb.from('rooms').insert({ id, room_type: type, name_enc: `enc:${name}`, display_order: order });
  expect(error).toBeNull();
  roomIds[name] = id;
}

async function book(category: string, checkIn: string, checkOut: string, room: string, guest: Record<string, unknown>) {
  const { data, error } = await holder.sb.rpc('create_booking', {
    p_booking: { category, check_in: checkIn, check_out: checkOut, party_size: 1, is_suite_booking: false, allow_sharing: false },
    p_guests: [{ seq: 1, gender: 'M', rank_code: 'WG_CDR', ...guest }],
    p_allocations: [{ guest_seq: 1, room_id: roomIds[room], bed_slot: 1 }],
  });
  expect(error, error?.message).toBeNull();
  return data as string;
}

async function reportRooms(): Promise<Record<string, ReportRoom>> {
  const { data } = await holder.sb.from('rooms').select('id, name_enc, room_type');
  return Object.fromEntries((data as any[]).map((r) => [r.id, { name: r.name_enc.slice(4), type: r.room_type }]));
}

beforeEach(async () => {
  holder.sb = createDevSupabase('mock');
  await signInAs('admin');
  await addRoom('V-01', 'VIP', 1);
  await addRoom('S-01', 'SEMI_VIP', 2);
  await addRoom('N-01', 'NORMAL', 3);
  await signInAs('clerk');
});

describe('guest report against the dev backend', () => {
  it('lists confirmed and cancelled stays, not only cancelled ones, with plain details and rooms', async () => {
    await book('MFA', d(1), d(4), 'V-01', { guest_name: 'Asha Rao', unit: '12 Wing', service_number: '29482-K', phone: '98' });
    await book('PI', d(2), d(5), 'S-01', { guest_name: 'Ravi Kumar', unit: '3 Wing' });
    const cancelled = await book('LEAVE', d(1), d(3), 'N-01', { guest_name: 'Gone Away', unit: '12 Wing' });
    await signInAs('admin');
    const { error } = await holder.sb.rpc('cancel_booking', { p_id: cancelled, p_reason_enc: 'enc:x' });
    expect(error, error?.message).toBeNull();
    await signInAs('clerk');

    const rows = await fetchGuestReportRows({ today, rooms: await reportRooms() });
    expect(rows.map((r) => [r.name, r.status]).sort()).toEqual([
      ['Asha Rao', 'UPCOMING'],
      ['Gone Away', 'CANCELLED'],
      ['Ravi Kumar', 'UPCOMING'],
    ]);
    expect(rows.find((r) => r.name === 'Asha Rao')).toMatchObject({
      rank: 'Wing Commander',
      unit: '12 Wing',
      serviceNumber: '29482-K',
      phone: '98',
      room: 'V-01',
      bed: 1,
      roomType: 'VIP',
      category: 'MFA',
    });

    // "In VIP rooms on day 2" and "everyone from 12 Wing, not cancelled".
    const day = d(2);
    const onDay = await fetchGuestReportRows({ today, from: day, toExclusive: d(3), rooms: await reportRooms(), day });
    expect(filterGuestReportRows(onDay, { period: { mode: 'day', day }, roomTypes: ['VIP'] }).map((r) => r.name)).toEqual([
      'Asha Rao',
    ]);
    expect(
      filterGuestReportRows(rows, { period: { mode: 'all' }, unit: '12 wing', statuses: ['UPCOMING', 'CURRENT', 'COMPLETED'] }).map(
        (r) => r.name,
      ),
    ).toEqual(['Asha Rao']);
  });

  it('only fetches bookings overlapping the window', async () => {
    await book('MFA', d(1), d(3), 'V-01', { guest_name: 'Early' });
    await book('MFA', d(10), d(12), 'V-01', { guest_name: 'Late' });
    const rows = await fetchGuestReportRows({ today, from: d(9), toExclusive: d(11), rooms: await reportRooms() });
    expect(rows.map((r) => r.name)).toEqual(['Late']);
  });
});
