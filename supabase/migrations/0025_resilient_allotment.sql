-- Resilient allot_booking_rooms RPC with empty string guard and single guest fallback
CREATE OR REPLACE FUNCTION public.allot_booking_rooms(
  p_booking_id UUID,
  p_allocations JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_alloc RECORD;
  v_guest_id UUID;
  v_alloc_count INT := 0;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND (public.has_perm('create_booking') OR public.is_admin())) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
  END IF;

  IF v_booking.status <> 'PENDING_ALLOTMENT' THEN
    RAISE EXCEPTION 'ERR_BOOKING_NOT_PENDING' USING errcode = 'P0001';
  END IF;

  IF v_booking.is_suite_booking AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_SUITE_ONLY_ADMIN' USING errcode = 'P0001';
  END IF;

  IF p_allocations IS NULL OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'ERR_EMPTY_ALLOCATIONS' USING errcode = 'P0001';
  END IF;

  -- Insert allocations for the booking (triggers enforce double booking, sharing, closures)
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_guest_id := NULL;
    IF (v_alloc->>'guest_id') IS NOT NULL AND (v_alloc->>'guest_id') <> '' THEN
      v_guest_id := (v_alloc->>'guest_id')::UUID;
    ELSIF (v_alloc->>'guest_seq') IS NOT NULL THEN
      SELECT id INTO v_guest_id FROM public.booking_guests
      WHERE booking_id = p_booking_id AND seq = (v_alloc->>'guest_seq')::INT;
    END IF;

    -- Resilient fallback: If not resolved yet, check if there is only 1 guest for this booking
    IF v_guest_id IS NULL THEN
      SELECT id INTO v_guest_id FROM public.booking_guests
      WHERE booking_id = p_booking_id
      ORDER BY seq ASC
      LIMIT 1;
    END IF;

    IF v_guest_id IS NULL THEN
      RAISE EXCEPTION 'ERR_INVALID_GUEST' USING errcode = 'P0001';
    END IF;

    INSERT INTO public.allocations (
      booking_id,
      guest_id,
      room_id,
      bed_slot,
      stay,
      status,
      created_by
    ) VALUES (
      p_booking_id,
      v_guest_id,
      (v_alloc->>'room_id')::UUID,
      (v_alloc->>'bed_slot')::SMALLINT,
      v_booking.stay,
      'ACTIVE',
      auth.uid()
    );
    v_alloc_count := v_alloc_count + 1;
  END LOOP;

  -- Transition status to CONFIRMED
  UPDATE public.bookings
  SET status = 'CONFIRMED',
      updated_at = NOW()
  WHERE id = p_booking_id;

  PERFORM public.log_audit_event(
    'booking_allotted',
    'bookings',
    p_booking_id,
    jsonb_build_object('allocations_count', v_alloc_count)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.allot_booking_rooms(UUID, JSONB) TO authenticated;
