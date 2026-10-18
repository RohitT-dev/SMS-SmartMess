-- ==============================================================================
-- SMART MESS SYSTEM - SUPABASE DATABASE MIGRATION SCRIPT
-- Run this in your Supabase Dashboard: SQL Editor -> New Query -> Paste & Run
-- ==============================================================================

-- 1. Add PENDING_ALLOTMENT to public.booking_status enum (if not already present)
ALTER TYPE public.booking_status ADD VALUE IF NOT EXISTS 'PENDING_ALLOTMENT';

-- 2. Add columns to public.booking_guests
ALTER TABLE public.booking_guests ADD COLUMN IF NOT EXISTS guest_code TEXT;
ALTER TABLE public.booking_guests ADD COLUMN IF NOT EXISTS guest_name TEXT;
ALTER TABLE public.booking_guests ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE public.booking_guests ADD COLUMN IF NOT EXISTS service_number TEXT;
ALTER TABLE public.booking_guests ADD COLUMN IF NOT EXISTS phone TEXT;

-- Sequence for guest codes (GST-1001, GST-1002, ...)
CREATE SEQUENCE IF NOT EXISTS public.guest_code_seq START 1001;

CREATE OR REPLACE FUNCTION public.generate_guest_code()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN 'GST-' || LPAD(nextval('public.guest_code_seq')::TEXT, 4, '0');
END;
$$;

-- Trigger to auto-populate guest_code on booking_guests
CREATE OR REPLACE FUNCTION public.trg_booking_guests_code_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.guest_code IS NULL OR NEW.guest_code = '' THEN
    NEW.guest_code := public.generate_guest_code();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_booking_guests_code ON public.booking_guests;
CREATE TRIGGER trg_booking_guests_code
  BEFORE INSERT ON public.booking_guests
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_booking_guests_code_fn();

-- Backfill any existing booking_guests rows without a guest_code
UPDATE public.booking_guests
SET guest_code = public.generate_guest_code()
WHERE guest_code IS NULL OR guest_code = '';

-- Allow authenticated users to update guest details on booking_guests
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'booking_guests' AND policyname = 'booking_guests_update'
  ) THEN
    CREATE POLICY booking_guests_update ON public.booking_guests
      FOR UPDATE TO authenticated
      USING (public.is_active_user() AND public.is_aal2())
      WITH CHECK (public.is_active_user() AND public.is_aal2());
  END IF;
END;
$$;
GRANT UPDATE ON public.booking_guests TO authenticated;

-- Direct RPC to update guest name and service details
CREATE OR REPLACE FUNCTION public.set_booking_guest_details(
  p_guest_id UUID,
  p_guest_name TEXT,
  p_unit TEXT,
  p_service_number TEXT,
  p_phone TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND (public.has_perm('create_booking') OR public.has_perm('enter_guest_details') OR public.is_admin())) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  UPDATE public.booking_guests
  SET guest_name = p_guest_name,
      unit = p_unit,
      service_number = p_service_number,
      phone = p_phone,
      details = 'COMPLETE'
  WHERE id = p_guest_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_booking_guest_details(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- 3. Update create_booking RPC to support unallotted bookings and guest details
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

  IF NOT v_is_admin AND v_check_in < CURRENT_DATE THEN
    RAISE EXCEPTION 'ERR_INVALID_DATES: Clerks cannot backdate bookings' USING errcode = 'P0001';
  END IF;

  IF v_is_suite AND NOT v_is_admin THEN
    RAISE EXCEPTION 'ERR_SUITE_ONLY_ADMIN' USING errcode = 'P0001';
  END IF;

  IF jsonb_array_length(p_guests) <> v_party_size THEN
    RAISE EXCEPTION 'ERR_PARTY_MISMATCH' USING errcode = 'P0001';
  END IF;

  IF p_booking->>'status' = 'PENDING_ALLOTMENT' OR p_allocations IS NULL OR jsonb_array_length(p_allocations) = 0 THEN
    v_status := 'PENDING_ALLOTMENT';
  ELSE
    v_status := 'CONFIRMED';
  END IF;

  INSERT INTO public.bookings (
    category,
    status,
    check_in,
    check_out,
    party_size,
    is_suite_booking,
    preferred_room_type,
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
    (p_booking->>'preferred_room_type')::public.room_type,
    p_booking->>'notes_enc',
    COALESCE((p_booking->>'key_version')::INT, 1),
    auth.uid()
  ) RETURNING id INTO v_booking_id;

  FOR v_guest IN SELECT * FROM jsonb_array_elements(p_guests) LOOP
    INSERT INTO public.booking_guests (
      booking_id,
      seq,
      gender,
      rank_code,
      guest_code,
      guest_name,
      unit,
      service_number,
      phone,
      details,
      created_by
    ) VALUES (
      v_booking_id,
      (v_guest->>'seq')::INT,
      (v_guest->>'gender')::public.gender,
      (v_guest->>'rank_code')::public.rank_code,
      COALESCE(v_guest->>'guest_code', public.generate_guest_code()),
      v_guest->>'guest_name',
      v_guest->>'unit',
      v_guest->>'service_number',
      v_guest->>'phone',
      'PENDING',
      auth.uid()
    ) RETURNING id INTO v_guest_id;

    v_guest_map := jsonb_set(v_guest_map, ARRAY[(v_guest->>'seq')::text], to_jsonb(v_guest_id));
  END LOOP;

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

  RETURN v_booking_id;
END;
$$;

-- 4. create_booking_request convenience RPC
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

-- 5. Resilient allot_booking_rooms RPC
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

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_guest_id := NULL;
    IF (v_alloc->>'guest_id') IS NOT NULL AND (v_alloc->>'guest_id') <> '' THEN
      v_guest_id := (v_alloc->>'guest_id')::UUID;
    ELSIF (v_alloc->>'guest_seq') IS NOT NULL THEN
      SELECT id INTO v_guest_id FROM public.booking_guests
      WHERE booking_id = p_booking_id AND seq = (v_alloc->>'guest_seq')::INT;
    END IF;

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

-- 6. Universal search_bookings_and_guests RPC
CREATE OR REPLACE FUNCTION public.search_bookings_and_guests(p_query TEXT)
RETURNS TABLE(booking_id UUID, match_source TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_q TEXT;
  v_is_admin BOOLEAN;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  v_q := trim(lower(p_query));
  IF v_q = '' THEN
    RETURN;
  END IF;

  v_is_admin := public.is_admin();

  RETURN QUERY
  SELECT DISTINCT b.id AS booking_id, 'guest'::TEXT AS match_source
  FROM public.booking_guests bg
  JOIN public.bookings b ON b.id = bg.booking_id
  WHERE (b.is_suite_booking = FALSE OR v_is_admin)
    AND (
      lower(COALESCE(bg.guest_code, '')) LIKE '%' || v_q || '%'
      OR lower(COALESCE(bg.rank_code::TEXT, '')) LIKE '%' || v_q || '%'
      OR lower(COALESCE(bg.guest_name, '')) LIKE '%' || v_q || '%'
      OR lower(COALESCE(bg.unit, '')) LIKE '%' || v_q || '%'
      OR lower(COALESCE(bg.service_number, '')) LIKE '%' || v_q || '%'
      OR lower(COALESCE(bg.phone, '')) LIKE '%' || v_q || '%'
    )
  UNION
  SELECT DISTINCT b.id AS booking_id, 'booking'::TEXT AS match_source
  FROM public.bookings b
  WHERE (b.is_suite_booking = FALSE OR v_is_admin)
    AND (
      b.id::TEXT LIKE '%' || v_q || '%'
      OR lower(b.category::TEXT) LIKE '%' || v_q || '%'
    );
END;
$$;

-- 7. Update daily_room_state to include guestCode
CREATE OR REPLACE FUNCTION public.daily_room_state(p_from DATE, p_to DATE)
RETURNS TABLE(
  room_id UUID,
  room_type public.room_type,
  display_order INT,
  date DATE,
  beds_taken INT,
  is_closed BOOLEAN,
  occupants JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_admin BOOLEAN;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  v_is_admin := public.is_admin();

  RETURN QUERY
  WITH days AS (
    SELECT generate_series(p_from, p_to - INTERVAL '1 day', INTERVAL '1 day')::DATE AS d
  ),
  eligible_rooms AS (
    SELECT r.id, r.room_type, r.display_order
    FROM public.rooms r
    WHERE r.is_active = TRUE AND (r.room_type <> 'SUITE' OR v_is_admin)
  )
  SELECT
    er.id AS room_id,
    er.room_type,
    er.display_order,
    d.d AS date,
    COALESCE(count(a.id), 0)::INT AS beds_taken,
    EXISTS (
      SELECT 1 FROM public.room_closures rc
      WHERE rc.room_id = er.id AND rc.period && daterange(d.d, d.d + 1, '[)')
    ) AS is_closed,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'allocationId', a.id,
          'bookingId', a.booking_id,
          'bedSlot', a.bed_slot,
          'gender', bg.gender,
          'rankCode', bg.rank_code,
          'guestCode', bg.guest_code,
          'category', b.category,
          'bookingStatus', b.status,
          'checkIn', b.check_in,
          'checkOut', b.check_out
        )
      ) FILTER (WHERE a.id IS NOT NULL),
      '[]'::jsonb
    ) AS occupants
  FROM eligible_rooms er
  CROSS JOIN days d
  LEFT JOIN public.allocations a ON a.room_id = er.id
    AND a.status = 'ACTIVE'
    AND a.stay && daterange(d.d, d.d + 1, '[)')
  LEFT JOIN public.bookings b ON b.id = a.booking_id
  LEFT JOIN public.booking_guests bg ON bg.id = a.guest_id
  GROUP BY er.id, er.room_type, er.display_order, d.d
  ORDER BY er.display_order, d.d;
END;
$$;

-- 8. Grants for authenticated users
GRANT EXECUTE ON FUNCTION public.create_booking(JSONB, JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_booking_request(JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.allot_booking_rooms(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_bookings_and_guests(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.daily_room_state(DATE, DATE) TO authenticated;

-- 9. Backfill any existing unallotted bookings in the database from CONFIRMED to PENDING_ALLOTMENT
UPDATE public.bookings b
SET status = 'PENDING_ALLOTMENT'
WHERE b.status = 'CONFIRMED'
  AND NOT EXISTS (
    SELECT 1 FROM public.allocations a
    WHERE a.booking_id = b.id AND a.status = 'ACTIVE'
  );

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
