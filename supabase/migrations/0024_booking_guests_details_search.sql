-- 0024_booking_guests_details_search.sql
-- Adds unit, service_number, phone to booking_guests and preferred_room_type to bookings,
-- and updates search_bookings_and_guests to enable universal searching across name, unit, service number, etc.

ALTER TABLE public.booking_guests
  ADD COLUMN IF NOT EXISTS unit TEXT,
  ADD COLUMN IF NOT EXISTS service_number TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS preferred_room_type public.room_type;

-- Update search_bookings_and_guests to search across all guest parameters
CREATE OR REPLACE FUNCTION public.search_bookings_and_guests(p_query TEXT)
RETURNS TABLE(booking_id UUID, match_source TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_q TEXT;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  v_q := TRIM(p_query);
  IF v_q = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  -- 1. Match by guest_code, rank_code, guest_name, unit, service_number, phone
  SELECT DISTINCT bg.booking_id, 'booking_guest'::TEXT AS match_source
  FROM public.booking_guests bg
  WHERE bg.guest_code ILIKE ('%' || v_q || '%')
     OR bg.rank_code::TEXT ILIKE ('%' || v_q || '%')
     OR (bg.guest_name IS NOT NULL AND bg.guest_name ILIKE ('%' || v_q || '%'))
     OR (bg.unit IS NOT NULL AND bg.unit ILIKE ('%' || v_q || '%'))
     OR (bg.service_number IS NOT NULL AND bg.service_number ILIKE ('%' || v_q || '%'))
     OR (bg.phone IS NOT NULL AND bg.phone ILIKE ('%' || v_q || '%'))

  UNION

  -- 2. Match by booking UUID or category
  SELECT b.id AS booking_id, 'booking'::TEXT AS match_source
  FROM public.bookings b
  WHERE b.id::TEXT ILIKE ('%' || v_q || '%')
     OR b.category::TEXT ILIKE ('%' || v_q || '%')

  UNION

  -- 3. Match by blind index if exact match provided
  SELECT DISTINCT bg.booking_id, 'blind_index'::TEXT AS match_source
  FROM public.guest_pii gp
  JOIN public.booking_guests bg ON bg.id = gp.guest_id
  WHERE gp.id_blind_index IS NOT NULL AND gp.id_blind_index = v_q;
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_bookings_and_guests(TEXT) TO authenticated;
