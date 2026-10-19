-- 0033_sharing_and_category_edits.sql
--  1. set_booking_allow_sharing(): the flag can now be changed on any active booking (PENDING_ALLOTMENT
--     or CONFIRMED), including one that already holds beds:
--       - turning sharing ON is always safe (it only relaxes the rule), so an individually allotted
--         room can be opened up for sharing;
--       - turning sharing OFF on an allotted booking is refused with ERR_ROOM_EXCLUSIVE while another
--         booking holds an overlapping ACTIVE allocation in any of its rooms.
--     Other statuses raise ERR_BOOKING_NOT_ACTIVE (was ERR_BOOKING_NOT_PENDING).
--  2. set_booking_category(): change a booking's category (e.g. MFA -> TD) while it is active.
--     Category is eviction/denial priority (MFA > PI > LEAVE > TD; MFA and PI cannot be evicted), so
--     only an admin may move a booking to a HIGHER priority; a clerk may only lower it. Raises
--     ERR_CATEGORY_UPGRADE_ADMIN otherwise. Audited as booking_category_changed with from/to.
--
-- Idempotent: CREATE OR REPLACE.

-- ---------------------------------------------------------------------------
-- 1. set_booking_allow_sharing
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

  IF v_booking.status NOT IN ('PENDING_ALLOTMENT', 'CONFIRMED') THEN
    RAISE EXCEPTION 'ERR_BOOKING_NOT_ACTIVE' USING errcode = 'P0001';
  END IF;

  IF v_booking.is_suite_booking AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_SUITE_ONLY_ADMIN' USING errcode = 'P0001';
  END IF;

  IF v_booking.allow_sharing IS NOT DISTINCT FROM p_allow THEN
    RETURN;
  END IF;

  -- Taking a room back for itself only works while nobody from another booking is beside it.
  IF NOT p_allow THEN
    -- Lock the rooms this booking uses, as the sharing trigger does, so no allotment slips in.
    PERFORM 1 FROM public.rooms r
    WHERE r.id IN (
      SELECT a.room_id FROM public.allocations a
      WHERE a.booking_id = p_booking_id AND a.status = 'ACTIVE'
    )
    ORDER BY r.id
    FOR UPDATE;

    IF EXISTS (
      SELECT 1
      FROM public.allocations mine
      JOIN public.allocations other ON other.room_id = mine.room_id
        AND other.status = 'ACTIVE'
        AND other.booking_id <> mine.booking_id
        AND other.stay && mine.stay
      WHERE mine.booking_id = p_booking_id AND mine.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'ERR_ROOM_EXCLUSIVE' USING errcode = 'P0001';
    END IF;
  END IF;

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
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_booking_allow_sharing(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_booking_allow_sharing(UUID, BOOLEAN) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. set_booking_category
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_booking_category(
  p_booking_id UUID,
  p_category public.category
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

  IF p_category IS NULL THEN
    RAISE EXCEPTION 'ERR_INVALID_REQUEST' USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
  END IF;

  IF v_booking.status NOT IN ('PENDING_ALLOTMENT', 'CONFIRMED') THEN
    RAISE EXCEPTION 'ERR_BOOKING_NOT_ACTIVE' USING errcode = 'P0001';
  END IF;

  IF v_booking.is_suite_booking AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_SUITE_ONLY_ADMIN' USING errcode = 'P0001';
  END IF;

  IF v_booking.category = p_category THEN
    RETURN;
  END IF;

  -- Raising priority protects a booking from eviction and denial: admins only.
  IF array_position(ARRAY['MFA', 'PI', 'LEAVE', 'TD']::public.category[], p_category)
       < array_position(ARRAY['MFA', 'PI', 'LEAVE', 'TD']::public.category[], v_booking.category)
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_CATEGORY_UPGRADE_ADMIN' USING errcode = 'P0001';
  END IF;

  UPDATE public.bookings
  SET category = p_category,
      updated_at = NOW()
  WHERE id = p_booking_id;

  PERFORM public.log_audit_event(
    'booking_category_changed',
    'bookings',
    p_booking_id,
    jsonb_build_object('from', v_booking.category, 'to', p_category)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_booking_category(UUID, public.category) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_booking_category(UUID, public.category) TO authenticated;
