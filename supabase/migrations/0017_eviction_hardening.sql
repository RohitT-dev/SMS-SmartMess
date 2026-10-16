-- 0017_eviction_hardening.sql
-- approve_eviction fixes found while testing booking permutations:
--
--  1. Category precedence is now enforced on the server. Previously only the client filtered
--     candidates, so any caller holding approve_eviction could displace an MSA booking (or a
--     PI booking by a LEAVE request) by calling the RPC directly. Rule (same as
--     canDisplace() in @sms/core): MSA may displace PI/LEAVE/TD, PI may displace LEAVE/TD,
--     nobody else displaces anyone.
--  2. Evicting one bed of a multi-bed booking no longer marks the whole booking DISPLACED
--     while its other beds stay ACTIVE. That left occupied beds attached to a booking the UI
--     cannot cancel (Cancel is only offered for CONFIRMED bookings), so they could never be
--     released. A booking is now DISPLACED only once none of its allocations is ACTIVE.

CREATE OR REPLACE FUNCTION public.approve_eviction(
  p_incoming JSONB,
  p_evict_allocation_ids UUID[],
  p_reason_enc TEXT,
  p_key_version INT,
  p_reason_aad_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_alloc_id UUID;
  v_displaced_booking_id UUID;
  v_displaced_category public.category;
  v_new_booking_id UUID;
  v_booking JSONB;
  v_guests JSONB;
  v_allocations JSONB;
  v_incoming_category public.category;
  v_beds JSONB := '[]'::JSONB;
  v_idx INT := 0;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('approve_eviction')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  IF p_reason_enc IS NULL OR length(trim(p_reason_enc)) < 10 THEN
    RAISE EXCEPTION 'Eviction reason must be at least 10 characters' USING errcode = 'P0001';
  END IF;

  IF p_reason_aad_id IS NULL THEN
    RAISE EXCEPTION 'ERR_MISSING_REASON_AAD_ID' USING errcode = 'P0001';
  END IF;

  IF p_evict_allocation_ids IS NULL OR array_length(p_evict_allocation_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'ERR_NO_EVICTIONS' USING errcode = 'P0001';
  END IF;

  v_booking := COALESCE(p_incoming->'booking', p_incoming - 'guests' - 'allocations');
  v_guests := COALESCE(p_incoming->'guests', '[]'::JSONB);
  v_allocations := p_incoming->'allocations';
  v_incoming_category := (v_booking->>'category')::public.category;

  -- 1. Evict (in the order given) and remember the freed beds
  FOREACH v_alloc_id IN ARRAY p_evict_allocation_ids LOOP
    SELECT a.booking_id, b.category INTO v_displaced_booking_id, v_displaced_category
    FROM public.allocations a
    JOIN public.bookings b ON b.id = a.booking_id
    WHERE a.id = v_alloc_id AND a.status = 'ACTIVE'
    FOR UPDATE OF a;

    IF v_displaced_booking_id IS NULL THEN
      RAISE EXCEPTION 'ERR_ALLOCATION_NOT_ACTIVE' USING errcode = 'P0001';
    END IF;

    IF NOT (
      (v_incoming_category = 'MSA' AND v_displaced_category IN ('PI', 'LEAVE', 'TD')) OR
      (v_incoming_category = 'PI' AND v_displaced_category IN ('LEAVE', 'TD'))
    ) THEN
      RAISE EXCEPTION 'ERR_CANNOT_EVICT: % cannot displace %', v_incoming_category, v_displaced_category
        USING errcode = 'P0001';
    END IF;

    v_beds := v_beds || (
      SELECT jsonb_build_object('room_id', a.room_id, 'bed_slot', a.bed_slot)
      FROM public.allocations a WHERE a.id = v_alloc_id
    );

    UPDATE public.allocations SET status = 'EVICTED' WHERE id = v_alloc_id;

    -- Only a booking with no remaining active bed is DISPLACED; otherwise it keeps its other
    -- beds and stays CONFIRMED (and cancellable).
    UPDATE public.bookings b
    SET status = 'DISPLACED'
    WHERE b.id = v_displaced_booking_id
      AND NOT EXISTS (
        SELECT 1 FROM public.allocations a2
        WHERE a2.booking_id = b.id AND a2.status = 'ACTIVE'
      );
  END LOOP;

  -- 2. Default seating: guest seq N -> Nth freed bed
  IF v_allocations IS NULL OR jsonb_array_length(v_allocations) = 0 THEN
    IF jsonb_array_length(v_beds) < jsonb_array_length(v_guests) THEN
      RAISE EXCEPTION 'ERR_NOT_ENOUGH_BEDS: select at least one bed per incoming guest' USING errcode = 'P0001';
    END IF;
    v_allocations := '[]'::JSONB;
    FOR v_idx IN 0 .. jsonb_array_length(v_guests) - 1 LOOP
      v_allocations := v_allocations || jsonb_build_object(
        'guest_seq', COALESCE((v_guests->v_idx->>'seq')::INT, v_idx + 1),
        'room_id', v_beds->v_idx->>'room_id',
        'bed_slot', (v_beds->v_idx->>'bed_slot')::INT
      );
    END LOOP;
  END IF;

  -- 3. Create the incoming booking on the freed beds
  v_new_booking_id := public.create_booking(v_booking, v_guests, v_allocations);

  -- 4. Eviction records (reason_aad_id is shared by every row from this eviction batch)
  FOREACH v_alloc_id IN ARRAY p_evict_allocation_ids LOOP
    INSERT INTO public.evictions (
      evicted_allocation_id, displaced_booking_id, incoming_booking_id,
      reason_enc, reason_aad_id, key_version, approved_by
    )
    SELECT v_alloc_id, a.booking_id, v_new_booking_id, p_reason_enc, p_reason_aad_id, p_key_version, auth.uid()
    FROM public.allocations a WHERE a.id = v_alloc_id;
  END LOOP;

  PERFORM public.log_audit_event('eviction_approved', 'evictions', v_new_booking_id, jsonb_build_object(
    'evicted_count', array_length(p_evict_allocation_ids, 1)
  ));

  RETURN v_new_booking_id;
END;
$$;
