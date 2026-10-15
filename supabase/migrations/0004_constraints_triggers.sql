-- 0004_constraints_triggers.sql
-- Invariant constraints, exclusion constraints, and business rule triggers.

-- 1. Double-booking prevention: No overlapping active allocations in the same bed
ALTER TABLE public.allocations
  ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (
    room_id WITH =,
    bed_slot WITH =,
    stay WITH &&
  ) WHERE (status = 'ACTIVE');

-- 2. Single guest bed occupancy: One guest cannot occupy multiple beds at overlapping times
ALTER TABLE public.allocations
  ADD CONSTRAINT one_bed_per_guest
  EXCLUDE USING gist (
    guest_id WITH =,
    stay WITH &&
  ) WHERE (status = 'ACTIVE');

-- Helper function to check if caller is admin (declared early for triggers)
CREATE OR REPLACE FUNCTION public.check_is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin' AND is_active = TRUE
  );
$$;

-- 3. Sharing rule trigger: Same gender and rank for overlapping stays in a room
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

  -- Fetch incoming guest gender and rank
  SELECT gender, rank_code INTO v_new_gender, v_new_rank
  FROM public.booking_guests
  WHERE id = NEW.guest_id;

  -- Check other active allocations in the same room with overlapping dates
  SELECT EXISTS (
    SELECT 1
    FROM public.allocations a
    JOIN public.booking_guests bg ON bg.id = a.guest_id
    WHERE a.room_id = NEW.room_id
      AND a.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND a.status = 'ACTIVE'
      AND a.stay && NEW.stay
      AND (bg.gender <> v_new_gender OR bg.rank_code <> v_new_rank)
  ) INTO v_mismatch_exists;

  IF v_mismatch_exists THEN
    RAISE EXCEPTION 'ERR_SHARE_RULE' USING errcode = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_allocations_sharing_rule
  BEFORE INSERT OR UPDATE ON public.allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_enforce_sharing_rule();

-- 4. Suite trigger: Suite bookings require Admin role and is_suite_booking flag
CREATE OR REPLACE FUNCTION public.trigger_enforce_suite_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_room_type public.room_type;
  v_is_suite_booking BOOLEAN;
  v_is_admin BOOLEAN;
BEGIN
  SELECT room_type INTO v_room_type FROM public.rooms WHERE id = NEW.room_id;
  SELECT is_suite_booking INTO v_is_suite_booking FROM public.bookings WHERE id = NEW.booking_id;
  v_is_admin := public.check_is_admin();

  IF v_room_type = 'SUITE' THEN
    IF NOT (v_is_admin AND v_is_suite_booking) THEN
      RAISE EXCEPTION 'ERR_SUITE_ONLY_ADMIN' USING errcode = 'P0001';
    END IF;
  ELSE
    IF v_is_suite_booking THEN
      RAISE EXCEPTION 'ERR_SUITE_ONLY_ADMIN' USING errcode = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_allocations_suite_rule
  BEFORE INSERT OR UPDATE ON public.allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_enforce_suite_rules();

-- 5. Closure trigger: Reject allocations overlapping closed maintenance periods
CREATE OR REPLACE FUNCTION public.trigger_enforce_room_closure()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_closed BOOLEAN;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.room_closures
    WHERE room_id = NEW.room_id AND period && NEW.stay
  ) INTO v_closed;

  IF v_closed THEN
    RAISE EXCEPTION 'ERR_ROOM_CLOSED' USING errcode = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_allocations_closure_rule
  BEFORE INSERT OR UPDATE ON public.allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_enforce_room_closure();

-- 6. Allocation stay must lie within booking stay
CREATE OR REPLACE FUNCTION public.trigger_enforce_allocation_bounds()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_booking_stay DATERANGE;
BEGIN
  SELECT stay INTO v_booking_stay FROM public.bookings WHERE id = NEW.booking_id;

  IF NOT (NEW.stay <@ v_booking_stay) THEN
    RAISE EXCEPTION 'ERR_INVALID_DATES' USING errcode = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_allocations_bounds_rule
  BEFORE INSERT OR UPDATE ON public.allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_enforce_allocation_bounds();

-- 7. Hard DELETE prevention on business tables (Soft delete only)
CREATE OR REPLACE FUNCTION public.trigger_prevent_hard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Hard delete forbidden. Use deleted_at for soft deletion.' USING errcode = 'P0001';
END;
$$;

CREATE TRIGGER trg_no_hard_delete_bookings
  BEFORE DELETE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.trigger_prevent_hard_delete();

CREATE TRIGGER trg_no_hard_delete_allocations
  BEFORE DELETE ON public.allocations
  FOR EACH ROW EXECUTE FUNCTION public.trigger_prevent_hard_delete();

CREATE TRIGGER trg_no_hard_delete_rooms
  BEFORE DELETE ON public.rooms
  FOR EACH ROW EXECUTE FUNCTION public.trigger_prevent_hard_delete();

-- 8. Updated_at auto-maintenance
CREATE OR REPLACE FUNCTION public.trigger_update_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_updated_at_profiles
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.trigger_update_timestamp();

CREATE TRIGGER trg_updated_at_rooms
  BEFORE UPDATE ON public.rooms
  FOR EACH ROW EXECUTE FUNCTION public.trigger_update_timestamp();

CREATE TRIGGER trg_updated_at_bookings
  BEFORE UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.trigger_update_timestamp();

CREATE TRIGGER trg_updated_at_allocations
  BEFORE UPDATE ON public.allocations
  FOR EACH ROW EXECUTE FUNCTION public.trigger_update_timestamp();
