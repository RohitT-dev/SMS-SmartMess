import { describe, expect, it } from 'vitest';
import { enrichDayStates, enrichOccupant, idsKey, occupantBookingIds, type GridGuestRow } from './gridGuests';
import { buildPastBookingItems } from './pastBookingItems';
import { buildPastBookingsReport } from './pastBookingsHtml';
import { buildGridReport } from './gridHtml';

const guest = (over: Partial<GridGuestRow> = {}): GridGuestRow => ({
  id: 'g1',
  booking_id: 'b1',
  seq: 1,
  guest_code: 'GST-0001',
  guest_name: 'Rohit Tiwari',
  unit: '12 Wing',
  service_number: '24567-K',
  rank_code: 'FLT_LT',
  relation: 'PRIMARY',
  ...over,
});

describe('grid guest enrichment', () => {
  it('attaches real name, full rank, unit and service number by guest code', () => {
    const states = [
      {
        room_id: 'r1',
        date: '2026-10-01',
        beds_taken: 1,
        is_closed: false,
        occupants: [{ bookingId: 'b1', guestCode: 'GST-0001', rankCode: 'FLT_LT', category: 'MFA', allowSharing: false }],
      },
    ];
    const [out] = enrichDayStates(states, [guest()]);
    expect(out.occupants?.[0]).toMatchObject({
      guestName: 'Rohit Tiwari',
      rankText: 'Flight Lieutenant',
      unit: '12 Wing',
      serviceNumber: '24567-K',
      allowSharing: false,
    });
  });

  it('uses decrypted PII only when the plain name is missing and never invents a "Guest (GST-...)" label', () => {
    const byCode = new Map([['GST-0001', guest({ guest_name: null })]]);
    const pii = new Map([['g1', { name: 'Decrypted Name' }]]);
    expect(enrichOccupant({ guestCode: 'GST-0001' }, byCode, pii).guestName).toBe('Decrypted Name');
    expect(enrichOccupant({ guestCode: 'GST-0001' }, byCode).guestName).toBeUndefined();
  });

  it('shows the relation for civilians and leaves unknown occupants untouched', () => {
    const civ = guest({ id: 'g2', guest_code: 'GST-0002', rank_code: null, relation: 'SPOUSE', guest_name: 'Mrs A' });
    const byCode = new Map([['GST-0002', civ]]);
    expect(enrichOccupant({ guestCode: 'GST-0002' }, byCode).rankText).toBe('Spouse');
    const stranger = { guestCode: 'GST-9999' };
    expect(enrichOccupant(stranger, byCode)).toBe(stranger);
  });

  it('collects distinct booking ids and a stable cache key', () => {
    const states = [
      { room_id: 'r1', date: 'd', beds_taken: 2, is_closed: false, occupants: [{ bookingId: 'b2' }, { bookingId: 'b1' }] },
      { room_id: 'r2', date: 'd', beds_taken: 1, is_closed: false, occupants: [{ bookingId: 'b1' }] },
    ];
    expect(occupantBookingIds(states)).toEqual(['b1', 'b2']);
    expect(idsKey(['b1', 'b2'])).toBe(idsKey(['b1', 'b2']));
    expect(idsKey(['b1', 'b2'])).not.toBe(idsKey(['b1', 'b3']));
  });

  it('flows through to the grid PDF', () => {
    const states = enrichDayStates(
      [{ room_id: 'r1', date: '2026-10-01', beds_taken: 1, is_closed: false, occupants: [{ guestCode: 'GST-0001', category: 'MFA' }] }],
      [guest()],
    );
    const doc = buildGridReport({
      fromDate: '2026-10-01',
      toDate: '2026-10-01',
      rooms: [{ id: 'r1', name: 'Room 1', roomType: 'VIP', displayOrder: 1 }],
      dayStates: states,
    });
    expect(doc.html).toContain('Rohit Tiwari');
    expect(doc.html).toContain('Flight Lieutenant');
    expect(doc.html).toContain('12 Wing');
    expect(doc.html).not.toContain('GST-0001');
  });
});

describe('past booking items', () => {
  const raw = [
    {
      id: 'bk-1234567890',
      category: 'MFA',
      status: 'COMPLETED',
      check_in: '2026-10-01',
      check_out: '2026-10-04',
      party_size: 2,
      booking_guests: [
        { id: 'g2', seq: 2, guest_name: 'Mrs Tiwari', rank_code: null, relation: 'SPOUSE', guest_code: 'GST-0002' },
        { id: 'g1', seq: 1, guest_name: 'Rohit Tiwari', rank_code: 'WG_CDR', relation: 'PRIMARY', unit: '12 Wing', service_number: '24567-K', guest_code: 'GST-0001' },
      ],
      allocations: [
        { room_id: 'room-aaaa', guest_id: 'g1', bed_slot: 1, status: 'RELEASED' },
        { room_id: 'room-aaaa', guest_id: 'g2', bed_slot: 2, status: 'RELEASED' },
        { room_id: 'room-bbbb', guest_id: 'g1', bed_slot: 1, status: 'CANCELLED' },
      ],
    },
  ];
  const items = buildPastBookingItems(raw, { roomNames: { 'room-aaaa': 'Room V-01' } });

  it('lists every guest in seat order with full rank / relation, unit and service number', () => {
    expect(items).toHaveLength(1);
    const [b] = items;
    expect(b.nights).toBe(3);
    expect(b.guestName).toBe('Rohit Tiwari');
    expect(b.guestRank).toBe('Wing Commander');
    expect(b.unit).toBe('12 Wing');
    expect(b.serviceNumber).toBe('24567-K');
    expect(b.guests?.map((g) => [g.name, g.rank])).toEqual([
      ['Rohit Tiwari', 'Wing Commander'],
      ['Mrs Tiwari', 'Spouse'],
    ]);
  });

  it('gives each guest their own room and ignores cancelled allocations', () => {
    const [b] = items;
    expect(b.guests?.[0].rooms).toBe('Room V-01 (Bed 1)');
    expect(b.guests?.[1].rooms).toBe('Room V-01 (Bed 2)');
    expect(b.rooms).toBe('Room V-01 (Bed 1), Room V-01 (Bed 2)');
  });

  it('falls back to the PII name and then to the guest code label', () => {
    const noName = [{ ...raw[0], booking_guests: [{ id: 'g9', seq: 1, rank_code: 'AM', guest_code: 'GST-0009' }], allocations: [] }];
    const withPii = buildPastBookingItems(noName, { piiByGuestId: new Map([['g9', { name: 'Decrypted Name' }]]) });
    expect(withPii[0].guestName).toBe('Decrypted Name');
    expect(buildPastBookingItems(noName)[0].guestName).toBe('Guest (GST-0009)');
    expect(withPii[0].rooms).toBe('None');
  });

  it('renders into the register', () => {
    const doc = buildPastBookingsReport({ bookings: items });
    expect(doc.html).toContain('Rohit Tiwari');
    expect(doc.html).toContain('Mrs Tiwari');
    expect(doc.html).toContain('Spouse');
    expect(doc.html).toContain('Wing Commander');
  });
});
