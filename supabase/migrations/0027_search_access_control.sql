-- 0027_search_access_control.sql
-- Hardens search_bookings_and_guests (0024):
--  * matching on personal details (name, unit, service number, phone, ID blind index) needs the
--    reveal_guest_pii permission (or admin), like reading those details does; without it only
--    guest code, rank, booking id and category match;
--  * suite bookings are searchable by admins only, as everywhere else.

CREATE OR REPLACE FUNCTION public.search_bookings_and_guests(p_query TEXT)
RETURNS TABLE(booking_id UUID, match_source TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_q TEXT;
  v_is_admin BOOLEAN;
  v_can_pii BOOLEAN;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  v_q := TRIM(p_query);
  IF v_q = '' THEN
    RETURN;
  END IF;

  v_is_admin := public.is_admin();
  v_can_pii := v_is_admin OR public.has_perm('reveal_guest_pii');

  RETURN QUERY
  -- 1. Guest code or rank (not personal details)
  SELECT DISTINCT bg.booking_id, 'booking_guest'::TEXT AS match_source
  FROM public.booking_guests bg
  JOIN public.bookings b ON b.id = bg.booking_id
  WHERE (b.is_suite_booking = FALSE OR v_is_admin)
    AND (
      bg.guest_code ILIKE ('%' || v_q || '%')
      OR bg.rank_code::TEXT ILIKE ('%' || v_q || '%')
      OR (v_can_pii AND (
        (bg.guest_name IS NOT NULL AND bg.guest_name ILIKE ('%' || v_q || '%'))
        OR (bg.unit IS NOT NULL AND bg.unit ILIKE ('%' || v_q || '%'))
        OR (bg.service_number IS NOT NULL AND bg.service_number ILIKE ('%' || v_q || '%'))
        OR (bg.phone IS NOT NULL AND bg.phone ILIKE ('%' || v_q || '%'))
      ))
    )

  UNION

  -- 2. Booking id or category
  SELECT b.id AS booking_id, 'booking'::TEXT AS match_source
  FROM public.bookings b
  WHERE (b.is_suite_booking = FALSE OR v_is_admin)
    AND (b.id::TEXT ILIKE ('%' || v_q || '%') OR b.category::TEXT ILIKE ('%' || v_q || '%'))

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

GRANT EXECUTE ON FUNCTION public.search_bookings_and_guests(TEXT) TO authenticated;
