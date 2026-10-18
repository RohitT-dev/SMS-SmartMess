-- 0022_unique_guest_id_and_search.sql
-- Assigns unique human-readable guest IDs (GST-XXXX) to each guest,
-- removes the strict requirement for Aadhaar/passport in guest PII and search,
-- and enhances daily room state with occupant guest codes for grid views.

-- 1. Create a sequence and generator for human-readable Guest IDs (GST-1001, GST-1002, ...)
CREATE SEQUENCE IF NOT EXISTS public.guest_code_seq START WITH 1001;

CREATE OR REPLACE FUNCTION public.generate_guest_code()
RETURNS TEXT
LANGUAGE sql
AS $$
  SELECT 'GST-' || LPAD(nextval('public.guest_code_seq')::TEXT, 4, '0');
$$;

-- 2. Add guest_code column to booking_guests
ALTER TABLE public.booking_guests
  ADD COLUMN IF NOT EXISTS guest_code TEXT;

-- Backfill any existing booking_guests that do not have a guest_code
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id FROM public.booking_guests WHERE guest_code IS NULL ORDER BY created_at ASC, id ASC LOOP
    UPDATE public.booking_guests
    SET guest_code = public.generate_guest_code()
    WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE public.booking_guests
  ALTER COLUMN guest_code SET DEFAULT public.generate_guest_code(),
  ALTER COLUMN guest_code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_guests_guest_code ON public.booking_guests(guest_code);

-- 3. Make id_blind_index in guest_pii nullable (Aadhaar / Passport is no longer strictly required)
ALTER TABLE public.guest_pii
  ALTER COLUMN id_blind_index DROP NOT NULL;

-- 4. Update set_guest_pii RPC to allow nullable p_blind
CREATE OR REPLACE FUNCTION public.set_guest_pii(
  p_guest_id UUID,
  p_pii_enc TEXT,
  p_blind TEXT,
  p_key_version INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('enter_guest_details')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  INSERT INTO public.guest_pii (
    guest_id,
    pii_enc,
    id_blind_index,
    key_version,
    updated_by,
    updated_at
  ) VALUES (
    p_guest_id,
    p_pii_enc,
    p_blind,
    p_key_version,
    auth.uid(),
    NOW()
  )
  ON CONFLICT (guest_id) DO UPDATE
  SET pii_enc = EXCLUDED.pii_enc,
      id_blind_index = EXCLUDED.id_blind_index,
      key_version = EXCLUDED.key_version,
      updated_by = auth.uid(),
      updated_at = NOW();

  UPDATE public.booking_guests
  SET details = 'COMPLETE'
  WHERE id = p_guest_id;
END;
$$;

-- 5. Multi-parameter search RPC: Search bookings and guests by any parameter
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
  -- 1. Match by guest_code or rank_code
  SELECT DISTINCT bg.booking_id, 'guest_code'::TEXT AS match_source
  FROM public.booking_guests bg
  WHERE bg.guest_code ILIKE ('%' || v_q || '%')
     OR bg.rank_code ILIKE ('%' || v_q || '%')

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

-- 6. Update daily_room_state to include guestCode in occupants JSON
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
