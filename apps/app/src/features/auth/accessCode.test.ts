import { describe, it, expect } from 'vitest';
import { argon2idKdf, getRandomBytes, unwrapPrivateKey, wrapPrivateKey } from '@sms/crypto';
import { parseValidUntil } from './accessCode';

// Mirrors wrapTeamKeyForCode/unlockWithAccessCode in cryptoSession.ts.
const PARAMS = { m: 19456, t: 2, p: 1 };

describe('access code', () => {
  it('parses blank valid-until as no expiry', () => {
    expect(parseValidUntil('  ')).toBeNull();
  });

  it('parses a future date to the end of that local day', () => {
    const next = new Date();
    next.setFullYear(next.getFullYear() + 1);
    const ymd = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    const iso = parseValidUntil(ymd)!;
    const parsed = new Date(iso);
    expect(parsed.getHours()).toBe(23);
    expect(parsed.getMinutes()).toBe(59);
  });

  it('rejects past, malformed and impossible dates', () => {
    expect(() => parseValidUntil('2000-01-01')).toThrow(/future/);
    expect(() => parseValidUntil('01/02/2030')).toThrow(/YYYY-MM-DD/);
    expect(() => parseValidUntil('2030-02-31')).toThrow(/real date/);
  });

  it('team key wrapped under a 6-digit code unwraps only with that code', () => {
    const teamKey = getRandomBytes(32);
    const salt = getRandomBytes(16);
    const wrap = wrapPrivateKey(teamKey, argon2idKdf('482913', salt, PARAMS, 32));

    expect(unwrapPrivateKey(wrap, argon2idKdf('482913', salt, PARAMS, 32))).toEqual(teamKey);
    expect(() => unwrapPrivateKey(wrap, argon2idKdf('482914', salt, PARAMS, 32))).toThrow();
  });
});
