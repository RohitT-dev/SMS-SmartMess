import { describe, expect, it } from 'vitest';
import {
  guestDetailLine,
  guestHasName,
  guestLine,
  guestName,
  guestRankedName,
  guestRankOrRelation,
  rankLabel,
  realGuestName,
} from './guestDisplay';

const officer = {
  guest_name: ' Asha Rao ',
  guest_code: 'GST-1053',
  rank_code: 'FLT_LT',
  relation: 'PRIMARY',
  unit: '12 Wing',
  service_number: '29482-K',
  phone: '99',
};
const spouse = { guest_name: 'Meera Rao', guest_code: 'GST-1054', rank_code: null, relation: 'SPOUSE', seq: 2 };

describe('guest display', () => {
  it('shows the full rank, never the code', () => {
    expect(rankLabel('FLT_LT')).toBe('Flight Lieutenant');
    expect(rankLabel('FO')).toBe('Flying Officer');
    expect(rankLabel(null)).toBe('');
    expect(guestRankOrRelation(officer)).toBe('Flight Lieutenant');
    expect(guestRankOrRelation(spouse)).toBe('Spouse');
  });

  it('uses the stored name, then the decrypted one, then a placeholder', () => {
    expect(guestName(officer)).toBe('Asha Rao');
    expect(guestName({ guest_code: 'GST-1', guest_name: null }, { name: 'From Blob' })).toBe('From Blob');
    expect(guestName({ guest_code: 'GST-1053' })).toBe('Guest (GST-1053)');
    expect(guestName({ seq: 3 })).toBe('Guest 3');
    expect(guestHasName(officer)).toBe(true);
    expect(guestHasName({ guest_code: 'GST-1053' })).toBe(false);
    // The stand-in saved when no name was typed is not a name.
    expect(realGuestName('Officer / Guest')).toBe('');
    expect(guestName({ guest_name: 'Officer / Guest', guest_code: 'GST-1053' })).toBe('Guest (GST-1053)');
    expect(guestHasName({ guest_name: 'Officer / Guest' })).toBe(false);
  });

  it('builds the name line and the detail line', () => {
    expect(guestLine(officer)).toBe('Asha Rao · Flight Lieutenant · 12 Wing');
    expect(guestRankedName(officer)).toBe('Flight Lieutenant Asha Rao');
    expect(guestRankedName(spouse)).toBe('Meera Rao (Spouse)');
    expect(guestDetailLine(officer)).toBe('Flight Lieutenant · 12 Wing · No: 29482-K');
    expect(guestDetailLine(officer, null, { includeCode: true, includePhone: true })).toBe(
      'Flight Lieutenant · 12 Wing · No: 29482-K · Ph: 99 · [GST-1053]',
    );
    expect(guestDetailLine(spouse)).toBe('Spouse');
  });
});
