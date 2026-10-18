-- 0028_booking_logic_fixes.sql
-- Booking logic review fixes.
--
--  1. mess_today(): "today" in the mess's own time zone (app_config 'mess_timezone', default
--     Asia/Kolkata). CURRENT_DATE is the UTC date on Supabase, so between 00:00 and 05:30 IST the
--     backdating / "stay already started" checks were a day behind the clerk's calendar.
--  2. Allotment is all-or-nothing. allot_booking_rooms() no longer falls back to the first guest
--     when a guest cannot be resolved, rejects guests from other bookings, and requires every
--     guest of the booking to get exactly one bed. It also accepts a CONFIRMED booking that has no
--     ACTIVE allocation (the requests queue lists those), which removes the need for the client to
--     create a second booking and cancel the first.
--  3. create_booking() applies the same coverage rule, rejects a PENDING_ALLOTMENT request that
--     already carries allocations, validates dates, and reports an unresolved guest as
--     ERR_INVALID_GUEST instead of a not-null violation.
--  4. cancel_booking() / move_allocation() verify the target exists and is still active.
--  5. approve_eviction(): evicted beds must overlap the incoming stay and may not be in a suite;
--     it can allot an existing pending request (p_incoming.booking_id) instead of always creating
--     a second booking; locks are taken booking -> allocation -> room, in id order, so it cannot
--     deadlock with update_booking_dates / cancel_booking.
--  6. eviction_candidates(): skips offline / deleted / closed rooms.
--  7. record_denial() can resolve the pending request it denies (p_booking_id).
--  8. The room-closure trigger no longer blocks shortening a stay in a room that went offline.

-- ---------------------------------------------------------------------------
-- 1. mess_today()
-- ---------------------------------------------------------------------------
INSERT INTO public.app_config (key, value)
VALUES ('mess_timezone', '"Asia/Kolkata"'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.mess_today()
RETURNS DATE
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (
    NOW() AT TIME ZONE COALESCE(
      (
        SELECT c.value #>> '{}'
        FROM public.app_config c
        WHERE c.key = 'mess_timezone'
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name = c.value #>> '{}')
      ),
      'Asia/Kolkata'
    )
  )::DATE;
$$;

GRANT EXECUTE ON FUNCTION public.mess_today() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Closure / offline-room trigger: only newly placed or extended stays are checked
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_enforce_room_closure()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_closed BOOLEAN;
  v_unavailable BOOLEAN;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  -- An unchanged or shortened stay in the same room cannot create a new conflict, so a guest can
  -- still be checked out early from a room that has since gone offline.
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'ACTIVE'
     AND NEW.room_id = OLD.room_id
     AND NEW.stay <@ OLD.stay THEN
    RETURN NEW;
  END IF;

  SELECT NOT (r.is_active AND r.deleted_at IS NULL) INTO v_unavailable
  FROM public.rooms r WHERE r.id = NEW.room_id
  FOR SHARE;  -- serialises with delete_room(), which holds FOR UPDATE on the room
  IF COALESCE(v_unavailable, TRUE) THEN
    RAISE EXCEPTION 'ERR_ROOM_CLOSED' USING errcode = 'P0001';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.room_closures
    WHERE room_id = NEW.room_id AND period && NEW.stay
  ) INTO v_closed;

  IF v_closed THEN
    RAISE EXCEPTION 'ERR_ROOM_CLOSED' USING errcode = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Allotment (internal worker + public RPC)
-- ---------------------------------------------------------------------------
-- No permission check: callers (allot_booking_rooms, approve_eviction) check their own.
CREATE OR REPLACE FUNCTION public.internal_allot_booking(
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
  v_alloc JSONB;
  v_guest_id UUID;
  v_seen UUID[] := ARRAY[]::UUID[];
  v_guest_count INT;
BEGIN
  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
  END IF;

  IF NOT (
    v_booking.status = 'PENDING_ALLOTMENT'
    OR (
      v_booking.status = 'CONFIRMED'
      AND NOT EXISTS (
        SELECT 1 FROM public.allocations a
        WHERE a.booking_id = p_booking_id AND a.status = 'ACTIVE'
      )
    )
  ) THEN
    RAISE EXCEPTION 'ERR_BOOKING_NOT_PENDING' USING errcode = 'P0001';
  END IF;

  IF v_booking.is_suite_booking AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_SUITE_ONLY_ADMIN' USING errcode = 'P0001';
  END IF;

  IF p_allocations IS NULL OR jsonb_typeof(p_allocations) <> 'array' OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'ERR_EMPTY_ALLOCATIONS' USING errcode = 'P0001';
  END IF;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_guest_id := NULL;
    IF COALESCE(v_alloc->>'guest_id', '') <> '' THEN
      SELECT g.id INTO v_guest_id FROM public.booking_guests g
      WHERE g.id = (v_alloc->>'guest_id')::UUID AND g.booking_id = p_booking_id;
    ELSIF COALESCE(v_alloc->>'guest_seq', '') <> '' THEN
      SELECT g.id INTO v_guest_id FROM public.booking_guests g
      WHERE g.booking_id = p_booking_id AND g.seq = (v_alloc->>'guest_seq')::INT;
    END IF;

    IF v_guest_id IS NULL OR v_guest_id = ANY(v_seen) THEN
      RAISE EXCEPTION 'ERR_INVALID_GUEST' USING errcode = 'P0001';
    END IF;
    v_seen := v_seen || v_guest_id;

    -- Triggers enforce double booking, sharing, closures and suite rules.
    INSERT INTO public.allocations (
      booking_id, guest_id, room_id, bed_slot, stay, status, created_by
    ) VALUES (
      p_booking_id,
      v_guest_id,
      (v_alloc->>'room_id')::UUID,
      (v_alloc->>'bed_slot')::SMALLINT,
      v_booking.stay,
      'ACTIVE',
      auth.uid()
    );
  END LOOP;

  SELECT count(*) INTO v_guest_count FROM public.booking_guests WHERE booking_id = p_booking_id;
  IF COALESCE(array_length(v_seen, 1), 0) <> v_guest_count THEN
    RAISE EXCEPTION 'ERR_INCOMPLETE_ALLOTMENT' USING errcode = 'P0001';
  END IF;

  UPDATE public.bookings
  SET status = 'CONFIRMED',
      updated_at = NOW()
  WHERE id = p_booking_id;

  PERFORM public.log_audit_event(
    'booking_allotted',
    'bookings',
    p_booking_id,
    jsonb_build_object('allocations_count', COALESCE(array_length(v_seen, 1), 0))
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.internal_allot_booking(UUID, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.allot_booking_rooms(
  p_booking_id UUID,
  p_allocations JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND (public.has_perm('create_booking') OR public.is_admin())) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  PERFORM public.internal_allot_booking(p_booking_id, p_allocations);
END;
$$;

GRANT EXECUTE ON FUNCTION public.allot_booking_rooms(UUID, JSONB) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. create_booking
-- ---------------------------------------------------------------------------
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
  v_has_allocs BOOLEAN;
  v_guest JSONB;
  v_alloc JSONB;
  v_guest_id UUID;
  v_guest_map JSONB := '{}'::jsonb;
  v_relation public.guest_relation;
  v_min_seq INT;
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
  v_has_allocs := p_allocations IS NOT NULL
    AND jsonb_typeof(p_allocations) = 'array'
    AND jsonb_array_length(p_allocations) > 0;

  IF v_check_in IS NULL OR v_check_out IS NULL OR v_check_out <= v_check_in THEN
    RAISE EXCEPTION 'ERR_INVALID_DATES' USING errcode = 'P0001';
  END IF;

  -- Backdating restriction: Clerks cannot backdate bookings; Admin may
  IF NOT v_is_admin AND v_check_in < public.mess_today() THEN
    RAISE EXCEPTION 'ERR_INVALID_DATES: Clerks cannot backdate bookings' USING errcode = 'P0001';
  END IF;

  IF v_is_suite AND NOT v_is_admin THEN
    RAISE EXCEPTION 'ERR_SUITE_ONLY_ADMIN' USING errcode = 'P0001';
  END IF;

  IF p_guests IS NULL OR jsonb_typeof(p_guests) <> 'array'
     OR v_party_size IS NULL OR jsonb_array_length(p_guests) <> v_party_size THEN
    RAISE EXCEPTION 'ERR_PARTY_MISMATCH' USING errcode = 'P0001';
  END IF;

  -- A request waiting for allotment must not already hold beds.
  IF p_booking->>'status' = 'PENDING_ALLOTMENT' AND v_has_allocs THEN
    RAISE EXCEPTION 'ERR_INVALID_REQUEST: a pending allotment request cannot carry allocations' USING errcode = 'P0001';
  END IF;

  IF p_booking->>'status' = 'PENDING_ALLOTMENT' OR NOT v_has_allocs THEN
    v_status := 'PENDING_ALLOTMENT';
  ELSE
    v_status := 'CONFIRMED';
  END IF;

  -- Callers that predate relation send none: the first guest is the primary, ranked guests
  -- after it are SERVICE, unranked ones OTHER.
  SELECT min((g->>'seq')::INT) INTO v_min_seq FROM jsonb_array_elements(p_guests) g;

  IF (
    SELECT count(*) FROM jsonb_array_elements(p_guests) g
    WHERE COALESCE(g->>'relation', CASE WHEN (g->>'seq')::INT = v_min_seq THEN 'PRIMARY' END) = 'PRIMARY'
  ) <> 1 THEN
    RAISE EXCEPTION 'ERR_PRIMARY_GUEST: a booking needs exactly one primary ranked person' USING errcode = 'P0001';
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
    NULLIF(p_booking->>'preferred_room_type', '')::public.room_type,
    p_booking->>'notes_enc',
    COALESCE((p_booking->>'key_version')::INT, 1),
    auth.uid()
  ) RETURNING id INTO v_booking_id;

  FOR v_guest IN SELECT * FROM jsonb_array_elements(p_guests) LOOP
    v_relation := COALESCE(
      (v_guest->>'relation')::public.guest_relation,
      CASE
        WHEN (v_guest->>'seq')::INT = v_min_seq THEN 'PRIMARY'
        WHEN v_guest->>'rank_code' IS NOT NULL THEN 'SERVICE'
        ELSE 'OTHER'
      END::public.guest_relation
    );

    INSERT INTO public.booking_guests (
      booking_id,
      seq,
      gender,
      rank_code,
      relation,
      guest_name,
      service_number,
      unit,
      phone,
      details,
      created_by
    ) VALUES (
      v_booking_id,
      (v_guest->>'seq')::INT,
      (v_guest->>'gender')::public.gender,
      (v_guest->>'rank_code')::public.rank_code,
      v_relation,
      NULLIF(v_guest->>'guest_name', ''),
      NULLIF(v_guest->>'service_number', ''),
      NULLIF(v_guest->>'unit', ''),
      NULLIF(v_guest->>'phone', ''),
      'PENDING',
      auth.uid()
    ) RETURNING id INTO v_guest_id;

    v_guest_map := jsonb_set(v_guest_map, ARRAY[(v_guest->>'seq')::text], to_jsonb(v_guest_id));
  END LOOP;

  IF v_has_allocs THEN
    FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
      v_guest_id := (v_guest_map->>(v_alloc->>'guest_seq'))::UUID;
      IF v_guest_id IS NULL AND COALESCE(v_alloc->>'guest_id', '') <> '' THEN
        v_guest_id := (v_alloc->>'guest_id')::UUID;
        IF NOT EXISTS (SELECT 1 FROM public.booking_guests
                       WHERE id = v_guest_id AND booking_id = v_booking_id) THEN
          RAISE EXCEPTION 'ERR_INVALID_GUEST' USING errcode = 'P0001';
        END IF;
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
        v_booking_id,
        v_guest_id,
        (v_alloc->>'room_id')::UUID,
        (v_alloc->>'bed_slot')::SMALLINT,
        daterange(v_check_in, v_check_out, '[)'),
        'ACTIVE',
        auth.uid()
      );
    END LOOP;

    -- Everyone in the party gets exactly one bed (one_bed_per_guest rules out duplicates).
    IF (SELECT count(DISTINCT a.guest_id) FROM public.allocations a
        WHERE a.booking_id = v_booking_id AND a.status = 'ACTIVE') <> v_party_size THEN
      RAISE EXCEPTION 'ERR_INCOMPLETE_ALLOTMENT' USING errcode = 'P0001';
    END IF;
  END IF;

  IF v_status = 'PENDING_ALLOTMENT' THEN
    PERFORM public.log_audit_event('booking_request_created', 'bookings', v_booking_id, jsonb_build_object('category', v_category, 'party_size', v_party_size));
  ELSE
    PERFORM public.log_audit_event('booking_created', 'bookings', v_booking_id, jsonb_build_object('category', v_category, 'party_size', v_party_size));
  END IF;

  RETURN v_booking_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_booking(JSONB, JSONB, JSONB) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. cancel_booking / move_allocation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_booking(
  p_id UUID,
  p_reason_enc TEXT,
  p_key_version INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status public.booking_status;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('cancel_booking')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  -- Lock order everywhere: booking, then its allocations, then rooms (via triggers).
  SELECT status INTO v_status FROM public.bookings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
  END IF;
  IF v_status NOT IN ('CONFIRMED', 'PENDING_ALLOTMENT') THEN
    RAISE EXCEPTION 'ERR_BOOKING_NOT_ACTIVE' USING errcode = 'P0001';
  END IF;

  UPDATE public.bookings
  SET status = 'CANCELLED',
      cancelled_at = NOW(),
      cancel_reason_enc = p_reason_enc,
      key_version = p_key_version
  WHERE id = p_id;

  UPDATE public.allocations
  SET status = 'RELEASED'
  WHERE booking_id = p_id AND status = 'ACTIVE';

  PERFORM public.log_audit_event('booking_cancelled', 'bookings', p_id, '{}'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_booking(UUID, TEXT, INT) TO authenticated;

CREATE OR REPLACE FUNCTION public.move_allocation(
  p_allocation_id UUID,
  p_room_id UUID,
  p_bed_slot SMALLINT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_booking_id UUID;
  v_booking_status public.booking_status;
  v_alloc_status public.allocation_status;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('create_booking')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT booking_id INTO v_booking_id FROM public.allocations WHERE id = p_allocation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
  END IF;

  SELECT status INTO v_booking_status FROM public.bookings WHERE id = v_booking_id FOR UPDATE;
  SELECT status INTO v_alloc_status FROM public.allocations WHERE id = p_allocation_id FOR UPDATE;
  IF v_alloc_status IS DISTINCT FROM 'ACTIVE' OR v_booking_status IS DISTINCT FROM 'CONFIRMED' THEN
    RAISE EXCEPTION 'ERR_ALLOCATION_NOT_ACTIVE' USING errcode = 'P0001';
  END IF;

  UPDATE public.allocations
  SET room_id = p_room_id,
      bed_slot = p_bed_slot
  WHERE id = p_allocation_id;

  PERFORM public.log_audit_event('allocation_moved', 'allocations', p_allocation_id, jsonb_build_object(
    'new_room_id', p_room_id,
    'new_bed_slot', p_bed_slot
  ));
END;
$$;

GRANT EXECUTE ON FUNCTION public.move_allocation(UUID, UUID, SMALLINT) TO authenticated;

-- ---------------------------------------------------------------------------
-- update_booking_dates: mess_today() + allocation locks taken up front
-- ---------------------------------------------------------------------------
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
  v_today DATE := public.mess_today();
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

  IF p_new_check_in IS NULL OR p_new_check_out IS NULL OR p_new_check_out <= p_new_check_in THEN
    RAISE EXCEPTION 'ERR_INVALID_DATES' USING errcode = 'P0001';
  END IF;

  -- If booking has already started, check-in cannot change and check-out cannot be in the past
  IF v_booking.check_in <= v_today THEN
    IF p_new_check_in <> v_booking.check_in THEN
      RAISE EXCEPTION 'ERR_CANNOT_CHANGE_PAST_CHECKIN' USING errcode = 'P0001';
    END IF;
    IF p_new_check_out < v_today THEN
      RAISE EXCEPTION 'ERR_INVALID_DATES' USING errcode = 'P0001';
    END IF;
  ELSE
    IF p_new_check_in < v_today AND NOT public.is_admin() THEN
      RAISE EXCEPTION 'ERR_INVALID_DATES: Clerks cannot backdate bookings' USING errcode = 'P0001';
    END IF;
  END IF;

  v_new_stay := daterange(p_new_check_in, p_new_check_out, '[)');

  -- Take every allocation lock before any room lock (the sharing trigger locks rooms).
  PERFORM 1 FROM public.allocations a
  WHERE a.booking_id = p_booking_id AND a.status = 'ACTIVE'
  ORDER BY a.id
  FOR UPDATE;

  FOR v_alloc IN
    SELECT a.*
    FROM public.allocations a
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

GRANT EXECUTE ON FUNCTION public.update_booking_dates(UUID, DATE, DATE) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. eviction_candidates: only beds an eviction can actually hand over
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.eviction_candidates(
  p_category public.category,
  p_check_in DATE,
  p_check_out DATE,
  p_guests JSONB
)
RETURNS TABLE(
  allocation_id UUID,
  booking_id UUID,
  room_id UUID,
  room_name_enc TEXT,
  room_type public.room_type,
  bed_slot SMALLINT,
  category public.category,
  occupant_gender public.gender,
  occupant_rank public.rank_code,
  days_stayed INT,
  days_remaining INT,
  fits_incoming BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today DATE := public.mess_today();
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    a.id,
    b.id,
    a.room_id,
    r.name_enc,
    r.room_type,
    a.bed_slot,
    b.category,
    bg.gender,
    bg.rank_code,
    GREATEST(0, (v_today - b.check_in))::INT,
    GREATEST(0, (b.check_out - v_today))::INT,
    TRUE
  FROM public.allocations a
  JOIN public.bookings b ON b.id = a.booking_id
  JOIN public.rooms r ON r.id = a.room_id
  JOIN public.booking_guests bg ON bg.id = a.guest_id
  WHERE a.status = 'ACTIVE'
    AND r.room_type <> 'SUITE'
    AND r.is_active AND r.deleted_at IS NULL
    AND a.stay && daterange(p_check_in, p_check_out, '[)')
    AND NOT EXISTS (
      SELECT 1 FROM public.room_closures rc
      WHERE rc.room_id = a.room_id AND rc.period && daterange(p_check_in, p_check_out, '[)')
    )
    AND (
      (p_category = 'MFA' AND b.category IN ('PI', 'LEAVE', 'TD')) OR
      (p_category = 'PI' AND b.category IN ('LEAVE', 'TD'))
    )
  ORDER BY b.check_in ASC, a.id ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.eviction_candidates(public.category, DATE, DATE, JSONB) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. approve_eviction
-- ---------------------------------------------------------------------------
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
  v_room_type public.room_type;
  v_alloc_stay DATERANGE;
  v_new_booking_id UUID;
  v_existing public.bookings%ROWTYPE;
  v_existing_id UUID;
  v_booking JSONB;
  v_guests JSONB;
  v_allocations JSONB;
  v_incoming_category public.category;
  v_incoming_stay DATERANGE;
  v_check_in DATE;
  v_check_out DATE;
  v_beds JSONB := '[]'::JSONB;
  v_idx INT := 0;
  v_guest_count INT;
  v_seq INT;
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
  v_existing_id := NULLIF(v_booking->>'booking_id', '')::UUID;

  -- Who is coming in. An existing pending request is allotted in place (its stored category and
  -- dates rule, not the payload's); otherwise a new booking is created below.
  IF v_existing_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.bookings WHERE id = v_existing_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
    END IF;
    IF v_existing.is_suite_booking THEN
      RAISE EXCEPTION 'ERR_CANNOT_EVICT: a suite booking cannot displace other guests' USING errcode = 'P0001';
    END IF;
    v_incoming_category := v_existing.category;
    v_incoming_stay := v_existing.stay;
  ELSE
    v_incoming_category := (v_booking->>'category')::public.category;
    v_check_in := (v_booking->>'check_in')::DATE;
    v_check_out := (v_booking->>'check_out')::DATE;
    IF v_check_in IS NULL OR v_check_out IS NULL OR v_check_out <= v_check_in THEN
      RAISE EXCEPTION 'ERR_INVALID_DATES' USING errcode = 'P0001';
    END IF;
    v_incoming_stay := daterange(v_check_in, v_check_out, '[)');
  END IF;

  -- Lock order: displaced bookings (id order), their allocations (id order), then rooms via the
  -- triggers. Matches cancel_booking / update_booking_dates, so concurrent callers cannot deadlock.
  PERFORM 1 FROM public.bookings b
  WHERE b.id IN (SELECT a.booking_id FROM public.allocations a WHERE a.id = ANY(p_evict_allocation_ids))
  ORDER BY b.id
  FOR UPDATE;

  PERFORM 1 FROM public.allocations a
  WHERE a.id = ANY(p_evict_allocation_ids)
  ORDER BY a.id
  FOR UPDATE;

  -- 1. Evict (in the order given) and remember the freed beds
  FOREACH v_alloc_id IN ARRAY p_evict_allocation_ids LOOP
    v_displaced_booking_id := NULL;
    SELECT a.booking_id, b.category, r.room_type, a.stay
      INTO v_displaced_booking_id, v_displaced_category, v_room_type, v_alloc_stay
    FROM public.allocations a
    JOIN public.bookings b ON b.id = a.booking_id
    JOIN public.rooms r ON r.id = a.room_id
    WHERE a.id = v_alloc_id AND a.status = 'ACTIVE';

    IF v_displaced_booking_id IS NULL THEN
      RAISE EXCEPTION 'ERR_ALLOCATION_NOT_ACTIVE' USING errcode = 'P0001';
    END IF;

    IF v_displaced_booking_id = v_existing_id THEN
      RAISE EXCEPTION 'ERR_CANNOT_EVICT: a booking cannot displace itself' USING errcode = 'P0001';
    END IF;

    IF v_room_type = 'SUITE' THEN
      RAISE EXCEPTION 'ERR_CANNOT_EVICT: suite guests cannot be displaced' USING errcode = 'P0001';
    END IF;

    IF NOT (v_alloc_stay && v_incoming_stay) THEN
      RAISE EXCEPTION 'ERR_EVICTION_NO_OVERLAP: that bed is not occupied during the incoming stay' USING errcode = 'P0001';
    END IF;

    IF NOT (
      (v_incoming_category = 'MFA' AND v_displaced_category IN ('PI', 'LEAVE', 'TD')) OR
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

  -- 2. Default seating when the caller gave none: guest seq N -> Nth freed bed
  IF v_allocations IS NULL OR jsonb_array_length(v_allocations) = 0 THEN
    v_allocations := '[]'::JSONB;
    IF v_existing_id IS NOT NULL THEN
      SELECT count(*) INTO v_guest_count FROM public.booking_guests WHERE booking_id = v_existing_id;
      IF jsonb_array_length(v_beds) < v_guest_count THEN
        RAISE EXCEPTION 'ERR_NOT_ENOUGH_BEDS: select at least one bed per incoming guest' USING errcode = 'P0001';
      END IF;
      FOR v_seq IN SELECT g.seq FROM public.booking_guests g WHERE g.booking_id = v_existing_id ORDER BY g.seq LOOP
        v_allocations := v_allocations || jsonb_build_object(
          'guest_seq', v_seq,
          'room_id', v_beds->v_idx->>'room_id',
          'bed_slot', (v_beds->v_idx->>'bed_slot')::INT
        );
        v_idx := v_idx + 1;
      END LOOP;
    ELSE
      IF jsonb_array_length(v_beds) < jsonb_array_length(v_guests) THEN
        RAISE EXCEPTION 'ERR_NOT_ENOUGH_BEDS: select at least one bed per incoming guest' USING errcode = 'P0001';
      END IF;
      FOR v_idx IN 0 .. jsonb_array_length(v_guests) - 1 LOOP
        v_allocations := v_allocations || jsonb_build_object(
          'guest_seq', COALESCE((v_guests->v_idx->>'seq')::INT, v_idx + 1),
          'room_id', v_beds->v_idx->>'room_id',
          'bed_slot', (v_beds->v_idx->>'bed_slot')::INT
        );
      END LOOP;
    END IF;
  END IF;

  -- 3. Seat the incoming party on the freed beds
  IF v_existing_id IS NOT NULL THEN
    PERFORM public.internal_allot_booking(v_existing_id, v_allocations);
    v_new_booking_id := v_existing_id;
  ELSE
    v_new_booking_id := public.create_booking(v_booking, v_guests, v_allocations);
  END IF;

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

GRANT EXECUTE ON FUNCTION public.approve_eviction(JSONB, UUID[], TEXT, INT, UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. record_denial: optionally resolves the pending request being denied
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.record_denial(public.category, DATE, DATE, INT, TEXT, INT, UUID);
CREATE FUNCTION public.record_denial(
  p_category public.category,
  p_check_in DATE,
  p_check_out DATE,
  p_party_size INT,
  p_reason_enc TEXT,
  p_key_version INT,
  p_id UUID DEFAULT NULL,
  p_booking_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id UUID;
  v_booking public.bookings%ROWTYPE;
BEGIN
  -- Business-rule validation first so the error is the same for every caller.
  IF p_category IN ('MFA', 'PI') THEN
    RAISE EXCEPTION 'ERR_CANNOT_DENY_PRIORITY' USING errcode = 'P0001';
  END IF;

  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('deny_request')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  IF p_check_in IS NULL OR p_check_out IS NULL OR p_check_out <= p_check_in THEN
    RAISE EXCEPTION 'ERR_INVALID_DATES' USING errcode = 'P0001';
  END IF;
  IF p_party_size IS NULL OR p_party_size < 1 THEN
    RAISE EXCEPTION 'ERR_PARTY_MISMATCH' USING errcode = 'P0001';
  END IF;

  IF p_booking_id IS NOT NULL THEN
    SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
    END IF;
    IF v_booking.category <> p_category THEN
      RAISE EXCEPTION 'ERR_CANNOT_DENY_PRIORITY' USING errcode = 'P0001';
    END IF;
    IF NOT (
      v_booking.status = 'PENDING_ALLOTMENT'
      OR (
        v_booking.status = 'CONFIRMED'
        AND NOT EXISTS (
          SELECT 1 FROM public.allocations a
          WHERE a.booking_id = p_booking_id AND a.status = 'ACTIVE'
        )
      )
    ) THEN
      RAISE EXCEPTION 'ERR_BOOKING_NOT_PENDING' USING errcode = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.denials (
    id, category, check_in, check_out, party_size, reason_enc, key_version, denied_by
  ) VALUES (
    COALESCE(p_id, gen_random_uuid()),
    p_category, p_check_in, p_check_out, p_party_size, p_reason_enc, p_key_version, auth.uid()
  ) RETURNING id INTO v_id;

  IF p_booking_id IS NOT NULL THEN
    UPDATE public.bookings
    SET status = 'CANCELLED',
        cancelled_at = NOW(),
        updated_at = NOW()
    WHERE id = p_booking_id;
  END IF;

  PERFORM public.log_audit_event('booking_denied', 'denials', v_id, jsonb_build_object(
    'category', p_category,
    'party_size', p_party_size,
    'booking_id', p_booking_id
  ));

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_denial(public.category, DATE, DATE, INT, TEXT, INT, UUID, UUID) TO authenticated;
