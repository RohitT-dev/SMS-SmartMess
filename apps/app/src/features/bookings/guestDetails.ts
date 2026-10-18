import { supabase } from '../../lib/supabase';
import {
  encryptGuestPii,
  computeIdBlindIndex,
  getActiveKeyVersion,
} from '../crypto-session/cryptoSession';
import { PLACEHOLDER_GUEST_NAME, savePlainGuestDetails } from './plainGuestDetails';

export interface GuestInputDetails {
  name?: string | null;
  serviceNumber?: string | null;
  unit?: string | null;
  phone?: string | null;
  idNumber?: string | null;
  idType?: string | null;
  notes?: string | null;
}

export interface GuestDetailsSaveResult {
  /** Name, unit, service number and phone are stored as readable columns (what every screen shows). */
  plainSaved: boolean;
  /** The encrypted record (ID number, remarks and a copy of the above) was stored. */
  encryptedSaved: boolean;
  /** Raw messages of whatever failed; screens pass them through userErrorMessage. */
  errors: string[];
}

/**
 * Persists guest details through the two channels the database offers:
 * 1. set_booking_guest_details RPC: name, unit, service number, phone as readable columns.
 *    (booking_guests has no direct UPDATE grant, so this RPC is the only way to write them.)
 * 2. set_guest_pii RPC: the encrypted record, with client-side AES-256-GCM encryption and an
 *    ID-number blind index. ID numbers and remarks exist only here, never as plain columns.
 *
 * Never throws; check the result. Failures are also reported to the console without any values.
 */
export async function persistGuestDetails(
  guestId: string,
  details: GuestInputDetails,
): Promise<GuestDetailsSaveResult> {
  const result: GuestDetailsSaveResult = { plainSaved: false, encryptedSaved: false, errors: [] };
  if (!guestId) return result;

  const resolvedName = details.name?.trim() || PLACEHOLDER_GUEST_NAME;
  const resolvedServiceNo = details.serviceNumber?.trim() || null;
  const resolvedUnit = details.unit?.trim() || null;
  const resolvedPhone = details.phone?.trim() || null;
  const resolvedIdNumber = details.idNumber?.trim() || null;
  const resolvedIdType = details.idType?.trim() || null;
  const resolvedNotes = details.notes?.trim() || null;

  // Channel 1: readable columns.
  const plain = await savePlainGuestDetails(supabase, guestId, {
    name: details.name?.trim() || null,
    unit: resolvedUnit,
    serviceNumber: resolvedServiceNo,
    phone: resolvedPhone,
  });
  result.plainSaved = plain.ok;
  if (!plain.ok) {
    result.errors.push(plain.message ?? 'Could not save guest details');
    console.warn('set_booking_guest_details failed:', plain.message);
  }

  // Channel 2: encrypted record.
  try {
    const cipherEnc = encryptGuestPii(guestId, {
      name: resolvedName,
      phone: resolvedPhone || '',
      serviceNumber: resolvedServiceNo,
      unit: resolvedUnit,
      idNumber: resolvedIdNumber,
      idType: resolvedIdType,
      notes: resolvedNotes,
    });
    const blindIndex = resolvedIdNumber
      ? computeIdBlindIndex(resolvedIdNumber)
      : computeIdBlindIndex(`NO_ID_${guestId}`);

    const { error: piiRpcErr } = await supabase.rpc('set_guest_pii', {
      p_guest_id: guestId,
      p_pii_enc: cipherEnc,
      p_blind: blindIndex,
      p_key_version: getActiveKeyVersion(),
    });
    if (piiRpcErr) {
      result.errors.push(piiRpcErr.message || 'Could not save encrypted guest record');
      console.warn('set_guest_pii failed:', piiRpcErr.message);
    } else {
      result.encryptedSaved = true;
    }
  } catch (piiErr) {
    result.errors.push(piiErr instanceof Error ? piiErr.message : 'Could not encrypt guest record');
    console.warn('Could not encrypt guest PII');
  }

  return result;
}
