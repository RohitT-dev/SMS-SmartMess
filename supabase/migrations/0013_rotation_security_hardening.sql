-- 0013_rotation_security_hardening.sql
-- 0010_rotation_pii_reasons.sql has already been pushed to the remote project
-- (`supabase db push`), so it is frozen — these fixes land here instead of
-- amending it. Found during review of 0010 + the rotation sealing flow in
-- apps/app/app/(app)/admin/keys.tsx:
--
-- 1. `grant_key_access` had no check preventing a *pending* user (one with a
--    published public key but no wrap for the currently active key version)
--    from being re-sealed straight into an in-progress rotation's new
--    version — which would grant them access without ever going through
--    admin approval. Only the client (keys.tsx) guarded against this; it is
--    now also enforced here: sealing any NOT-yet-active version requires an
--    existing wrap for the currently active one. The one legitimate way to
--    seal a user with no prior wrap is the explicit "Grant Team Key Access"
--    approval, which always targets the active version and is unaffected.
-- 2. `admin_page_guest_pii` and `reencrypt_batch` are bulk guest_pii
--    read/write paths but, unlike every other guest_pii RPC (get_guest_pii,
--    set_guest_pii, ...), were missing the is_active_device() check that
--    keeps a revoked device's still-valid JWT (up to ~1h) from touching PII.
--    admin_page_guest_pii now also logs each page read.

CREATE OR REPLACE FUNCTION public.grant_key_access(
  p_user_id UUID,
  p_key_version INT,
  p_sealed_team_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_target_is_active BOOLEAN;
  v_active_version INT;
BEGIN
  IF NOT (public.is_admin() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT is_active INTO v_target_is_active
  FROM public.team_key_versions
  WHERE version = p_key_version;

  IF v_target_is_active IS NULL THEN
    RAISE EXCEPTION 'ERR_ROTATION_VERSION' USING errcode = 'P0001';
  END IF;

  IF NOT v_target_is_active THEN
    SELECT version INTO v_active_version FROM public.team_key_versions WHERE is_active = TRUE;

    IF NOT EXISTS (
      SELECT 1 FROM public.user_key_wraps
      WHERE user_id = p_user_id AND key_version = v_active_version
    ) THEN
      RAISE EXCEPTION 'ERR_NOT_PREVIOUSLY_GRANTED' USING errcode = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.user_key_wraps (user_id, key_version, sealed_team_key)
  VALUES (p_user_id, p_key_version, p_sealed_team_key)
  ON CONFLICT (user_id, key_version) DO UPDATE
  SET sealed_team_key = EXCLUDED.sealed_team_key;

  PERFORM public.log_audit_event('key_access_granted', 'user_key_wraps', p_user_id, jsonb_build_object('key_version', p_key_version));
END;
$$;

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
  IF NOT (public.is_admin() AND public.is_aal2() AND public.is_active_device()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  IF p_key_version IS NULL THEN
    RAISE EXCEPTION 'ERR_INVALID_KEY_VERSION' USING errcode = 'P0001';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'ERR_INVALID_LIMIT' USING errcode = 'P0001';
  END IF;

  PERFORM public.log_audit_event('guest_pii_bulk_read', 'guest_pii', NULL, jsonb_build_object(
    'key_version', p_key_version, 'limit', p_limit
  ));

  RETURN QUERY
  SELECT g.guest_id, g.pii_enc, g.key_version
  FROM public.guest_pii g
  WHERE g.key_version = p_key_version
    AND (p_after_guest_id IS NULL OR g.guest_id > p_after_guest_id)
  ORDER BY g.guest_id ASC
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.reencrypt_batch(
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
  -- Mirrors the PII RPCs (set_guest_pii, get_guest_pii, ...): a revoked
  -- device's still-valid JWT must not be able to touch guest_pii, and this
  -- RPC can write it alongside rooms/bookings/denials/evictions/room_closures.
  IF NOT (public.is_admin() AND public.is_aal2() AND public.is_active_device()) THEN
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

-- Signatures are unchanged from 0010, so existing EXECUTE grants to
-- authenticated/service_role carry over automatically; no GRANT/REVOKE needed.
