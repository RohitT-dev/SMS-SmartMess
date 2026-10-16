-- 0018_room_closure_safety.sql
-- Room closure fixes found while testing the Rooms & Data screen:
--
--  1. A closure could be created over a room that still held active bookings. Those guests then
--     stayed allocated to a room the system considered out of service (the dashboard counted it
--     as closed while people were in it, and the booking engine could not see them). Closures are
--     now rejected while any ACTIVE allocation overlaps the period: cancel or move the bookings first.
--  2. Closures were insert-only: a mistaken or finished closure could never be lifted, silently
--     removing the room from inventory for the whole period. end_room_closure() lets someone with
--     manage_rooms end a closure today (or remove one that has not started yet).

CREATE OR REPLACE FUNCTION public.trigger_enforce_closure_safety()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF isempty(NEW.period) OR lower_inf(NEW.period) OR upper_inf(NEW.period) THEN
    RAISE EXCEPTION 'ERR_INVALID_DATES' USING errcode = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.allocations a
    WHERE a.room_id = NEW.room_id
      AND a.status = 'ACTIVE'
      AND a.stay && NEW.period
  ) THEN
    RAISE EXCEPTION 'ERR_ROOM_OCCUPIED' USING errcode = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_room_closures_safety ON public.room_closures;
CREATE TRIGGER trg_room_closures_safety
  BEFORE INSERT ON public.room_closures
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_enforce_closure_safety();

CREATE OR REPLACE FUNCTION public.end_room_closure(p_closure_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_closure public.room_closures%ROWTYPE;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('manage_rooms')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_closure FROM public.room_closures WHERE id = p_closure_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
  END IF;

  IF lower(v_closure.period) >= CURRENT_DATE THEN
    -- Not started yet: remove it entirely.
    DELETE FROM public.room_closures WHERE id = p_closure_id;
  ELSIF upper(v_closure.period) > CURRENT_DATE THEN
    -- In progress: the room is available again from today.
    UPDATE public.room_closures
    SET period = daterange(lower(v_closure.period), CURRENT_DATE, '[)')
    WHERE id = p_closure_id;
  END IF;
  -- Already finished: nothing to do.

  PERFORM public.log_audit_event('room_closure_ended', 'room_closures', p_closure_id,
    jsonb_build_object('room_id', v_closure.room_id));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.end_room_closure(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_room_closure(UUID) TO authenticated;
