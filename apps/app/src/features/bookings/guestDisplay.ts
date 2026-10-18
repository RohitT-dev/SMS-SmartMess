import { RELATION_LABELS, getRank, type GuestRelation, type RankCode } from '@sms/core';
import { PLACEHOLDER_GUEST_NAME } from './plainGuestDetails';

/** A booking_guests row as the app reads it, plus any decrypted PII for the same guest. */
export interface GuestLike {
  guest_name?: string | null;
  guest_code?: string | null;
  unit?: string | null;
  service_number?: string | null;
  phone?: string | null;
  rank_code?: RankCode | string | null;
  relation?: GuestRelation | string | null;
  seq?: number | null;
}

export interface GuestPiiLike {
  name?: string | null;
  unit?: string | null;
  serviceNumber?: string | null;
  phone?: string | null;
}

/** "FLT_LT" -> "Flight Lieutenant". Unknown codes are shown as given; null stays empty. */
export function rankLabel(code: RankCode | string | null | undefined): string {
  if (!code) return '';
  try {
    return getRank(code as RankCode).label;
  } catch {
    return String(code).replace(/_/g, ' ');
  }
}

/** A stored name, trimmed; empty for a missing one and for the "Officer / Guest" stand-in saved when none was typed. */
export function realGuestName(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? '';
  return trimmed === PLACEHOLDER_GUEST_NAME ? '' : trimmed;
}

/** Plain-text name: stored name, then decrypted name, then the guest code, then "Guest N". */
export function guestName(g: GuestLike, pii?: GuestPiiLike | null, index?: number): string {
  return (
    realGuestName(g.guest_name) ||
    realGuestName(pii?.name) ||
    (g.guest_code ? `Guest (${g.guest_code})` : `Guest ${(index ?? (g.seq ?? 1) - 1) + 1}`)
  );
}

export function guestUnit(g: GuestLike, pii?: GuestPiiLike | null): string {
  return g.unit?.trim() || pii?.unit?.trim() || '';
}

export function guestServiceNumber(g: GuestLike, pii?: GuestPiiLike | null): string {
  return g.service_number?.trim() || pii?.serviceNumber?.trim() || '';
}

export function guestPhone(g: GuestLike, pii?: GuestPiiLike | null): string {
  return g.phone?.trim() || pii?.phone?.trim() || '';
}

/** Full rank for ranked guests, the relation (e.g. "Spouse") for civilians. */
export function guestRankOrRelation(g: GuestLike): string {
  if (g.rank_code) return rankLabel(g.rank_code);
  return RELATION_LABELS[(g.relation as GuestRelation) ?? 'OTHER'] ?? 'Civilian';
}

/** One line for lists and reports: "Name · Flight Lieutenant · Unit". Empty parts are dropped. */
export function guestLine(g: GuestLike, pii?: GuestPiiLike | null, index?: number): string {
  return [guestName(g, pii, index), guestRankOrRelation(g), guestUnit(g, pii)].filter(Boolean).join(' · ');
}

/** True when a real name is stored (not the "Guest (GST-1053)" placeholder). */
export function guestHasName(g: GuestLike, pii?: GuestPiiLike | null): boolean {
  return Boolean(realGuestName(g.guest_name) || realGuestName(pii?.name));
}

/**
 * The line under a guest's name: "Flight Lieutenant · 12 Wing · No: 29482-K". Full rank (or the
 * relation for civilians), unit and service number; empty parts are dropped. Pass
 * `includeCode` to append the unique guest ID, `includePhone` to append the phone number.
 */
export function guestDetailLine(
  g: GuestLike,
  pii?: GuestPiiLike | null,
  opts: { includeCode?: boolean; includePhone?: boolean } = {},
): string {
  const sno = guestServiceNumber(g, pii);
  const phone = guestPhone(g, pii);
  return [
    guestRankOrRelation(g),
    guestUnit(g, pii),
    sno && `No: ${sno}`,
    opts.includePhone && phone && `Ph: ${phone}`,
    opts.includeCode && g.guest_code && `[${g.guest_code}]`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "Flight Lieutenant Asha Rao" for ranked guests, "Meera Sharma (Spouse)" for civilians. */
export function guestRankedName(g: GuestLike, pii?: GuestPiiLike | null, index?: number): string {
  const name = guestName(g, pii, index);
  return g.rank_code ? `${rankLabel(g.rank_code)} ${name}` : `${name} (${guestRankOrRelation(g)})`;
}
