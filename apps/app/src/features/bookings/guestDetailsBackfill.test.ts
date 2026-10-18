import { beforeEach, describe, expect, it } from 'vitest';
import { createDevSupabase, DEV_USERS, messToday } from '../../dev/devBackend';
import { addDaysToDateString } from '../../lib/dates';
import {
  buildFillRow,
  chunk,
  runGuestDetailsBackfill,
  selectBackfillCandidates,
  type PlainGuestFields,
} from './guestDetailsBackfill';
import { PLACEHOLDER_GUEST_NAME, plainDetailsRpcArgs, savePlainGuestDetails } from './plainGuestDetails';

describe('selectBackfillCandidates / buildFillRow', () => {
  const full = { id: 'a', details: 'COMPLETE', guest_name: 'A', unit: 'U', service_number: 'S', phone: 'P' };
  const noName = { id: 'b', details: 'COMPLETE', guest_name: null, unit: 'U', service_number: 'S', phone: 'P' };
  const noUnit = { id: 'c', details: 'COMPLETE', guest_name: 'C', unit: ' ', service_number: 'S', phone: 'P' };
  const pending = { id: 'd', details: 'PENDING', guest_name: null };
  const standIn = { ...full, id: 'e', guest_name: PLACEHOLDER_GUEST_NAME };

  it('picks guests with saved details that miss a plain field', () => {
    expect(selectBackfillCandidates([full, noName, noUnit, pending, standIn]).map((g) => g.id)).toEqual(['b', 'c', 'e']);
  });

  it('replaces the stand-in name with the real one', () => {
    expect(buildFillRow(standIn, { name: 'Vikram Roy' })).toEqual({ guest_id: 'e', guest_name: 'Vikram Roy' });
    expect(buildFillRow(standIn, { name: PLACEHOLDER_GUEST_NAME })).toBeNull();
  });

  it('fills only empty fields, trimmed, and never overwrites a stored value', () => {
    const pii: PlainGuestFields = { name: ' Vikram Roy ', unit: 'Other Unit', serviceNumber: ' 31092-B', phone: '' };
    expect(buildFillRow({ id: 'x', guest_name: null, unit: 'Stored Unit', service_number: null, phone: null }, pii)).toEqual({
      guest_id: 'x',
      guest_name: 'Vikram Roy',
      service_number: '31092-B',
    });
  });

  it('returns null when there is nothing to add, and ignores the stand-in name', () => {
    expect(buildFillRow({ id: 'x', guest_name: 'Kept' }, { name: 'Other' })).toBeNull();
    expect(buildFillRow({ id: 'x', guest_name: null }, { name: PLACEHOLDER_GUEST_NAME })).toBeNull();
    expect(buildFillRow({ id: 'x' }, null)).toBeNull();
  });

  it('chunks rows', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('plainDetailsRpcArgs', () => {
  it('sends null for missing values, trims, and never stores the stand-in name', () => {
    expect(plainDetailsRpcArgs('g', { name: ' Asha Rao ', unit: undefined, serviceNumber: null, phone: ' 99 ' })).toEqual({
      p_guest_id: 'g',
      p_guest_name: 'Asha Rao',
      p_unit: null,
      p_service_number: null,
      p_phone: '99',
    });
    expect(plainDetailsRpcArgs('g', { name: PLACEHOLDER_GUEST_NAME }).p_guest_name).toBeNull();
    // A blank string clears the column on the server.
    expect(plainDetailsRpcArgs('g', { unit: '  ' }).p_unit).toBe('');
  });
});

// ---- against the dev backend, which mirrors the RPC rules of migration 0030 ----

type Sb = ReturnType<typeof createDevSupabase> & { auth: any };
const today = messToday();
const d = (n: number) => addDaysToDateString(today, n);
let sb: Sb;

const signInAs = (key: 'admin' | 'clerk') => sb.auth.signInWithPassword({ email: DEV_USERS[key].email });

/** The fake "ciphertext" the stub decrypter reads: the JSON itself. */
const fakeCipher = (pii: Record<string, unknown>) => `enc:${JSON.stringify(pii)}`;
const fakeDecrypt = (_id: string, enc: string): PlainGuestFields => JSON.parse(enc.slice(4));

async function guestsOf(bookingId: string) {
  const { data, error } = await sb.from('booking_guests').select('*').eq('booking_id', bookingId).order('seq');
  expect(error).toBeNull();
  return data as any[];
}

beforeEach(async () => {
  sb = createDevSupabase('mock') as Sb;
  await signInAs('clerk');
});

describe('plain guest details through the RPC', () => {
  async function bookingWithGuests(guests: any[]) {
    const { data, error } = await sb.rpc('create_booking_request', {
      p_booking: { category: 'MFA', check_in: d(2), check_out: d(4), party_size: guests.length, is_suite_booking: false },
      p_guests: guests,
    });
    expect(error).toBeNull();
    return data as string;
  }

  it('writes name, unit, service number and phone, and reports success', async () => {
    const id = await bookingWithGuests([{ seq: 1, gender: 'M', rank_code: 'FLT_LT' }]);
    const [g] = await guestsOf(id);
    const res = await savePlainGuestDetails(sb, g.id, { name: 'Asha Rao', unit: '12 Wing', serviceNumber: '29482-K', phone: '9876543210' });
    expect(res).toEqual({ ok: true });
    const [after] = await guestsOf(id);
    expect(after).toMatchObject({ guest_name: 'Asha Rao', unit: '12 Wing', service_number: '29482-K', phone: '9876543210' });
  });

  it('leaves columns alone for missing values and clears them for blank strings', async () => {
    const id = await bookingWithGuests([
      { seq: 1, gender: 'M', rank_code: 'FLT_LT', guest_name: 'Asha Rao', unit: '12 Wing', service_number: '1', phone: '2' },
    ]);
    const [g] = await guestsOf(id);
    await savePlainGuestDetails(sb, g.id, { name: 'Asha R. Rao' });
    expect((await guestsOf(id))[0]).toMatchObject({ guest_name: 'Asha R. Rao', unit: '12 Wing', service_number: '1', phone: '2' });
    await savePlainGuestDetails(sb, g.id, { unit: '' });
    expect((await guestsOf(id))[0]).toMatchObject({ guest_name: 'Asha R. Rao', unit: null });
  });

  it('surfaces failures instead of swallowing them', async () => {
    const missing = await savePlainGuestDetails(sb, '00000000-0000-4000-8000-000000000999', { name: 'Nobody' });
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain('ERR_NOT_FOUND');

    // Clerk without enter_guest_details.
    await signInAs('admin');
    await sb.rpc('set_user_permissions', { p_user_id: DEV_USERS.clerk.id, p_permissions: ['create_booking'] });
    await signInAs('clerk');
    const id = await bookingWithGuests([{ seq: 1, gender: 'M', rank_code: 'FO' }]);
    const [g] = await guestsOf(id);
    const denied = await savePlainGuestDetails(sb, g.id, { name: 'Asha Rao' });
    expect(denied.ok).toBe(false);
    expect(denied.message).toContain('ERR_PERMISSION');
  });

  it('cannot be bypassed with a direct table update, as in the real database', async () => {
    const id = await bookingWithGuests([{ seq: 1, gender: 'M', rank_code: 'FO' }]);
    const [g] = await guestsOf(id);
    const { error } = await (sb.from('booking_guests') as any).update({ guest_name: 'Sneaky' }).eq('id', g.id);
    expect(error).not.toBeNull();
    expect((await guestsOf(id))[0].guest_name).toBeNull();
  });

  describe('backfill from the encrypted records', () => {
    async function seed() {
      await signInAs('clerk');
      const bookingId = await bookingWithGuests([
        { seq: 1, gender: 'M', rank_code: 'WG_CDR' }, // details only in the encrypted record
        { seq: 2, gender: 'F', rank_code: null, relation: 'SPOUSE', guest_name: 'Kept Name' }, // has a name, lacks the phone
        { seq: 3, gender: 'M', rank_code: 'FO' }, // details never entered
      ]);
      const [g1, g2, g3] = await guestsOf(bookingId);
      const put = (id: string, pii: Record<string, unknown>) =>
        sb.rpc('set_guest_pii', { p_guest_id: id, p_pii_enc: fakeCipher(pii), p_blind: null, p_key_version: 1 });
      expect((await put(g1.id, { name: 'Vikram Roy', unit: '17 Sqn', serviceNumber: '31092-B', phone: '9988776655', idNumber: '1234 5678 9012' })).error).toBeNull();
      expect((await put(g2.id, { name: 'Different Name', phone: '9000000000' })).error).toBeNull();
      return { bookingId, g1, g2, g3 };
    }

    it('copies the readable fields once, never overwrites, never copies the ID number', async () => {
      const { bookingId } = await seed();
      await signInAs('admin');
      const result = await runGuestDetailsBackfill({ client: sb as any, keyVersion: 1, decrypt: fakeDecrypt });
      expect(result).toEqual({ candidates: 2, filled: 2, failed: 0 });

      const [g1, g2, g3] = await guestsOf(bookingId);
      expect(g1).toMatchObject({ guest_name: 'Vikram Roy', unit: '17 Sqn', service_number: '31092-B', phone: '9988776655' });
      expect(g2).toMatchObject({ guest_name: 'Kept Name', phone: '9000000000' });
      expect(g3.guest_name).toBeNull();
      expect(JSON.stringify(g1)).not.toContain('1234 5678');

      // A second run finds the same candidates (g2 still has no unit) but has nothing left to fill.
      const again = await runGuestDetailsBackfill({ client: sb as any, keyVersion: 1, decrypt: fakeDecrypt });
      expect(again.filled).toBe(0);
    });

    it('counts records it cannot decrypt and keeps going', async () => {
      const { bookingId } = await seed();
      await signInAs('admin');
      const flaky = (id: string, enc: string) => {
        if (enc.includes('Vikram')) throw new Error('wrong key');
        return fakeDecrypt(id, enc);
      };
      const result = await runGuestDetailsBackfill({ client: sb as any, keyVersion: 1, decrypt: flaky });
      expect(result).toEqual({ candidates: 2, filled: 1, failed: 1 });
      expect((await guestsOf(bookingId))[0].guest_name).toBeNull();
    });

    it('is refused for anyone but an administrator', async () => {
      await seed();
      await signInAs('clerk');
      await expect(runGuestDetailsBackfill({ client: sb as any, keyVersion: 1, decrypt: fakeDecrypt })).rejects.toThrow();
    });
  });
});
