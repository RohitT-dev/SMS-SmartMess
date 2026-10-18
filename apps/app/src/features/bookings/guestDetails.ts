import { supabase } from '../../lib/supabase';
import {
  encryptGuestPii,
  computeIdBlindIndex,
  getActiveKeyVersion,
} from '../crypto-session/cryptoSession';

export interface GuestInputDetails {
  name?: string | null;
  serviceNumber?: string | null;
  unit?: string | null;
  phone?: string | null;
  idNumber?: string | null;
  idType?: string | null;
  notes?: string | null;
}

/**
 * Persists guest details and encrypted PII across all redundant channels:
 * 1. set_booking_guest_details RPC (if available in schema)
 * 2. booking_guests table direct update (if permitted by RLS)
 * 3. set_guest_pii RPC with client-side AES-256-GCM encryption & blind indexing
 */
export async function persistGuestDetails(
  guestId: string,
  details: GuestInputDetails,
): Promise<void> {
  if (!guestId) return;

  const resolvedName = details.name?.trim() || 'Officer / Guest';
  const resolvedServiceNo = details.serviceNumber?.trim() || null;
  const resolvedUnit = details.unit?.trim() || null;
  const resolvedPhone = details.phone?.trim() || null;
  const resolvedIdNumber = details.idNumber?.trim() || null;
  const resolvedIdType = details.idType?.trim() || null;
  const resolvedNotes = details.notes?.trim() || null;

  // Channel A: set_booking_guest_details RPC
  try {
    await supabase.rpc('set_booking_guest_details', {
      p_guest_id: guestId,
      p_guest_name: resolvedName,
      p_unit: resolvedUnit,
      p_service_number: resolvedServiceNo,
      p_phone: resolvedPhone,
    });
  } catch {
    // Ignore if RPC not yet deployed
  }

  // Channel B: direct update on booking_guests
  try {
    await supabase
      .from('booking_guests')
      .update({
        guest_name: resolvedName,
        unit: resolvedUnit,
        service_number: resolvedServiceNo,
        phone: resolvedPhone,
        details: 'COMPLETE',
      })
      .eq('id', guestId);
  } catch {
    // Ignore if direct update restricted by RLS
  }

  // Channel C: Encrypted guest_pii via set_guest_pii RPC
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
      console.warn('set_guest_pii warning:', piiRpcErr);
    }
  } catch (piiErr) {
    console.warn('Could not encrypt guest PII:', piiErr);
  }
}
