-- 0021_booking_requests_allotment.sql
-- 1. Add PENDING_ALLOTMENT to public.booking_status enum.
-- 2. Update create_booking RPC to support unallotted booking requests.
-- 3. Add create_booking_request RPC for taking multi-guest booking requests.
-- 4. Add allot_booking_rooms RPC for assigning rooms to a pending booking.
-- 5. Update update_booking_dates RPC to allow updating dates for PENDING_ALLOTMENT bookings.

ALTER TYPE public.booking_status ADD VALUE IF NOT EXISTS 'PENDING_ALLOTMENT';

-- 1. create_booking update
CREATE OR REPLACE FUNCTION public.create_booking(
  p_booking JSONB,
  p_guests JSONB,
  p_allocations JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_booking_id UUID;
  v_is_admin BOOLEAN;
  v_category public.category;
  v_check_in DATE;
  v_check_out DATE;
  v_party_size INT;
  v_is_suite BOOLEAN;
  v_status public.booking_status;
  v_guest JSONB;
  v_alloc JSONB;
  v_guest_id UUID;
  v_guest_map JSONB := '{}'::jsonb;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('create_booking')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  v_is_admin := public.is_admin();
  v_category := (p_booking->>'category')::public.category;
  v_check_in := (p_booking->>'check_in')::DATE;
  v_check_out := (p_booking->>'check_out')::DATE;
  v_party_size := (p_booking->>'party_size')::INT;
  v_is_suite := COALESCE((p_booking->>'is_suite_booking')::BOOLEAN, FALSE);

  -- Backdating restriction: Clerks cannot backdate bookings; Admin may
  IF NOT v_is_admin AND v_check_in < CURRENT_DATE THEN
    RAISE EXCEPTION 'ERR_INVALID_DATES: Clerks cannot backdate bookings' USING errcode = 'P0001';
  END IF;

  IF v_is_suite AND NOT v_is_admin THEN
    RAISE EXCEPTION 'ERR_SUITE_ONLY_ADMIN' USING errcode = 'P0001';
  END IF;

  IF jsonb_array_length(p_guests) <> v_party_size THEN
    RAISE EXCEPTION 'ERR_PARTY_MISMATCH' USING errcode = 'P0001';
  END IF;

  -- Determine booking status: if no allocations or requested pending allotment, status is PENDING_ALLOTMENT
  IF p_booking->>'status' = 'PENDING_ALLOTMENT' OR p_allocations IS NULL OR jsonb_array_length(p_allocations) = 0 THEN
    v_status := 'PENDING_ALLOTMENT';
  ELSE
    v_status := 'CONFIRMED';
  END IF;

  -- Insert booking
  INSERT INTO public.bookings (
    category,
    status,
    check_in,
    check_out,
    party_size,
    is_suite_booking,
    notes_enc,
    key_version,
    created_by
  ) VALUES (
    v_category,
    v_status,
    v_check_in,
    v_check_out,
    v_party_size,
    v_is_suite,
    p_booking->>'notes_enc',
    COALESCE((p_booking->>'key_version')::INT, 1),
    auth.uid()
  ) RETURNING id INTO v_booking_id;

  -- Insert guests and record mapping from seq to generated uuid
  FOR v_guest IN SELECT * FROM jsonb_array_elements(p_guests) LOOP
    INSERT INTO public.booking_guests (
      booking_id,
      seq,
      gender,
      rank_code,
      details,
      created_by
    ) VALUES (
      v_booking_id,
      (v_guest->>'seq')::INT,
      (v_guest->>'gender')::public.gender,
      (v_guest->>'rank_code')::public.rank_code,
      'PENDING',
      auth.uid()
    ) RETURNING id INTO v_guest_id;

    v_guest_map := jsonb_set(v_guest_map, ARRAY[(v_guest->>'seq')::text], to_jsonb(v_guest_id));
  END LOOP;

  -- Insert allocations if provided
  IF p_allocations IS NOT NULL AND jsonb_array_length(p_allocations) > 0 THEN
    FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
      v_guest_id := (v_guest_map->>(v_alloc->>'guest_seq'))::UUID;
      IF v_guest_id IS NULL AND (v_alloc->>'guest_id') IS NOT NULL THEN
        v_guest_id := (v_alloc->>'guest_id')::UUID;
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
        v_booking_id,
        v_guest_id,
        (v_alloc->>'room_id')::UUID,
        (v_alloc->>'bed_slot')::SMALLINT,
        daterange(v_check_in, v_check_out, '[)'),
        'ACTIVE',
        auth.uid()
      );
    END LOOP;
  END IF;

  IF v_status = 'PENDING_ALLOTMENT' THEN
    PERFORM public.log_audit_event('booking_request_created', 'bookings', v_booking_id, jsonb_build_object('category', v_category, 'party_size', v_party_size));
  ELSE
    PERFORM public.log_audit_event('booking_created', 'bookings', v_booking_id, jsonb_build_object('category', v_category, 'party_size', v_party_size));
  END IF;

  RETURN v_booking_id;
END;
$$;

-- 2. create_booking_request convenience RPC
CREATE OR REPLACE FUNCTION public.create_booking_request(
  p_booking JSONB,
  p_guests JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.create_booking(
    p_booking || jsonb_build_object('status', 'PENDING_ALLOTMENT'),
    p_guests,
    '[]'::jsonb
  );
END;
$$;

-- 3. allot_booking_rooms RPC
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
    IF (v_alloc->>'guest_id') IS NOT NULL THEN
      v_guest_id := (v_alloc->>'guest_id')::UUID;
    ELSIF (v_alloc->>'guest_seq') IS NOT NULL THEN
      SELECT id INTO v_guest_id FROM public.booking_guests
      WHERE booking_id = p_booking_id AND seq = (v_alloc->>'guest_seq')::INT;
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

-- 4. update_booking_dates update (allow PENDING_ALLOTMENT bookings)
CREATE OR REPLACE FUNCTION public.update_booking_dates(
  p_booking_id UUID,
  p_new_check_in DATE,
  p_new_check_out DATE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_new_stay DATERANGE;
  v_alloc RECORD;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND (public.has_perm('create_booking') OR public.is_admin())) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
  END IF;

  IF v_booking.status NOT IN ('CONFIRMED', 'PENDING_ALLOTMENT') THEN
    RAISE EXCEPTION 'ERR_BOOKING_NOT_ACTIVE' USING errcode = 'P0001';
  END IF;

  IF v_booking.is_suite_booking AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_SUITE_ONLY_ADMIN' USING errcode = 'P0001';
  END IF;

  IF p_new_check_out <= p_new_check_in THEN
    RAISE EXCEPTION 'ERR_INVALID_DATES' USING errcode = 'P0001';
  END IF;

  -- If booking has already started, check-in cannot change and check-out cannot be in the past
  IF v_booking.check_in <= CURRENT_DATE THEN
    IF p_new_check_in <> v_booking.check_in THEN
      RAISE EXCEPTION 'ERR_CANNOT_CHANGE_PAST_CHECKIN' USING errcode = 'P0001';
    END IF;
    IF p_new_check_out < CURRENT_DATE THEN
      RAISE EXCEPTION 'ERR_INVALID_DATES' USING errcode = 'P0001';
    END IF;
  ELSE
    IF p_new_check_in < CURRENT_DATE AND NOT public.is_admin() THEN
      RAISE EXCEPTION 'ERR_INVALID_DATES: Clerks cannot backdate bookings' USING errcode = 'P0001';
    END IF;
  END IF;

  v_new_stay := daterange(p_new_check_in, p_new_check_out, '[)');

  -- If booking has active allocations, check each room
  FOR v_alloc IN
    SELECT a.*, r.room_type
    FROM public.allocations a
    JOIN public.rooms r ON r.id = a.room_id
    WHERE a.booking_id = p_booking_id AND a.status = 'ACTIVE'
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.room_closures
      WHERE room_id = v_alloc.room_id AND period && v_new_stay
    ) THEN
      RAISE EXCEPTION 'ERR_ROOM_CLOSED' USING errcode = 'P0001';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.allocations other
      WHERE other.id <> v_alloc.id
        AND other.status = 'ACTIVE'
        AND other.room_id = v_alloc.room_id
        AND other.bed_slot = v_alloc.bed_slot
        AND other.stay && v_new_stay
    ) THEN
      RAISE EXCEPTION 'conflicting key value violates exclusion constraint "no_double_booking"' USING errcode = '23P01';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.allocations other
      WHERE other.id <> v_alloc.id
        AND other.status = 'ACTIVE'
        AND other.guest_id = v_alloc.guest_id
        AND other.stay && v_new_stay
    ) THEN
      RAISE EXCEPTION 'conflicting key value violates exclusion constraint "one_bed_per_guest"' USING errcode = '23P01';
    END IF;
  END LOOP;

  UPDATE public.bookings
  SET check_in = p_new_check_in,
      check_out = p_new_check_out,
      updated_at = NOW()
  WHERE id = p_booking_id;

  UPDATE public.allocations
  SET stay = v_new_stay,
      updated_at = NOW()
  WHERE booking_id = p_booking_id AND status = 'ACTIVE';

  PERFORM public.log_audit_event(
    'booking_dates_updated',
    'bookings',
    p_booking_id,
    jsonb_build_object(
      'old_check_in', v_booking.check_in,
      'old_check_out', v_booking.check_out,
      'new_check_in', p_new_check_in,
      'new_check_out', p_new_check_out
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_booking_request(JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.allot_booking_rooms(UUID, JSONB) TO authenticated;
