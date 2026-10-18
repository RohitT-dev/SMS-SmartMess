-- 0031_guest_details_audit.sql
-- Security review follow-up to 0030:
--  * the fill-only path of set_booking_guest_details() (used by the admin backfill) wrote guest
--    details without an audit event; every write is now audited (the guest id only, never values);
--  * fill-only mode and set_booking_guest_details_batch() are admin-only, since the backfill that
--    uses them is admin-only. Clerks keep the normal (audited) single-guest path.
-- Closed and past bookings stay writable on purpose: the backfill exists to name historical guests.

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

  -- Fill-only mode backs the admin backfill; a clerk cannot use it to write unaudited bulk data.
  IF COALESCE(p_fill_only, FALSE) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT b.is_suite_booking INTO v_is_suite
  FROM public.booking_guests bg
  JOIN public.bookings b ON b.id = bg.booking_id
  WHERE bg.id = p_guest_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
  END IF;

  IF v_is_suite AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  v_name  := LEFT(BTRIM(p_guest_name), 200);
  v_unit  := LEFT(BTRIM(p_unit), 200);
  v_sno   := LEFT(BTRIM(p_service_number), 60);
  v_phone := LEFT(BTRIM(p_phone), 40);

  IF COALESCE(p_fill_only, FALSE) THEN
    UPDATE public.booking_guests bg
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
  END IF;

  -- Audit that details were written, never what they were.
  PERFORM public.log_audit_event(
    'guest_details_set',
    'booking_guests',
    p_guest_id,
    jsonb_build_object('fill_only', COALESCE(p_fill_only, FALSE))
  );
END;
$$;

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
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.is_admin()) THEN
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

REVOKE EXECUTE ON FUNCTION public.set_booking_guest_details(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_booking_guest_details_batch(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_booking_guest_details(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_booking_guest_details_batch(JSONB) TO authenticated;
