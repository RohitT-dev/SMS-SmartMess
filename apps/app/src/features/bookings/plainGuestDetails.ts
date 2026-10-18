/**
 * Plain (readable) guest details: name, unit, service number and phone live as ordinary columns on
 * booking_guests. The table is read-only for the app's role (writes go through RPCs, 0006/0016), so
 * the only way to store them after a booking exists is the set_booking_guest_details RPC (0030).
 * ID numbers and remarks are NOT stored here; they stay in the encrypted guest_pii record.
 */

/** Name the encrypted record carries when no name was entered. It must never be shown as a real name. */
export const PLACEHOLDER_GUEST_NAME = 'Officer / Guest';

export interface PlainGuestInput {
  name?: string | null;
  unit?: string | null;
  serviceNumber?: string | null;
  phone?: string | null;
}

/**
 * RPC arguments. A missing value is sent as null, which the server reads as "leave this column
 * alone"; a blank string clears the column. The placeholder is never stored as a name.
 */
export function plainDetailsRpcArgs(guestId: string, d: PlainGuestInput): Record<string, unknown> {
  const val = (v: string | null | undefined) => (v == null ? null : v.trim());
  const name = val(d.name);
  return {
    p_guest_id: guestId,
    p_guest_name: name === PLACEHOLDER_GUEST_NAME ? null : name,
    p_unit: val(d.unit),
    p_service_number: val(d.serviceNumber),
    p_phone: val(d.phone),
  };
}

export interface PlainSaveResult {
  ok: boolean;
  /** Raw server/network message; screens pass it through userErrorMessage. */
  message?: string;
}

interface RpcClient {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ error: { message?: string } | null }>;
}

/** Writes the plain columns through the RPC and reports failure instead of swallowing it. */
export async function savePlainGuestDetails(client: RpcClient, guestId: string, d: PlainGuestInput): Promise<PlainSaveResult> {
  try {
    const { error } = await client.rpc('set_booking_guest_details', plainDetailsRpcArgs(guestId, d));
    return error ? { ok: false, message: error.message || 'Could not save guest details' } : { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save guest details' };
  }
}
