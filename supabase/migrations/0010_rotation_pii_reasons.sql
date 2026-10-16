-- 0010_rotation_pii_reasons.sql
-- Extends key rotation to cover guest PII and encrypted reasons, which were
-- previously left on the old key version after `finish_rotation` activated
-- the new one (decryptEnvelope only accepts the active key version, so those
-- rows became permanently unreadable once rotated past).
--
-- 1. `reencrypt_batch` gains a `p_column` argument and a strict whitelist of
--    (table, column) pairs covering guest_pii.pii_enc, bookings.cancel_reason_enc,
--    denials.reason_enc, evictions.reason_enc and room_closures.reason_enc,
--    in addition to the existing rooms.name_enc.
-- 2. `admin_page_guest_pii` lets an admin page through guest_pii ciphertexts
--    for re-encryption (guest_pii has no SELECT policy for any role).
-- 3. Evictions AAD fix: multiple eviction rows can share one reason_enc
--    ciphertext (one eviction reason, many evicted beds), encrypted under a
--    client-generated id that was never persisted. Decrypting it later (and
--    re-encrypting it during rotation) requires that id, not the row's own
--    primary key. `evictions.reason_aad_id` now stores it; `approve_eviction`
--    takes it as `p_reason_aad_id`. Existing rows predate this fix and have no
--    recoverable AAD id — see the backfill note below; their reason_enc is,
--    and remains, unrecoverable.

-- ---------------------------------------------------------------------------
-- 1. Evictions AAD fix
-- ---------------------------------------------------------------------------
ALTER TABLE public.evictions ADD COLUMN IF NOT EXISTS reason_aad_id UUID;

-- Backfill: there is no way to recover the original client-generated AAD id
-- for rows written before this migration (it was only ever held in memory on
-- the approving device). Falling back to the row's own id does NOT make
-- those reasons decryptable — they were already unreadable the moment a
-- second eviction row was inserted under a different id with the same
-- ciphertext. This backfill exists only to satisfy the NOT NULL constraint
-- below; it is a documented, accepted data loss for pre-migration rows.
UPDATE public.evictions SET reason_aad_id = id WHERE reason_aad_id IS NULL;

ALTER TABLE public.evictions ALTER COLUMN reason_aad_id SET NOT NULL;

DROP FUNCTION IF EXISTS public.approve_eviction(JSONB, UUID[], TEXT, INT);
CREATE FUNCTION public.approve_eviction(
  p_incoming JSONB,
  p_evict_allocation_ids UUID[],
  p_reason_enc TEXT,
  p_key_version INT,
  p_reason_aad_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_alloc_id UUID;
  v_displaced_booking_id UUID;
  v_new_booking_id UUID;
  v_booking JSONB;
  v_guests JSONB;
  v_allocations JSONB;
  v_beds JSONB := '[]'::JSONB;
  v_idx INT := 0;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('approve_eviction')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  IF p_reason_enc IS NULL OR length(trim(p_reason_enc)) < 10 THEN
    RAISE EXCEPTION 'Eviction reason must be at least 10 characters' USING errcode = 'P0001';
  END IF;

  IF p_reason_aad_id IS NULL THEN
    RAISE EXCEPTION 'ERR_MISSING_REASON_AAD_ID' USING errcode = 'P0001';
  END IF;

  IF p_evict_allocation_ids IS NULL OR array_length(p_evict_allocation_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'ERR_NO_EVICTIONS' USING errcode = 'P0001';
  END IF;

  v_booking := COALESCE(p_incoming->'booking', p_incoming - 'guests' - 'allocations');
  v_guests := COALESCE(p_incoming->'guests', '[]'::JSONB);
  v_allocations := p_incoming->'allocations';

  -- 1. Evict (in the order given) and remember the freed beds
  FOREACH v_alloc_id IN ARRAY p_evict_allocation_ids LOOP
    SELECT a.booking_id INTO v_displaced_booking_id
    FROM public.allocations a
    WHERE a.id = v_alloc_id AND a.status = 'ACTIVE'
    FOR UPDATE;

    IF v_displaced_booking_id IS NULL THEN
      RAISE EXCEPTION 'ERR_ALLOCATION_NOT_ACTIVE' USING errcode = 'P0001';
    END IF;

    v_beds := v_beds || (
      SELECT jsonb_build_object('room_id', a.room_id, 'bed_slot', a.bed_slot)
      FROM public.allocations a WHERE a.id = v_alloc_id
    );

    UPDATE public.allocations SET status = 'EVICTED' WHERE id = v_alloc_id;
    UPDATE public.bookings SET status = 'DISPLACED' WHERE id = v_displaced_booking_id;
  END LOOP;

  -- 2. Default seating: guest seq N -> Nth freed bed
  IF v_allocations IS NULL OR jsonb_array_length(v_allocations) = 0 THEN
    IF jsonb_array_length(v_beds) < jsonb_array_length(v_guests) THEN
      RAISE EXCEPTION 'ERR_NOT_ENOUGH_BEDS: select at least one bed per incoming guest' USING errcode = 'P0001';
    END IF;
    v_allocations := '[]'::JSONB;
    FOR v_idx IN 0 .. jsonb_array_length(v_guests) - 1 LOOP
      v_allocations := v_allocations || jsonb_build_object(
        'guest_seq', COALESCE((v_guests->v_idx->>'seq')::INT, v_idx + 1),
        'room_id', v_beds->v_idx->>'room_id',
        'bed_slot', (v_beds->v_idx->>'bed_slot')::INT
      );
    END LOOP;
  END IF;

  -- 3. Create the incoming booking on the freed beds
  v_new_booking_id := public.create_booking(v_booking, v_guests, v_allocations);

  -- 4. Eviction records (reason_aad_id is shared by every row from this
  --    eviction batch — they all carry the same reason ciphertext, bound to
  --    the same AAD, which is NOT any row's own primary key).
  FOREACH v_alloc_id IN ARRAY p_evict_allocation_ids LOOP
    INSERT INTO public.evictions (
      evicted_allocation_id, displaced_booking_id, incoming_booking_id,
      reason_enc, reason_aad_id, key_version, approved_by
    )
    SELECT v_alloc_id, a.booking_id, v_new_booking_id, p_reason_enc, p_reason_aad_id, p_key_version, auth.uid()
    FROM public.allocations a WHERE a.id = v_alloc_id;
  END LOOP;

  PERFORM public.log_audit_event('eviction_approved', 'evictions', v_new_booking_id, jsonb_build_object(
    'evicted_count', array_length(p_evict_allocation_ids, 1)
  ));

  RETURN v_new_booking_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. reencrypt_batch: whitelist PII + reason columns, require p_column
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.reencrypt_batch(TEXT, JSONB, INT);
CREATE FUNCTION public.reencrypt_batch(
  p_table TEXT,
  p_column TEXT,
  p_rows JSONB,
  p_key_version INT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_version INT;
  v_count INT;
BEGIN
  IF NOT (public.is_admin() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'ERR_INVALID_ROWS' USING errcode = 'P0001';
  END IF;

  v_version := COALESCE(p_key_version, (SELECT MAX(version) FROM public.team_key_versions));

  IF p_table = 'rooms' AND p_column = 'name_enc' THEN
    UPDATE public.rooms r
    SET name_enc = x.new_enc,
        key_version = v_version
    FROM jsonb_to_recordset(p_rows) AS x(id UUID, new_enc TEXT)
    WHERE r.id = x.id AND x.new_enc IS NOT NULL;

  ELSIF p_table = 'guest_pii' AND p_column = 'pii_enc' THEN
    UPDATE public.guest_pii g
    SET pii_enc = x.new_enc,
        key_version = v_version
    FROM jsonb_to_recordset(p_rows) AS x(id UUID, new_enc TEXT)
    WHERE g.guest_id = x.id AND x.new_enc IS NOT NULL;

  ELSIF p_table = 'bookings' AND p_column = 'cancel_reason_enc' THEN
    UPDATE public.bookings b
    SET cancel_reason_enc = x.new_enc,
        key_version = v_version
    FROM jsonb_to_recordset(p_rows) AS x(id UUID, new_enc TEXT)
    WHERE b.id = x.id AND x.new_enc IS NOT NULL;

  ELSIF p_table = 'denials' AND p_column = 'reason_enc' THEN
    UPDATE public.denials d
    SET reason_enc = x.new_enc,
        key_version = v_version
    FROM jsonb_to_recordset(p_rows) AS x(id UUID, new_enc TEXT)
    WHERE d.id = x.id AND x.new_enc IS NOT NULL;

  ELSIF p_table = 'evictions' AND p_column = 'reason_enc' THEN
    -- `id` here still locates the row by its own primary key; the AAD id
    -- (reason_aad_id) is a separate, client-supplied value handled entirely
    -- on the TS side (see packages/crypto/src/rotation.ts) and is untouched
    -- by this UPDATE.
    UPDATE public.evictions e
    SET reason_enc = x.new_enc,
        key_version = v_version
    FROM jsonb_to_recordset(p_rows) AS x(id UUID, new_enc TEXT)
    WHERE e.id = x.id AND x.new_enc IS NOT NULL;

  ELSIF p_table = 'room_closures' AND p_column = 'reason_enc' THEN
    UPDATE public.room_closures c
    SET reason_enc = x.new_enc,
        key_version = v_version
    FROM jsonb_to_recordset(p_rows) AS x(id UUID, new_enc TEXT)
    WHERE c.id = x.id AND x.new_enc IS NOT NULL;

  ELSE
    RAISE EXCEPTION 'ERR_UNSUPPORTED_TABLE' USING errcode = 'P0001';
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  PERFORM public.log_audit_event('reencrypt_batch', p_table, NULL, jsonb_build_object(
    'column', p_column, 'rows', v_count, 'key_version', v_version
  ));
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. admin_page_guest_pii: guest_pii has no SELECT policy for any role, so
--    rotation needs a dedicated admin+AAL2 RPC to page through it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_page_guest_pii(
  p_key_version INT,
  p_after_guest_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 200
)
RETURNS TABLE(guest_id UUID, pii_enc TEXT, key_version INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_admin() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  IF p_key_version IS NULL THEN
    RAISE EXCEPTION 'ERR_INVALID_KEY_VERSION' USING errcode = 'P0001';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'ERR_INVALID_LIMIT' USING errcode = 'P0001';
  END IF;

  RETURN QUERY
  SELECT g.guest_id, g.pii_enc, g.key_version
  FROM public.guest_pii g
  WHERE g.key_version = p_key_version
    AND (p_after_guest_id IS NULL OR g.guest_id > p_after_guest_id)
  ORDER BY g.guest_id ASC
  LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. EXECUTE privileges
-- ---------------------------------------------------------------------------
-- 0009 set default privileges to revoke EXECUTE from PUBLIC/anon for future
-- functions too, but authenticated still needs an explicit grant per function.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_eviction(JSONB, UUID[], TEXT, INT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reencrypt_batch(TEXT, TEXT, JSONB, INT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_page_guest_pii(INT, UUID, INT) TO authenticated, service_role;
