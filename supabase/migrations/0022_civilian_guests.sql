-- 0022_civilian_guests.sql
-- A booking is now one primary ranked person plus any number of companions: further service
-- members, or civilians (family or others) who hold no rank.
--
--  1. booking_guests.relation records who each person is: PRIMARY (the ranked person the booking
--     is for, exactly one per booking), SERVICE (another ranked member of the party), or a
--     civilian: SPOUSE, CHILD, PARENT, OTHER. rank_code is required for PRIMARY/SERVICE and must
--     be NULL for civilians. Existing rows: each booking's first guest becomes PRIMARY, the rest
--     SERVICE (every existing guest is ranked).
--  2. guest_pii.id_blind_index becomes nullable: a civilian (e.g. a child) may have no ID number.
--  3. Sharing rule: people in the same booking may share a room when either of them is a
--     civilian (officer + spouse, two children). Ranked people still share only with the same
--     gender and rank, and a civilian never shares a room with another booking's guests.
--  4. create_booking() stores relation and rejects a party without exactly one ranked PRIMARY.
--  5. daily_room_state() reports each occupant's relation so the client can apply rule 3.
--
-- No new table: booking_guests keeps its existing RLS (select-only, writes through RPCs) and
-- grants, and realtime is unchanged (the app listens on allocations/bookings).

-- 1. Relation
DO $$ BEGIN
  CREATE TYPE public.guest_relation AS ENUM ('PRIMARY', 'SERVICE', 'SPOUSE', 'CHILD', 'PARENT', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE public.booking_guests
  ADD COLUMN IF NOT EXISTS relation public.guest_relation NOT NULL DEFAULT 'SERVICE';

UPDATE public.booking_guests bg
SET relation = 'PRIMARY'
WHERE bg.seq = (SELECT min(x.seq) FROM public.booking_guests x WHERE x.booking_id = bg.booking_id)
  AND bg.relation <> 'PRIMARY';

ALTER TABLE public.booking_guests ALTER COLUMN rank_code DROP NOT NULL;

ALTER TABLE public.booking_guests DROP CONSTRAINT IF EXISTS check_guest_rank_matches_relation;
ALTER TABLE public.booking_guests ADD CONSTRAINT check_guest_rank_matches_relation CHECK (
  (relation IN ('PRIMARY', 'SERVICE')) = (rank_code IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_guests_one_primary
  ON public.booking_guests(booking_id)
  WHERE relation = 'PRIMARY';

-- 2. Civilians may have no ID number
ALTER TABLE public.guest_pii ALTER COLUMN id_blind_index DROP NOT NULL;

-- 3. Sharing rule
CREATE OR REPLACE FUNCTION public.trigger_enforce_sharing_rule()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_gender public.gender;
  v_new_rank public.rank_code;
  v_mismatch_exists BOOLEAN;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  -- Row-level lock on the room to prevent race conditions during concurrent bookings
  PERFORM 1 FROM public.rooms WHERE id = NEW.room_id FOR UPDATE;

  SELECT gender, rank_code INTO v_new_gender, v_new_rank
  FROM public.booking_guests
  WHERE id = NEW.guest_id;

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
        (a.booking_id = NEW.booking_id AND (bg.rank_code IS NULL OR v_new_rank IS NULL))
        -- two ranked people of the same gender and rank
        OR (bg.rank_code IS NOT NULL AND v_new_rank IS NOT NULL
            AND bg.gender = v_new_gender AND bg.rank_code = v_new_rank)
      )
  ) INTO v_mismatch_exists;

  IF v_mismatch_exists THEN
    RAISE EXCEPTION 'ERR_SHARE_RULE' USING errcode = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- 4. create_booking with relation
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
    notes_enc,
    key_version,
    created_by
  ) VALUES (
    v_category,
    'CONFIRMED',
    v_check_in,
    v_check_out,
    v_party_size,
    v_is_suite,
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
      details,
      created_by
    ) VALUES (
      v_booking_id,
      (v_guest->>'seq')::INT,
      (v_guest->>'gender')::public.gender,
      (v_guest->>'rank_code')::public.rank_code,
      v_relation,
      'PENDING',
      auth.uid()
    ) RETURNING id INTO v_guest_id;

    v_guest_map := jsonb_set(v_guest_map, ARRAY[(v_guest->>'seq')::text], to_jsonb(v_guest_id));
  END LOOP;

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

  RETURN v_booking_id;
END;
$$;

-- 5. daily_room_state reports relation
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
          'relation', bg.relation,
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
