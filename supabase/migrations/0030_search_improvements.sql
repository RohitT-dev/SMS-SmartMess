-- 0030_search_improvements.sql
--
--  1. set_booking_guest_details(): the RPC the app has always called to store a guest's name, unit,
--     service number and phone as plain readable columns on booking_guests. It never existed in a
--     migration, and booking_guests is SELECT-only for authenticated (0006/0016), so the app's
--     "direct update" fallback failed silently as well: only guests created through create_booking
--     had a plain name. Name, rank, unit, service number and phone are plain readable data by
--     product decision; ID numbers and remarks stay encrypted in guest_pii (set_guest_pii).
--  2. set_booking_guest_details_batch(): fill-only variant used once per session by the admin
--     backfill that copies names out of the encrypted guest_pii blobs for guests who have none.
--  3. search_bookings_and_guests(): also matches the full rank label ("Flight Lieutenant"), the
--     rank code with spaces ("flt lt"), the booking status, and the stay dates, and escapes
--     LIKE wildcards in the query. Access control is unchanged from 0027: personal-detail
--     matching needs reveal_guest_pii (or admin), suite bookings are admin-only.

-- ---------------------------------------------------------------------------
-- 1. set_booking_guest_details
-- ---------------------------------------------------------------------------
-- NULL argument  = leave the column as it is
-- ''  argument   = clear the column
-- p_fill_only    = only write columns that are currently empty (never overwrite a stored value)
CREATE OR REPLACE FUNCTION public.set_booking_guest_details(
  p_guest_id UUID,
  p_guest_name TEXT,
  p_unit TEXT,
  p_service_number TEXT,
  p_phone TEXT,
  p_fill_only BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_suite BOOLEAN;
  v_name TEXT;
  v_unit TEXT;
  v_sno TEXT;
  v_phone TEXT;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('enter_guest_details')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT b.is_suite_booking INTO v_is_suite
  FROM public.booking_guests bg
  JOIN public.bookings b ON b.id = bg.booking_id
  WHERE bg.id = p_guest_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
  END IF;

  -- Suite bookings are invisible to non-admins everywhere else; they cannot write to them either.
  IF v_is_suite AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  v_name  := LEFT(BTRIM(p_guest_name), 200);
  v_unit  := LEFT(BTRIM(p_unit), 200);
  v_sno   := LEFT(BTRIM(p_service_number), 60);
  v_phone := LEFT(BTRIM(p_phone), 40);

  IF COALESCE(p_fill_only, FALSE) THEN
    UPDATE public.booking_guests bg
    -- "Officer / Guest" is the stand-in the booking form stores when no name was typed: not a name.
    SET guest_name     = CASE WHEN COALESCE(BTRIM(bg.guest_name), '') IN ('', 'Officer / Guest') AND NULLIF(v_name, '') IS NOT NULL
                              THEN v_name ELSE bg.guest_name END,
        unit           = CASE WHEN COALESCE(BTRIM(bg.unit), '') = '' THEN NULLIF(v_unit, '') ELSE bg.unit END,
        service_number = CASE WHEN COALESCE(BTRIM(bg.service_number), '') = '' THEN NULLIF(v_sno, '') ELSE bg.service_number END,
        phone          = CASE WHEN COALESCE(BTRIM(bg.phone), '') = '' THEN NULLIF(v_phone, '') ELSE bg.phone END
    WHERE bg.id = p_guest_id;
  ELSE
    UPDATE public.booking_guests bg
    SET guest_name     = CASE WHEN v_name  IS NULL THEN bg.guest_name     ELSE NULLIF(v_name, '')  END,
        unit           = CASE WHEN v_unit  IS NULL THEN bg.unit           ELSE NULLIF(v_unit, '')  END,
        service_number = CASE WHEN v_sno   IS NULL THEN bg.service_number ELSE NULLIF(v_sno, '')   END,
        phone          = CASE WHEN v_phone IS NULL THEN bg.phone          ELSE NULLIF(v_phone, '') END
    WHERE bg.id = p_guest_id;

    -- Audit that details were written, never what they were.
    PERFORM public.log_audit_event('guest_details_set', 'booking_guests', p_guest_id, '{}'::JSONB);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. set_booking_guest_details_batch (fill-only)
-- ---------------------------------------------------------------------------
-- p_rows: [{ "guest_id": uuid, "guest_name": text, "unit": text, "service_number": text, "phone": text }, ...]
-- Returns how many guests were processed. Each row is subject to the same checks as the single RPC.
CREATE OR REPLACE FUNCTION public.set_booking_guest_details_batch(p_rows JSONB)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row JSONB;
  v_count INT := 0;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('enter_guest_details')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'ERR_INVALID_ROWS' USING errcode = 'P0001';
  END IF;

  IF jsonb_array_length(p_rows) > 200 THEN
    RAISE EXCEPTION 'ERR_INVALID_LIMIT' USING errcode = 'P0001';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    PERFORM public.set_booking_guest_details(
      (v_row ->> 'guest_id')::UUID,
      v_row ->> 'guest_name',
      v_row ->> 'unit',
      v_row ->> 'service_number',
      v_row ->> 'phone',
      TRUE
    );
    v_count := v_count + 1;
  END LOOP;

  IF v_count > 0 THEN
    PERFORM public.log_audit_event(
      'guest_details_backfilled', 'booking_guests', NULL, jsonb_build_object('count', v_count)
    );
  END IF;

  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. search_bookings_and_guests
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_bookings_and_guests(p_query TEXT)
RETURNS TABLE(booking_id UUID, match_source TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_q TEXT;
  v_pat TEXT;
  v_is_admin BOOLEAN;
  v_can_pii BOOLEAN;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  v_q := BTRIM(COALESCE(p_query, ''));
  IF v_q = '' THEN
    RETURN;
  END IF;

  -- The query is literal text: a typed "_" or "%" must not act as a wildcard.
  v_pat := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  v_is_admin := public.is_admin();
  v_can_pii := v_is_admin OR public.has_perm('reveal_guest_pii');

  RETURN QUERY
  -- 1. Guest code or rank, by code ("FLT_LT" / "flt lt") or full label ("Flight Lieutenant")
  SELECT DISTINCT bg.booking_id, 'booking_guest'::TEXT AS match_source
  FROM public.booking_guests bg
  JOIN public.bookings b ON b.id = bg.booking_id
  LEFT JOIN public.ranks r ON r.code = bg.rank_code
  WHERE (b.is_suite_booking = FALSE OR v_is_admin)
    AND (
      bg.guest_code ILIKE v_pat
      OR bg.rank_code::TEXT ILIKE v_pat
      OR replace(bg.rank_code::TEXT, '_', ' ') ILIKE v_pat
      OR r.label ILIKE v_pat
      OR (v_can_pii AND (
        (bg.guest_name IS NOT NULL AND bg.guest_name ILIKE v_pat)
        OR (bg.unit IS NOT NULL AND bg.unit ILIKE v_pat)
        OR (bg.service_number IS NOT NULL AND bg.service_number ILIKE v_pat)
        OR (bg.phone IS NOT NULL AND bg.phone ILIKE v_pat)
      ))
    )

  UNION

  -- 2. Booking id, category, status and stay dates
  SELECT b.id AS booking_id, 'booking'::TEXT AS match_source
  FROM public.bookings b
  WHERE (b.is_suite_booking = FALSE OR v_is_admin)
    AND (
      b.id::TEXT ILIKE v_pat
      OR b.category::TEXT ILIKE v_pat
      OR b.status::TEXT ILIKE v_pat
      OR replace(b.status::TEXT, '_', ' ') ILIKE v_pat
      OR b.check_in::TEXT ILIKE v_pat
      OR b.check_out::TEXT ILIKE v_pat
    )

  UNION

  -- 3. ID number, by exact blind index
  SELECT DISTINCT bg.booking_id, 'blind_index'::TEXT AS match_source
  FROM public.guest_pii gp
  JOIN public.booking_guests bg ON bg.id = gp.guest_id
  JOIN public.bookings b ON b.id = bg.booking_id
  WHERE v_can_pii
    AND (b.is_suite_booking = FALSE OR v_is_admin)
    AND gp.id_blind_index IS NOT NULL AND gp.id_blind_index = v_q;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. EXECUTE privileges (0009 revokes the default PUBLIC/anon grant on new functions)
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.set_booking_guest_details(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_booking_guest_details_batch(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_booking_guest_details(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_booking_guest_details_batch(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_bookings_and_guests(TEXT) TO authenticated;
