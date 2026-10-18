import { create } from 'zustand';
import {
  CivilianPiiSchema,
  RELATION_LABELS,
  getRank,
  type GuestDemand,
  type GuestRelation,
  type RankCode,
} from '@sms/core';
import { supabase } from '../../lib/supabase';
import { encryptGuestPii, getActiveKeyVersion } from '../crypto-session/cryptoSession';

/** Short label for one person in a party: rank (or relation for civilians) and gender. */
export function describeGuest(g: {
  gender: string;
  rankCode?: RankCode | string | null;
  relation?: GuestRelation | string | null;
}): string {
  const gender = g.gender === 'F' ? 'Female' : 'Male';
  if (g.rankCode) {
    const role = g.relation === 'PRIMARY' ? ' · Primary' : '';
    let rank = String(g.rankCode);
    try {
      rank = getRank(g.rankCode as RankCode).label;
    } catch {
      // unknown code: show it as is
    }
    return `${rank}${role} • ${gender}`;
  }
  const relation = RELATION_LABELS[(g.relation as GuestRelation) ?? 'OTHER'] ?? 'Civilian';
  return `${relation} (civilian) • ${gender}`;
}

/** Name and optional contact typed for a civilian on the New Booking screen. */
export interface CivilianDetails {
  name: string;
  phone: string;
}

/**
 * Civilian names and phone numbers for the booking being drafted, keyed by guest index.
 * Kept in memory only: the placement and eviction screens receive the party through route params
 * (which become the URL on web), so personal details must not travel with them.
 */
interface PartyDetailsState {
  details: Record<number, CivilianDetails>;
  setDetails: (details: Record<number, CivilianDetails>) => void;
  clear: () => void;
}

export const usePartyDetailsStore = create<PartyDetailsState>((set) => ({
  details: {},
  setDetails: (details) => set({ details }),
  clear: () => set({ details: {} }),
}));

/**
 * After create_booking succeeds: encrypt and store the civilians' names/contacts that were typed
 * on the New Booking screen. Best effort: the booking already exists, and anything not saved here
 * can still be entered from Guest Details. Returns how many guests could not be saved.
 */
export async function saveCivilianDetails(bookingId: string, guests: GuestDemand[]): Promise<number> {
  const { details, clear } = usePartyDetailsStore.getState();
  const wanted = guests
    .map((g, idx) => ({ idx, g, d: details[idx] }))
    .filter((x) => !x.g.rankCode && x.d?.name?.trim());
  if (wanted.length === 0) {
    clear();
    return 0;
  }

  const { data: rows, error } = await supabase
    .from('booking_guests')
    .select('id, seq')
    .eq('booking_id', bookingId);
  if (error || !rows) return wanted.length;
  const idBySeq = new Map((rows as Array<{ id: string; seq: number }>).map((r) => [r.seq, r.id]));

  let failed = 0;
  for (const { idx, d } of wanted) {
    const guestId = idBySeq.get(idx + 1);
    const parsed = CivilianPiiSchema.safeParse({ name: d!.name, phone: d!.phone });
    if (!guestId || !parsed.success) {
      failed++;
      continue;
    }
    try {
      const { error: rpcError } = await supabase.rpc('set_guest_pii', {
        p_guest_id: guestId,
        p_pii_enc: encryptGuestPii(guestId, parsed.data),
        p_blind: null,
        p_key_version: getActiveKeyVersion(),
      });
      if (rpcError) failed++;
    } catch {
      failed++;
    }
  }
  clear();
  return failed;
}
