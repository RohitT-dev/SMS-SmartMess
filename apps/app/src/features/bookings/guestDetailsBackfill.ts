/**
 * One-time backfill of the plain guest columns (guest_name, unit, service_number, phone).
 *
 * Guests whose details were entered before those columns were written (or before the
 * set_booking_guest_details RPC existed) have their name only inside the encrypted guest_pii blob.
 * A signed-in administrator's unlocked session decrypts those blobs and copies the four plain
 * fields into booking_guests, once, so every screen can show names, full ranks and units without
 * decrypting anything. ID numbers and remarks are never copied: they stay encrypted.
 *
 * The functions below are pure or take their collaborators as arguments so they can be tested
 * without a device, a database or a key; useGuestDetailsBackfill wires them to the real ones.
 */

import { realGuestName } from './guestDisplay';

export interface GuestDetailRow {
  id: string;
  guest_name?: string | null;
  unit?: string | null;
  service_number?: string | null;
  phone?: string | null;
  details?: string | null;
}

/** The plain fields of a decrypted record; nothing else is ever read from it. */
export interface PlainGuestFields {
  name?: string | null;
  unit?: string | null;
  serviceNumber?: string | null;
  phone?: string | null;
}

export interface FillRow {
  guest_id: string;
  guest_name?: string;
  unit?: string;
  service_number?: string;
  phone?: string;
}

export interface BackfillResult {
  /** Guests with saved details that miss at least one plain field. */
  candidates: number;
  /** Guests that received at least one value. */
  filled: number;
  /** Guests whose record could not be read or whose write failed. */
  failed: number;
}

/** Rows per set_booking_guest_details_batch call (the RPC accepts 200). */
export const BACKFILL_BATCH_SIZE = 100;
const PII_PAGE_SIZE = 500;
const GUEST_PAGE_SIZE = 1000;
const MAX_PAGES = 50;

const blank = (v: string | null | undefined) => !v || !v.trim();
/** A name column is as good as empty when it holds the "Officer / Guest" stand-in. */
const nameMissing = (v: string | null | undefined) => !realGuestName(v);

/** Guests that have saved details but are missing any of the four plain fields. */
export function selectBackfillCandidates<T extends GuestDetailRow>(rows: readonly T[]): T[] {
  return rows.filter(
    (g) =>
      g.details === 'COMPLETE' &&
      (nameMissing(g.guest_name) || blank(g.unit) || blank(g.service_number) || blank(g.phone)),
  );
}

/** Only the fields that are empty on the row and known from the decrypted record. */
export function buildFillRow(guest: GuestDetailRow, pii: PlainGuestFields | null | undefined): FillRow | null {
  if (!pii) return null;
  const row: FillRow = { guest_id: guest.id };
  let any = false;
  const take = (
    current: string | null | undefined,
    next: string | null | undefined,
    key: keyof Omit<FillRow, 'guest_id'>,
    isMissing: (v: string | null | undefined) => boolean = blank,
  ) => {
    const value = next?.trim();
    if (isMissing(current) && value) {
      row[key] = value;
      any = true;
    }
  };
  // The stand-in name saved when none was entered is not a name, on either side.
  take(guest.guest_name, realGuestName(pii.name), 'guest_name', nameMissing);
  take(guest.unit, pii.unit, 'unit');
  take(guest.service_number, pii.serviceNumber, 'service_number');
  take(guest.phone, pii.phone, 'phone');
  return any ? row : null;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The two Supabase calls the backfill needs; the real client and the dev client both satisfy it. */
export interface BackfillClient {
  from: (table: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: any; error: { message?: string } | null }>;
}

export interface BackfillDeps {
  client: BackfillClient;
  /** Key version the unlocked session decrypts; older ciphertexts need a key rotation first. */
  keyVersion: number;
  /** Decrypts one guest_pii ciphertext into its plain fields; throws when it cannot. */
  decrypt: (guestId: string, piiEnc: string) => PlainGuestFields;
}

async function loadGuestRows(client: BackfillClient): Promise<GuestDetailRow[]> {
  const rows: GuestDetailRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client
      .from('booking_guests')
      .select('id, guest_name, unit, service_number, phone, details')
      .eq('details', 'COMPLETE')
      .order('id')
      .range(page * GUEST_PAGE_SIZE, (page + 1) * GUEST_PAGE_SIZE - 1);
    if (error) throw new Error('Could not read guests');
    rows.push(...((data ?? []) as GuestDetailRow[]));
    if (!data || data.length < GUEST_PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Runs the backfill for an administrator. Best effort: a record that cannot be decrypted or a batch
 * that fails is counted and skipped; nothing is thrown for individual records, and no personal
 * value is ever logged or returned.
 */
export async function runGuestDetailsBackfill({ client, keyVersion, decrypt }: BackfillDeps): Promise<BackfillResult> {
  const result: BackfillResult = { candidates: 0, filled: 0, failed: 0 };

  const candidates = selectBackfillCandidates(await loadGuestRows(client));
  result.candidates = candidates.length;
  if (candidates.length === 0) return result;
  const byId = new Map(candidates.map((g) => [g.id, g]));

  const fills: FillRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client.rpc('admin_page_guest_pii', {
      p_key_version: keyVersion,
      p_after_guest_id: after,
      p_limit: PII_PAGE_SIZE,
    });
    if (error) throw new Error('Could not read encrypted guest records');
    const pageRows = (data ?? []) as Array<{ guest_id: string; pii_enc: string }>;
    for (const r of pageRows) {
      const guest = byId.get(r.guest_id);
      if (!guest || !r.pii_enc) continue;
      try {
        const fill = buildFillRow(guest, decrypt(r.guest_id, r.pii_enc));
        if (fill) fills.push(fill);
      } catch {
        result.failed++;
      }
    }
    if (pageRows.length < PII_PAGE_SIZE) break;
    after = pageRows[pageRows.length - 1].guest_id;
  }

  for (const batch of chunk(fills, BACKFILL_BATCH_SIZE)) {
    const { error } = await client.rpc('set_booking_guest_details_batch', { p_rows: batch });
    if (error) result.failed += batch.length;
    else result.filled += batch.length;
  }
  return result;
}
