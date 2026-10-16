-- 0021_block_inactive_room_allocations.sql
-- Review follow-up to 0020. delete_room() clears is_active and stamps deleted_at, but the
-- allocation triggers only looked at room_closures, so an RPC or client that named a deleted (or
-- offline) room explicitly could still place a new ACTIVE allocation in it. The room-closure
-- trigger now also rejects new or changed ACTIVE allocations into rooms that are inactive or
-- deleted. The room row is read FOR SHARE so a concurrent delete_room() either waits for the
-- inserting transaction (and then sees the new allocation) or finishes first (and the insert fails).
-- Existing allocations are untouched (no check on unrelated updates).

CREATE OR REPLACE FUNCTION public.trigger_enforce_room_closure()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_closed BOOLEAN;
  v_unavailable BOOLEAN;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.stay IS DISTINCT FROM OLD.stay
     OR NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT NOT (r.is_active AND r.deleted_at IS NULL) INTO v_unavailable
    FROM public.rooms r WHERE r.id = NEW.room_id
    FOR SHARE;  -- serialises with delete_room(), which holds FOR UPDATE on the room
    IF COALESCE(v_unavailable, TRUE) THEN
      RAISE EXCEPTION 'ERR_ROOM_CLOSED' USING errcode = 'P0001';
    END IF;
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
