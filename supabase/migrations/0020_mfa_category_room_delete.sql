-- 0020_mfa_category_room_delete.sql
--  1. Booking category 'MSA' is renamed 'MFA'. Existing rows follow the enum rename; every function
--     whose body compares against the 'MSA' literal is re-created with 'MFA'.
--  2. Admins can delete rooms. Rooms are never hard-deleted (history keeps pointing at them), so
--     delete_room() soft-deletes: deleted_at is stamped and is_active is cleared, which already
--     keeps the room out of availability, allocation and bed counts.
--  3. Make sure every table the app listens to over Realtime is in the publication.

-- 1. Category rename
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'category' AND t.typnamespace = 'public'::regnamespace AND e.enumlabel = 'MSA'
  ) THEN
    ALTER TYPE public.category RENAME VALUE 'MSA' TO 'MFA';
  END IF;
END $$;

DO $$
DECLARE
  r RECORD;
  v_def TEXT;
BEGIN
  FOR r IN
    SELECT p.oid
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prokind = 'f'
      AND p.prosrc LIKE '%''MSA''%'
  LOOP
    v_def := replace(pg_get_functiondef(r.oid), '''MSA''', '''MFA''');
    EXECUTE v_def;
  END LOOP;
END $$;

-- 2. Admin room deletion (soft)
CREATE OR REPLACE FUNCTION public.delete_room(p_room_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_room public.rooms%ROWTYPE;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.is_admin()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
  END IF;

  -- Current or future stays must be cancelled or moved first.
  IF EXISTS (
    SELECT 1 FROM public.allocations a
    WHERE a.room_id = p_room_id AND a.status = 'ACTIVE' AND upper(a.stay) > CURRENT_DATE
  ) THEN
    RAISE EXCEPTION 'ERR_ROOM_HAS_BOOKINGS' USING errcode = 'P0001';
  END IF;

  -- Drop closures that have not finished; they no longer mean anything.
  DELETE FROM public.room_closures WHERE room_id = p_room_id AND upper(period) > CURRENT_DATE;

  UPDATE public.rooms SET is_active = FALSE, deleted_at = NOW() WHERE id = p_room_id;

  PERFORM public.log_audit_event('room_deleted', 'rooms', p_room_id,
    jsonb_build_object('room_type', v_room.room_type));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_room(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_room(UUID) TO authenticated;

-- 3. Realtime publication
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['allocations', 'bookings', 'rooms', 'room_closures'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      BEGIN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      EXCEPTION WHEN undefined_object THEN NULL;
      END;
    END IF;
  END LOOP;
END $$;
