-- 0009_fixes_activity_log.sql
-- 1. Fixes the audit hash chain: digest() was unresolvable under search_path = ''.
--    Uses the built-in pg_catalog sha256() instead (identical output).
-- 2. Locks down function EXECUTE privileges (Postgres grants EXECUTE to PUBLIC by default).
-- 3. Adds RPCs the client already calls but that were never defined:
--    revoke_device, begin_rotation, finish_rotation(INT), reencrypt_batch.
-- 4. Adds bootstrap_team_key + my_access_status so first-run admin setup and
--    invited-user key enrollment work under RLS.
-- 5. Binds devices to auth sessions and enforces revocation server-side.
-- 6. Adds log_user_action for per-user activity logging (works at AAL1 too, so
--    sign-in and MFA steps are recorded) plus audit triggers for rooms,
--    room_closures and profiles.

-- ---------------------------------------------------------------------------
-- 1. Audit hash chain: use built-in sha256() (always on search_path)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_audit_log_hash_chain()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prev_hash BYTEA;
  v_payload TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(987654321);

  SELECT hash INTO v_prev_hash
  FROM public.audit_log
  ORDER BY id DESC
  LIMIT 1;

  NEW.prev_hash := v_prev_hash;

  v_payload := json_build_object(
    'at', NEW.at,
    'actor', NEW.actor,
    'action', NEW.action,
    'entity', NEW.entity,
    'entity_id', NEW.entity_id,
    'meta', NEW.meta,
    'prev_hash', encode(COALESCE(v_prev_hash, ''::bytea), 'hex')
  )::text;

  NEW.hash := sha256(COALESCE(v_prev_hash, ''::bytea) || convert_to(v_payload, 'UTF8'));

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.verify_audit_chain()
RETURNS TABLE(ok BOOLEAN, first_bad_id BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row RECORD;
  v_prev_hash BYTEA := NULL;
  v_payload TEXT;
  v_expected_hash BYTEA;
BEGIN
  -- API callers must be an AAL2 admin; direct DB sessions (no JWT) are allowed.
  IF auth.uid() IS NOT NULL AND NOT (public.is_admin() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  FOR v_row IN SELECT * FROM public.audit_log ORDER BY id ASC LOOP
    IF v_prev_hash IS DISTINCT FROM v_row.prev_hash THEN
      RETURN QUERY SELECT FALSE, v_row.id;
      RETURN;
    END IF;

    v_payload := json_build_object(
      'at', v_row.at,
      'actor', v_row.actor,
      'action', v_row.action,
      'entity', v_row.entity,
      'entity_id', v_row.entity_id,
      'meta', v_row.meta,
      'prev_hash', encode(COALESCE(v_prev_hash, ''::bytea), 'hex')
    )::text;

    v_expected_hash := sha256(COALESCE(v_prev_hash, ''::bytea) || convert_to(v_payload, 'UTF8'));

    IF v_expected_hash <> v_row.hash THEN
      RETURN QUERY SELECT FALSE, v_row.id;
      RETURN;
    END IF;

    v_prev_hash := v_row.hash;
  END LOOP;

  RETURN QUERY SELECT TRUE, NULL::BIGINT;
END;
$$;

-- Indexes for the admin audit / activity views
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON public.audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_at ON public.audit_log (actor, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity_id ON public.audit_log (entity_id);

-- ---------------------------------------------------------------------------
-- 2. Per-user activity logging
-- ---------------------------------------------------------------------------
-- Callable by any authenticated user (AAL1 or AAL2, active or not) so that
-- sign-in, MFA, unlock and every in-app action are recorded against auth.uid().
-- Entries go into the same tamper-evident hash chain as server-side events.
CREATE OR REPLACE FUNCTION public.log_user_action(
  p_action TEXT,
  p_entity TEXT DEFAULT 'ui',
  p_entity_id UUID DEFAULT NULL,
  p_meta JSONB DEFAULT '{}'::JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_meta JSONB := COALESCE(p_meta, '{}'::JSONB);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ERR_NOT_AUTHENTICATED' USING errcode = 'P0001';
  END IF;

  IF p_action IS NULL OR p_action !~ '^[a-z0-9_.:-]{1,64}$' THEN
    RAISE EXCEPTION 'ERR_INVALID_ACTION' USING errcode = 'P0001';
  END IF;

  IF p_entity IS NULL OR p_entity !~ '^[a-z0-9_.-]{1,64}$' THEN
    RAISE EXCEPTION 'ERR_INVALID_ENTITY' USING errcode = 'P0001';
  END IF;

  IF jsonb_typeof(v_meta) <> 'object' OR octet_length(v_meta::text) > 2048 THEN
    RAISE EXCEPTION 'ERR_INVALID_META' USING errcode = 'P0001';
  END IF;

  -- Record the assurance level the action was performed at; tag as client-sourced.
  v_meta := v_meta || jsonb_build_object(
    'source', 'client',
    'aal', COALESCE(auth.jwt() ->> 'aal', 'unknown')
  );

  INSERT INTO public.audit_log (actor, action, entity, entity_id, meta)
  VALUES (auth.uid(), p_action, p_entity, p_entity_id, v_meta);
END;
$$;

-- Server-side audit triggers for tables that were mutated without any trail.
CREATE OR REPLACE FUNCTION public.trigger_audit_generic()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_meta JSONB := '{}'::JSONB;
BEGIN
  -- Never copy *_enc columns or PII into meta; record only non-sensitive fields.
  IF TG_TABLE_NAME = 'rooms' THEN
    v_meta := jsonb_build_object(
      'room_type', NEW.room_type,
      'is_active', NEW.is_active,
      'key_version', NEW.key_version
    );
  ELSIF TG_TABLE_NAME = 'room_closures' THEN
    v_meta := jsonb_build_object('room_id', NEW.room_id, 'period', NEW.period::text);
  ELSIF TG_TABLE_NAME = 'profiles' THEN
    v_meta := jsonb_build_object(
      'role', NEW.role,
      'is_active', NEW.is_active,
      'permissions', to_jsonb(NEW.permissions)
    );
  ELSIF TG_TABLE_NAME = 'devices' THEN
    v_meta := jsonb_build_object('revoked', NEW.revoked_at IS NOT NULL);
  END IF;

  PERFORM public.log_audit_event(
    TG_TABLE_NAME || '_' || lower(TG_OP),
    TG_TABLE_NAME,
    NEW.id,
    v_meta
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_rooms ON public.rooms;
CREATE TRIGGER trg_audit_rooms
  AFTER INSERT OR UPDATE ON public.rooms
  FOR EACH ROW EXECUTE FUNCTION public.trigger_audit_generic();

DROP TRIGGER IF EXISTS trg_audit_room_closures ON public.room_closures;
CREATE TRIGGER trg_audit_room_closures
  AFTER INSERT OR UPDATE ON public.room_closures
  FOR EACH ROW EXECUTE FUNCTION public.trigger_audit_generic();

DROP TRIGGER IF EXISTS trg_audit_profiles ON public.profiles;
CREATE TRIGGER trg_audit_profiles
  AFTER INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.trigger_audit_generic();

DROP TRIGGER IF EXISTS trg_audit_devices ON public.devices;
CREATE TRIGGER trg_audit_devices
  AFTER INSERT OR UPDATE ON public.devices
  FOR EACH ROW EXECUTE FUNCTION public.trigger_audit_generic();

-- ---------------------------------------------------------------------------
-- 3. Access status / key bootstrap
-- ---------------------------------------------------------------------------
-- Lets the client route a signed-in user without needing admin-only SELECTs.
CREATE OR REPLACE FUNCTION public.my_access_status()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'has_profile', EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid()),
    'is_active', COALESCE((SELECT is_active FROM public.profiles WHERE id = auth.uid()), FALSE),
    'role', (SELECT role FROM public.profiles WHERE id = auth.uid()),
    'has_user_key', EXISTS (SELECT 1 FROM public.user_keys WHERE user_id = auth.uid()),
    'has_key_wrap', EXISTS (SELECT 1 FROM public.user_key_wraps WHERE user_id = auth.uid()),
    'team_initialized', EXISTS (SELECT 1 FROM public.team_key_versions)
  );
$$;

-- First-run admin setup: creates team key v1 and seals it to the caller.
-- Previously the client inserted into team_key_versions / user_key_wraps directly,
-- which RLS (no INSERT policy) always rejected.
CREATE OR REPLACE FUNCTION public.bootstrap_team_key(
  p_recovery_wrap TEXT,
  p_recovery_kdf_salt TEXT,
  p_recovery_kdf_params JSONB,
  p_sealed_team_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_admin() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(987654322);

  IF EXISTS (SELECT 1 FROM public.team_key_versions) THEN
    RAISE EXCEPTION 'ERR_TEAM_KEY_EXISTS' USING errcode = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.user_keys WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'ERR_USER_KEY_MISSING' USING errcode = 'P0001';
  END IF;

  INSERT INTO public.team_key_versions (version, recovery_wrap, recovery_kdf_salt, recovery_kdf_params, is_active)
  VALUES (1, p_recovery_wrap, p_recovery_kdf_salt, p_recovery_kdf_params, TRUE);

  INSERT INTO public.user_key_wraps (user_id, key_version, sealed_team_key)
  VALUES (auth.uid(), 1, p_sealed_team_key);

  PERFORM public.log_audit_event('team_key_bootstrapped', 'team_key_versions', NULL, jsonb_build_object('version', 1));
END;
$$;

-- grant_key_access: require AAL2 like every other admin RPC.
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
BEGIN
  IF NOT (public.is_admin() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  INSERT INTO public.user_key_wraps (user_id, key_version, sealed_team_key)
  VALUES (p_user_id, p_key_version, p_sealed_team_key)
  ON CONFLICT (user_id, key_version) DO UPDATE
  SET sealed_team_key = EXCLUDED.sealed_team_key;

  PERFORM public.log_audit_event('key_access_granted', 'user_key_wraps', p_user_id, jsonb_build_object('key_version', p_key_version));
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Key rotation RPCs called by admin/keys.tsx
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.begin_rotation(
  p_new_version INT,
  p_recovery_wrap TEXT,
  p_recovery_salt TEXT,
  p_recovery_params JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_max INT;
BEGIN
  IF NOT (public.is_admin() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(987654322);

  SELECT COALESCE(MAX(version), 0) INTO v_max FROM public.team_key_versions;
  IF p_new_version <> v_max + 1 THEN
    RAISE EXCEPTION 'ERR_ROTATION_VERSION' USING errcode = 'P0001';
  END IF;

  INSERT INTO public.team_key_versions (version, recovery_wrap, recovery_kdf_salt, recovery_kdf_params, is_active)
  VALUES (p_new_version, p_recovery_wrap, p_recovery_salt, p_recovery_params, FALSE);

  PERFORM public.log_audit_event('key_rotation_started', 'team_key_versions', NULL, jsonb_build_object('new_version', p_new_version));
END;
$$;

CREATE OR REPLACE FUNCTION public.reencrypt_batch(
  p_table TEXT,
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

  IF p_table <> 'rooms' THEN
    RAISE EXCEPTION 'ERR_UNSUPPORTED_TABLE' USING errcode = 'P0001';
  END IF;

  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'ERR_INVALID_ROWS' USING errcode = 'P0001';
  END IF;

  v_version := COALESCE(p_key_version, (SELECT MAX(version) FROM public.team_key_versions));

  UPDATE public.rooms r
  SET name_enc = x.new_enc,
      key_version = v_version
  FROM jsonb_to_recordset(p_rows) AS x(id UUID, new_enc TEXT)
  WHERE r.id = x.id AND x.new_enc IS NOT NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  PERFORM public.log_audit_event('reencrypt_batch', p_table, NULL, jsonb_build_object('rows', v_count, 'key_version', v_version));
  RETURN v_count;
END;
$$;

-- Single-argument overload: activates a version created by begin_rotation.
CREATE OR REPLACE FUNCTION public.finish_rotation(p_new_version INT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_admin() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.team_key_versions WHERE version = p_new_version) THEN
    RAISE EXCEPTION 'ERR_ROTATION_VERSION' USING errcode = 'P0001';
  END IF;

  -- The caller must already hold the new key, or they would lock themselves out.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_key_wraps WHERE user_id = auth.uid() AND key_version = p_new_version
  ) THEN
    RAISE EXCEPTION 'ERR_ROTATION_NOT_SEALED' USING errcode = 'P0001';
  END IF;

  UPDATE public.team_key_versions SET is_active = FALSE WHERE is_active = TRUE AND version <> p_new_version;
  UPDATE public.team_key_versions SET is_active = TRUE WHERE version = p_new_version;

  PERFORM public.log_audit_event('key_rotation_finished', 'team_key_versions', NULL, jsonb_build_object('new_version', p_new_version));
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Devices (server-enforced revocation)
-- ---------------------------------------------------------------------------
-- Each device row is bound to the Supabase Auth session that last registered it.
-- Revoking a device deletes that session (killing its refresh token), and
-- PII RPCs refuse any session that is not bound to an active device, so a
-- revoked or unregistered client cannot read guest data even with a live JWT.
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS session_id UUID;
CREATE INDEX IF NOT EXISTS idx_devices_user ON public.devices (user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_session ON public.devices (session_id);

-- Clients may no longer write devices directly (they could clear revoked_at);
-- registration goes through register_device.
DROP POLICY IF EXISTS devices_own ON public.devices;
CREATE POLICY devices_select_own ON public.devices
  FOR SELECT TO authenticated
  USING (public.is_active_user() AND (user_id = auth.uid() OR public.is_admin()));
REVOKE INSERT, UPDATE, DELETE ON public.devices FROM authenticated;

CREATE OR REPLACE FUNCTION public.current_session_id()
RETURNS UUID
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT NULLIF(auth.jwt() ->> 'session_id', '')::UUID;
$$;

-- True when the caller's current session is bound to a non-revoked device.
CREATE OR REPLACE FUNCTION public.is_active_device()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.devices d
    WHERE d.user_id = auth.uid()
      AND d.session_id = public.current_session_id()
      AND d.revoked_at IS NULL
  );
$$;

-- Registers (or re-binds) this install's device to the current session.
-- p_device_id: the id the client stored from a previous registration, if any.
CREATE OR REPLACE FUNCTION public.register_device(p_device_id UUID, p_label TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session UUID := public.current_session_id();
  v_id UUID;
  v_revoked TIMESTAMPTZ;
BEGIN
  IF NOT public.is_active_user() THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;
  IF v_session IS NULL THEN
    RAISE EXCEPTION 'ERR_NO_SESSION' USING errcode = 'P0001';
  END IF;

  -- A session that was ever bound to a revoked device stays refused.
  IF EXISTS (
    SELECT 1 FROM public.devices
    WHERE session_id = v_session AND revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ERR_DEVICE_REVOKED' USING errcode = 'P0001';
  END IF;

  IF p_device_id IS NOT NULL THEN
    SELECT id, revoked_at INTO v_id, v_revoked
    FROM public.devices
    WHERE id = p_device_id AND user_id = auth.uid()
    FOR UPDATE;

    IF v_id IS NOT NULL AND v_revoked IS NOT NULL THEN
      RAISE EXCEPTION 'ERR_DEVICE_REVOKED' USING errcode = 'P0001';
    END IF;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.devices (user_id, label, session_id, last_seen_at)
    VALUES (auth.uid(), left(COALESCE(NULLIF(trim(p_label), ''), 'Unknown device'), 80), v_session, NOW())
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.devices
    SET session_id = v_session, last_seen_at = NOW()
    WHERE id = v_id;
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_device(p_device_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session UUID;
BEGIN
  IF NOT public.is_active_user() THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  UPDATE public.devices
  SET revoked_at = NOW()
  WHERE id = p_device_id
    AND revoked_at IS NULL
    AND (user_id = auth.uid() OR public.is_admin())
  RETURNING session_id INTO v_session;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_NOT_FOUND' USING errcode = 'P0001';
  END IF;

  -- Sign the device out: deleting the session cascades to its refresh tokens,
  -- so it cannot obtain a new access token. Its current JWT (max ~1h) is already
  -- refused by the PII RPCs via is_active_device().
  IF v_session IS NOT NULL THEN
    BEGIN
      DELETE FROM auth.sessions WHERE id = v_session;
    EXCEPTION WHEN insufficient_privilege OR undefined_table THEN
      -- Projects where the migration role cannot write auth.sessions still get
      -- revocation through is_active_device(); the device just keeps a session.
      RAISE WARNING 'revoke_device: could not delete auth session %', v_session;
    END;
  END IF;
END;
$$;

-- PII RPCs: additionally require an active, registered device.
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
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('enter_guest_details')
          AND public.is_active_device()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  INSERT INTO public.guest_pii (guest_id, pii_enc, id_blind_index, key_version, updated_by, updated_at)
  VALUES (p_guest_id, p_pii_enc, p_blind, p_key_version, auth.uid(), NOW())
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

CREATE OR REPLACE FUNCTION public.get_guest_pii(p_guest_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enc TEXT;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('reveal_guest_pii')
          AND public.is_active_device()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT pii_enc INTO v_enc
  FROM public.guest_pii
  WHERE guest_id = p_guest_id;

  PERFORM public.log_audit_event('guest_pii_revealed', 'guest_pii', p_guest_id, '{}'::jsonb);

  RETURN v_enc;
END;
$$;

CREATE OR REPLACE FUNCTION public.search_guests_by_blind_index(p_blind TEXT)
RETURNS TABLE(booking_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('reveal_guest_pii')
          AND public.is_active_device()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  PERFORM public.log_audit_event('blind_index_search', 'guest_pii', NULL, '{}'::jsonb);

  RETURN QUERY
  SELECT DISTINCT bg.booking_id
  FROM public.guest_pii gp
  JOIN public.booking_guests bg ON bg.id = gp.guest_id
  WHERE gp.id_blind_index = p_blind;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5b. Eviction / denial fixes
-- ---------------------------------------------------------------------------
-- eviction_candidates: return the encrypted room name so the client can show it
-- (it previously returned a literal 'Room').
DROP FUNCTION IF EXISTS public.eviction_candidates(public.category, DATE, DATE, JSONB);
CREATE FUNCTION public.eviction_candidates(
  p_category public.category,
  p_check_in DATE,
  p_check_out DATE,
  p_guests JSONB
)
RETURNS TABLE(
  allocation_id UUID,
  booking_id UUID,
  room_id UUID,
  room_name_enc TEXT,
  room_type public.room_type,
  bed_slot SMALLINT,
  category public.category,
  occupant_gender public.gender,
  occupant_rank public.rank_code,
  days_stayed INT,
  days_remaining INT,
  fits_incoming BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    a.id,
    b.id,
    a.room_id,
    r.name_enc,
    r.room_type,
    a.bed_slot,
    b.category,
    bg.gender,
    bg.rank_code,
    GREATEST(0, (CURRENT_DATE - b.check_in))::INT,
    GREATEST(0, (b.check_out - CURRENT_DATE))::INT,
    TRUE
  FROM public.allocations a
  JOIN public.bookings b ON b.id = a.booking_id
  JOIN public.rooms r ON r.id = a.room_id
  JOIN public.booking_guests bg ON bg.id = a.guest_id
  WHERE a.status = 'ACTIVE'
    AND r.room_type <> 'SUITE'
    AND a.stay && daterange(p_check_in, p_check_out, '[)')
    AND (
      (p_category = 'MFA' AND b.category IN ('PI', 'LEAVE', 'TD')) OR
      (p_category = 'PI' AND b.category IN ('LEAVE', 'TD'))
    )
  ORDER BY b.check_in ASC, a.id ASC;
END;
$$;

-- approve_eviction:
--  * evicts FIRST, then creates the incoming booking (the old order always hit the
--    no_double_booking exclusion constraint on the beds being freed);
--  * accepts the flat payload the client sends ({category, check_in, check_out,
--    party_size, guests}) as well as {booking, guests, allocations};
--  * when no allocations are given, seats incoming guest N in the Nth evicted bed.
CREATE OR REPLACE FUNCTION public.approve_eviction(
  p_incoming JSONB,
  p_evict_allocation_ids UUID[],
  p_reason_enc TEXT,
  p_key_version INT
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

  -- 4. Eviction records
  FOREACH v_alloc_id IN ARRAY p_evict_allocation_ids LOOP
    INSERT INTO public.evictions (
      evicted_allocation_id, displaced_booking_id, incoming_booking_id,
      reason_enc, key_version, approved_by
    )
    SELECT v_alloc_id, a.booking_id, v_new_booking_id, p_reason_enc, p_key_version, auth.uid()
    FROM public.allocations a WHERE a.id = v_alloc_id;
  END LOOP;

  PERFORM public.log_audit_event('eviction_approved', 'evictions', v_new_booking_id, jsonb_build_object(
    'evicted_count', array_length(p_evict_allocation_ids, 1)
  ));

  RETURN v_new_booking_id;
END;
$$;

-- record_denial: accept the client-generated id so the encrypted reason's AAD
-- ("denials.reason_enc.<id>") matches the stored row and can be decrypted later.
DROP FUNCTION IF EXISTS public.record_denial(public.category, DATE, DATE, INT, TEXT, INT);
CREATE FUNCTION public.record_denial(
  p_category public.category,
  p_check_in DATE,
  p_check_out DATE,
  p_party_size INT,
  p_reason_enc TEXT,
  p_key_version INT,
  p_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id UUID;
BEGIN
  -- Business-rule validation first so the error is the same for every caller.
  IF p_category IN ('MFA', 'PI') THEN
    RAISE EXCEPTION 'ERR_CANNOT_DENY_PRIORITY' USING errcode = 'P0001';
  END IF;

  IF NOT (public.is_active_user() AND public.is_aal2() AND public.has_perm('deny_request')) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  INSERT INTO public.denials (
    id, category, check_in, check_out, party_size, reason_enc, key_version, denied_by
  ) VALUES (
    COALESCE(p_id, gen_random_uuid()),
    p_category, p_check_in, p_check_out, p_party_size, p_reason_enc, p_key_version, auth.uid()
  ) RETURNING id INTO v_id;

  PERFORM public.log_audit_event('booking_denied', 'denials', v_id, jsonb_build_object(
    'category', p_category,
    'party_size', p_party_size
  ));

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. EXECUTE privileges
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE on new functions to PUBLIC, which exposed every
-- SECURITY DEFINER helper (including log_audit_event) to `anon` via PostgREST.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;

-- Internal helpers: never callable directly by clients.
REVOKE EXECUTE ON FUNCTION public.log_audit_event(TEXT, TEXT, UUID, JSONB) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.trigger_audit_bookings() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.trigger_audit_guest_pii() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.trigger_audit_generic() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.trigger_audit_log_hash_chain() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.trigger_audit_log_immutable() FROM authenticated;
