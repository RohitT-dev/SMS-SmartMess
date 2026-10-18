-- 0029_room_sharing.sql
-- "Allow room sharing" on bookings.
--
--  1. bookings.allow_sharing BOOLEAN NOT NULL. TRUE: the booking accepts other bookings beside it
--     (and may itself be placed beside them). FALSE: the booking holds every room it uses for its
--     own party; nobody from another booking may sleep in the other bed for the overlapping dates.
--     Existing rows are backfilled TRUE, so current behaviour is unchanged. New rows default to
--     FALSE: callers that predate the option (and the checkbox's default) get an exclusive room.
--  2. Sharing rule (trigger_enforce_sharing_rule), for overlapping stays in one room:
--       a. a booking with allow_sharing = FALSE cannot be allocated into a room where a different
--          booking holds an ACTIVE allocation (ERR_ROOM_EXCLUSIVE);
--       b. a different booking cannot be allocated into a room where an overlapping ACTIVE
--          allocation belongs to an allow_sharing = FALSE booking (ERR_ROOM_EXCLUSIVE);
--       c. two ranked people may share when they are of the SAME GENDER; their ranks may differ
--          (was: same gender AND same rank). A civilian shares only within their own booking
--          (unchanged). Violations raise ERR_SHARE_RULE.
--  3. create_booking() reads allow_sharing from p_booking (COALESCE to FALSE). It is also what
--     create_booking_request() and approve_eviction() call, so they carry the flag too; nothing
--     else of 0028 changes.
--  4. set_booking_allow_sharing(): the flag can still be changed while a request is waiting for
--     allotment (PENDING_ALLOTMENT, or CONFIRMED with no active bed).
--  5. daily_room_state() reports each occupant's allowSharing, so the room inventory can show a
--     room held by a non-sharing booking as one bed with no free second bed.
--  6. dashboard_counts() counts a room held by a lone non-sharing occupant as full, not "1 bed
--     free", to match the inventory.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE. Grants are unchanged.

-- ---------------------------------------------------------------------------
-- 1. bookings.allow_sharing
-- ---------------------------------------------------------------------------
-- Added with DEFAULT TRUE so every existing booking keeps sharing; the default is then flipped
-- for rows created from now on.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS allow_sharing BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.bookings
  ALTER COLUMN allow_sharing SET DEFAULT FALSE;

-- ---------------------------------------------------------------------------
-- 2. Sharing rule trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_enforce_sharing_rule()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_gender public.gender;
  v_new_rank public.rank_code;
  v_new_booking UUID;
  v_new_allow BOOLEAN;
  v_exclusive_clash BOOLEAN;
  v_mismatch_exists BOOLEAN;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  -- Row-level lock on the room to prevent race conditions during concurrent bookings
  PERFORM 1 FROM public.rooms WHERE id = NEW.room_id FOR UPDATE;

  SELECT bg.gender, bg.rank_code, bg.booking_id, b.allow_sharing
    INTO v_new_gender, v_new_rank, v_new_booking, v_new_allow
  FROM public.booking_guests bg
  JOIN public.bookings b ON b.id = bg.booking_id
  WHERE bg.id = NEW.guest_id;

  -- The allocation's guest must belong to the allocation's booking
  IF v_new_booking IS DISTINCT FROM NEW.booking_id THEN
    RAISE EXCEPTION 'ERR_SHARE_RULE' USING errcode = 'P0001';
  END IF;

  -- (a)/(b) A booking that does not allow sharing keeps the room to itself: no other booking may
  -- overlap it in either direction. A booking never clashes with itself.
  SELECT EXISTS (
    SELECT 1
    FROM public.allocations a
    JOIN public.bookings ob ON ob.id = a.booking_id
    WHERE a.room_id = NEW.room_id
      AND a.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND a.status = 'ACTIVE'
      AND a.stay && NEW.stay
      AND a.booking_id <> NEW.booking_id
      AND (NOT v_new_allow OR NOT ob.allow_sharing)
  ) INTO v_exclusive_clash;

  IF v_exclusive_clash THEN
    RAISE EXCEPTION 'ERR_ROOM_EXCLUSIVE' USING errcode = 'P0001';
  END IF;

  -- (c) Who may sleep beside whom
  SELECT EXISTS (
    SELECT 1
    FROM public.allocations a
    JOIN public.booking_guests bg ON bg.id = a.guest_id
    WHERE a.room_id = NEW.room_id
      AND a.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND a.status = 'ACTIVE'
      AND a.stay && NEW.stay
      AND NOT (
        -- same party, and at least one of the two is a civilian
        (bg.booking_id = v_new_booking AND (bg.rank_code IS NULL OR v_new_rank IS NULL))
        -- two ranked people of the same gender, whatever their ranks
        OR (bg.rank_code IS NOT NULL AND v_new_rank IS NOT NULL AND bg.gender = v_new_gender)
      )
  ) INTO v_mismatch_exists;

  IF v_mismatch_exists THEN
    RAISE EXCEPTION 'ERR_SHARE_RULE' USING errcode = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. create_booking (0028 definition + allow_sharing)
--    create_booking_request() and approve_eviction() delegate here, so they need no change.
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
  v_allow_sharing BOOLEAN;
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
  -- Callers that predate room sharing send none: the booking holds its rooms for itself.
  v_allow_sharing := COALESCE((p_booking->>'allow_sharing')::BOOLEAN, FALSE);
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
    allow_sharing,
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
    v_allow_sharing,
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
    PERFORM public.log_audit_event('booking_request_created', 'bookings', v_booking_id, jsonb_build_object('category', v_category, 'party_size', v_party_size, 'allow_sharing', v_allow_sharing));
  ELSE
    PERFORM public.log_audit_event('booking_created', 'bookings', v_booking_id, jsonb_build_object('category', v_category, 'party_size', v_party_size, 'allow_sharing', v_allow_sharing));
  END IF;

  RETURN v_booking_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_booking(JSONB, JSONB, JSONB) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. set_booking_allow_sharing: change the option while the request is still waiting for a room
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_booking_allow_sharing(
  p_booking_id UUID,
  p_allow BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND (public.has_perm('create_booking') OR public.is_admin())) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  IF p_allow IS NULL THEN
    RAISE EXCEPTION 'ERR_INVALID_REQUEST' USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
  END IF;

  -- Only a booking that holds no bed yet: once beds are allotted the other bookings in those
  -- rooms were checked against the flag, so it is frozen.
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

  IF v_booking.allow_sharing IS DISTINCT FROM p_allow THEN
    UPDATE public.bookings
    SET allow_sharing = p_allow,
        updated_at = NOW()
    WHERE id = p_booking_id;

    PERFORM public.log_audit_event(
      'booking_sharing_changed',
      'bookings',
      p_booking_id,
      jsonb_build_object('allow_sharing', p_allow)
    );
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_booking_allow_sharing(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_booking_allow_sharing(UUID, BOOLEAN) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. daily_room_state: occupants carry allowSharing (0026 definition + one key)
-- ---------------------------------------------------------------------------
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
          'relation', bg.relation,
          'category', b.category,
          'bookingStatus', b.status,
          'checkIn', b.check_in,
          'checkOut', b.check_out,
          'allowSharing', b.allow_sharing
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

GRANT EXECUTE ON FUNCTION public.daily_room_state(DATE, DATE) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. dashboard_counts: a room held by a lone non-sharing occupant has no bookable bed left
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dashboard_counts(p_date DATE)
RETURNS TABLE(
  free_rooms INT,
  one_bed_free_rooms INT,
  full_rooms INT,
  out_of_service_rooms INT,
  people_in_house INT,
  pending_details_count INT,
  arrivals_today INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  RETURN QUERY
  WITH room_metrics AS (
    SELECT
      r.id,
      EXISTS (
        SELECT 1 FROM public.room_closures rc
        WHERE rc.room_id = r.id AND rc.period && daterange(p_date, p_date + 1, '[)')
      ) AS is_closed,
      count(a.id)::INT AS beds_occupied,
      COALESCE(bool_or(NOT b.allow_sharing), FALSE) AS is_held
    FROM public.rooms r
    LEFT JOIN public.allocations a ON a.room_id = r.id
      AND a.status = 'ACTIVE'
      AND a.stay && daterange(p_date, p_date + 1, '[)')
    LEFT JOIN public.bookings b ON b.id = a.booking_id
    WHERE r.room_type <> 'SUITE' AND r.is_active = TRUE
    GROUP BY r.id
  )
  SELECT
    count(*) FILTER (WHERE NOT is_closed AND beds_occupied = 0)::INT AS free_rooms,
    count(*) FILTER (WHERE NOT is_closed AND beds_occupied = 1 AND NOT is_held)::INT AS one_bed_free_rooms,
    count(*) FILTER (WHERE NOT is_closed AND (beds_occupied = 2 OR (beds_occupied = 1 AND is_held)))::INT AS full_rooms,
    count(*) FILTER (WHERE is_closed)::INT AS out_of_service_rooms,
    (
      SELECT count(*)::INT
      FROM public.allocations a
      JOIN public.rooms r ON r.id = a.room_id
      WHERE a.status = 'ACTIVE'
        AND r.room_type <> 'SUITE'
        AND a.stay && daterange(p_date, p_date + 1, '[)')
    ) AS people_in_house,
    (
      SELECT count(*)::INT
      FROM public.booking_guests bg
      JOIN public.bookings b ON b.id = bg.booking_id
      WHERE bg.details = 'PENDING' AND b.status = 'CONFIRMED'
    ) AS pending_details_count,
    (
      SELECT count(*)::INT
      FROM public.bookings b
      WHERE b.check_in = p_date AND b.status = 'CONFIRMED' AND b.is_suite_booking = FALSE
    ) AS arrivals_today
  FROM room_metrics;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dashboard_counts(DATE) TO authenticated;
