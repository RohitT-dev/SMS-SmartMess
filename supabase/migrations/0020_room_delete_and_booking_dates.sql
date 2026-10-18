-- 0020_room_delete_and_booking_dates.sql
-- 1. RPC to soft-delete a room (with safety checks for active bookings).
-- 2. RPC to update booking dates (leave early or stay longer) with conflict validation.

-- 1. delete_room
CREATE OR REPLACE FUNCTION public.delete_room(p_room_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_room public.rooms%ROWTYPE;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND (public.has_perm('manage_rooms') OR public.is_admin())) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF NOT FOUND OR v_room.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
  END IF;

  IF v_room.room_type = 'SUITE' AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_SUITE_ONLY_ADMIN' USING errcode = 'P0001';
  END IF;

  -- Safety check: ensure room has no active allocations that extend today or into the future
  IF EXISTS (
    SELECT 1 FROM public.allocations a
    WHERE a.room_id = p_room_id
      AND a.status = 'ACTIVE'
      AND upper(a.stay) > CURRENT_DATE
  ) THEN
    RAISE EXCEPTION 'ERR_ROOM_HAS_ACTIVE_BOOKINGS' USING errcode = 'P0001';
  END IF;

  -- Perform soft deletion
  UPDATE public.rooms
  SET is_active = FALSE,
      deleted_at = NOW(),
      updated_at = NOW()
  WHERE id = p_room_id;

  -- Remove upcoming/future closures for this room
  DELETE FROM public.room_closures
  WHERE room_id = p_room_id AND lower(period) >= CURRENT_DATE;

  -- Terminate any ongoing closure at today
  UPDATE public.room_closures
  SET period = daterange(lower(period), CURRENT_DATE, '[)')
  WHERE room_id = p_room_id AND lower(period) < CURRENT_DATE AND upper(period) > CURRENT_DATE;

  PERFORM public.log_audit_event('room_deleted', 'rooms', p_room_id, jsonb_build_object('room_type', v_room.room_type));
END;
$$;

-- 2. update_booking_dates
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
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND (public.has_perm('create_booking') OR public.is_admin())) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
  END IF;

  IF v_booking.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'ERR_BOOKING_NOT_ACTIVE' USING errcode = 'P0001';
  END IF;

  IF v_booking.is_suite_booking AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'ERR_SUITE_ONLY_ADMIN' USING errcode = 'P0001';
  END IF;

  IF p_new_check_out <= p_new_check_in THEN
    RAISE EXCEPTION 'ERR_INVALID_DATES' USING errcode = 'P0001';
  END IF;

  -- If booking has already started, check-in cannot change and check-out cannot be in the past
  IF v_booking.check_in <= CURRENT_DATE THEN
    IF p_new_check_in <> v_booking.check_in THEN
      RAISE EXCEPTION 'ERR_CANNOT_CHANGE_PAST_CHECKIN' USING errcode = 'P0001';
    END IF;
    IF p_new_check_out < CURRENT_DATE THEN
      RAISE EXCEPTION 'ERR_INVALID_DATES' USING errcode = 'P0001';
    END IF;
  ELSE
    -- For upcoming bookings, non-admin cannot backdate check-in before today
    IF p_new_check_in < CURRENT_DATE AND NOT public.is_admin() THEN
      RAISE EXCEPTION 'ERR_INVALID_DATES: Clerks cannot backdate bookings' USING errcode = 'P0001';
    END IF;
  END IF;

  v_new_stay := daterange(p_new_check_in, p_new_check_out, '[)');

  -- Verify room closures and double-booking for all active allocations
  FOR v_alloc IN
    SELECT a.*
    FROM public.allocations a
    WHERE a.booking_id = p_booking_id AND a.status = 'ACTIVE'
  LOOP
    -- Check closure conflicts
    IF EXISTS (
      SELECT 1 FROM public.room_closures rc
      WHERE rc.room_id = v_alloc.room_id
        AND rc.period && v_new_stay
    ) THEN
      RAISE EXCEPTION 'ERR_ROOM_CLOSED' USING errcode = 'P0001';
    END IF;

    -- Check bed double-booking conflicts with other active allocations
    IF EXISTS (
      SELECT 1 FROM public.allocations a2
      WHERE a2.room_id = v_alloc.room_id
        AND a2.bed_slot = v_alloc.bed_slot
        AND a2.id <> v_alloc.id
        AND a2.status = 'ACTIVE'
        AND a2.stay && v_new_stay
    ) THEN
      RAISE EXCEPTION 'ERR_DOUBLE_BOOKING' USING errcode = 'P0001';
    END IF;

    -- Check one_bed_per_guest conflict
    IF EXISTS (
      SELECT 1 FROM public.allocations a3
      WHERE a3.guest_id = v_alloc.guest_id
        AND a3.id <> v_alloc.id
        AND a3.status = 'ACTIVE'
        AND a3.stay && v_new_stay
    ) THEN
      RAISE EXCEPTION 'one_bed_per_guest' USING errcode = 'P0001';
    END IF;
  END LOOP;

  -- Update booking dates
  UPDATE public.bookings
  SET check_in = p_new_check_in,
      check_out = p_new_check_out,
      updated_at = NOW()
  WHERE id = p_booking_id;

  -- Update active allocations
  UPDATE public.allocations
  SET stay = v_new_stay,
      updated_at = NOW()
  WHERE booking_id = p_booking_id AND status = 'ACTIVE';

  -- Log audit event
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

-- Grant execute permissions to authenticated
GRANT EXECUTE ON FUNCTION public.delete_room(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_booking_dates(UUID, DATE, DATE) TO authenticated;
