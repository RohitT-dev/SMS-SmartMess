-- 0019_security_review_fixes.sql
-- Fixes from a security review of 0014-0018:
--
--  1. manage_rooms reached suites. 0015 gave holders of manage_rooms a FOR ALL policy on rooms
--     and room_closures, so a clerk could create, edit or delete SUITE rooms and close suites,
--     bypassing the admin-only suite rule (rooms_select, ERR_SUITE_ONLY_ADMIN). manage_rooms now
--     covers INSERT/UPDATE of non-suite rooms and INSERT of closures on non-suite rooms. Deletes
--     and anything touching a suite are admin-only. Ending a closure stays on end_room_closure(),
--     which now refuses suites for non-admins.
--  2. The access-code attempt limit could be raced. verify_access_code counted failures and
--     recorded the new one in separate steps, so parallel guesses all saw the same count. Attempts
--     are now serialized per user with a transaction-scoped advisory lock.
--  3. A password-only admin session could read the code-wrapped team key. team_key_versions_select
--     did not require a verified session, so an admin password alone was enough to copy
--     recovery_wrap and brute-force the access code offline. It now requires is_aal2(), the same
--     gate that releases the wrap through verify_access_code.
--  4. User administration skipped the access code. set_user_role, set_user_permissions and
--     deactivate_user only checked is_admin(), so a stolen admin password could promote, re-permission
--     or disable staff without the code. They now require is_active_user() AND is_aal2().
--  5. The original finish_rotation(INT, TEXT, TEXT, JSONB) from 0007 was still executable. 0014 only
--     revoked the 1-argument overload. The 4-argument one checked is_admin() alone and could switch
--     the active team key. It is revoked; rotation goes through finish_rotation_with_code().

-- 1. Rooms: admins keep full control; manage_rooms is limited to non-suite insert/update.
DROP POLICY IF EXISTS rooms_manage_mutation ON public.rooms;
DROP POLICY IF EXISTS rooms_admin_mutation ON public.rooms;

CREATE POLICY rooms_admin_mutation ON public.rooms
  FOR ALL TO authenticated
  USING (public.is_active_user() AND public.is_aal2() AND public.is_admin())
  WITH CHECK (public.is_active_user() AND public.is_aal2() AND public.is_admin());

CREATE POLICY rooms_manage_insert ON public.rooms
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user() AND public.is_aal2() AND public.has_perm('manage_rooms')
    AND room_type <> 'SUITE'
  );

CREATE POLICY rooms_manage_update ON public.rooms
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user() AND public.is_aal2() AND public.has_perm('manage_rooms')
    AND room_type <> 'SUITE'
  )
  WITH CHECK (
    public.is_active_user() AND public.is_aal2() AND public.has_perm('manage_rooms')
    AND room_type <> 'SUITE'
  );

-- Room closures: same split. Non-admins never see or touch closures on suites.
DROP POLICY IF EXISTS room_closures_manage ON public.room_closures;
DROP POLICY IF EXISTS room_closures_admin ON public.room_closures;
DROP POLICY IF EXISTS room_closures_select ON public.room_closures;

CREATE POLICY room_closures_select ON public.room_closures
  FOR SELECT TO authenticated
  USING (
    public.is_active_user() AND public.is_aal2() AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = room_closures.room_id AND r.room_type <> 'SUITE'
      )
    )
  );

CREATE POLICY room_closures_admin ON public.room_closures
  FOR ALL TO authenticated
  USING (public.is_active_user() AND public.is_aal2() AND public.is_admin())
  WITH CHECK (public.is_active_user() AND public.is_aal2() AND public.is_admin());

CREATE POLICY room_closures_manage_insert ON public.room_closures
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user() AND public.is_aal2() AND public.has_perm('manage_rooms')
    AND EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_closures.room_id AND r.room_type <> 'SUITE'
    )
  );

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

  IF NOT public.is_admin() AND EXISTS (
    SELECT 1 FROM public.rooms r WHERE r.id = v_closure.room_id AND r.room_type = 'SUITE'
  ) THEN
    RAISE EXCEPTION 'ERR_SUITE_ONLY_ADMIN' USING errcode = 'P0001';
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

-- 2. Serialize access-code attempts per user so the 5-per-15-minutes limit holds under parallel calls.
CREATE OR REPLACE FUNCTION public.verify_access_code(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code public.access_codes%ROWTYPE;
  v_failures INT;
BEGIN
  IF auth.uid() IS NULL OR public.current_session_id() IS NULL THEN
    RAISE EXCEPTION 'ERR_NOT_AUTHENTICATED' USING errcode = 'P0001';
  END IF;
  IF NOT public.is_active_user() THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'ERR_ACCOUNT_INACTIVE');
  END IF;
  IF public.mfa_required() AND COALESCE(auth.jwt() ->> 'aal', '') <> 'aal2' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'ERR_MFA_REQUIRED');
  END IF;

  -- Held until this call's transaction ends: a second attempt by the same user waits here and
  -- then counts this attempt's failure row.
  PERFORM pg_advisory_xact_lock(hashtext('verify_access_code'), hashtext(auth.uid()::text));

  SELECT count(*) INTO v_failures
  FROM public.access_code_attempts
  WHERE user_id = auth.uid() AND NOT ok AND at > NOW() - INTERVAL '15 minutes';
  IF v_failures >= 5 THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'ERR_TOO_MANY_ATTEMPTS');
  END IF;

  SELECT * INTO v_code FROM public.access_codes WHERE is_active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'ERR_NO_ACCESS_CODE');
  END IF;

  IF p_code IS NULL OR public.hash_access_code(v_code.code_salt, trim(p_code)) <> v_code.code_hash THEN
    INSERT INTO public.access_code_attempts (user_id, ok) VALUES (auth.uid(), FALSE);
    PERFORM public.log_audit_event('access_code_failed', 'access_codes', NULL,
      jsonb_build_object('code_version', v_code.version));
    RETURN jsonb_build_object('ok', FALSE, 'error', 'ERR_INVALID_CODE',
      'attempts_left', GREATEST(0, 4 - v_failures));
  END IF;

  IF v_code.valid_until IS NOT NULL AND v_code.valid_until <= NOW() AND NOT public.is_admin() THEN
    PERFORM public.log_audit_event('access_code_expired', 'access_codes', NULL,
      jsonb_build_object('code_version', v_code.version));
    RETURN jsonb_build_object('ok', FALSE, 'error', 'ERR_CODE_EXPIRED');
  END IF;

  INSERT INTO public.access_code_attempts (user_id, ok) VALUES (auth.uid(), TRUE);
  PERFORM public.mark_session_verified(v_code.version);
  PERFORM public.log_audit_event('access_code_verified', 'access_codes', NULL,
    jsonb_build_object('code_version', v_code.version));

  RETURN jsonb_build_object(
    'ok', TRUE,
    'code_version', v_code.version,
    'team_key_version', v_code.team_key_version,
    'team_key_wrap', v_code.team_key_wrap,
    'kdf_salt', v_code.kdf_salt,
    'kdf_params', v_code.kdf_params,
    'valid_until', v_code.valid_until
  );
END;
$$;

-- 3. The code-wrapped team key is only readable from a code-verified session.
DROP POLICY IF EXISTS team_key_versions_select ON public.team_key_versions;
CREATE POLICY team_key_versions_select ON public.team_key_versions
  FOR SELECT TO authenticated
  USING (public.is_active_user() AND public.is_aal2() AND public.is_admin());

-- 4. User administration requires a code-verified admin session.
CREATE OR REPLACE FUNCTION public.set_user_role(p_user_id UUID, p_role public.app_role)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin_count INT;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.is_admin()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  IF p_role <> 'admin' THEN
    SELECT count(*) INTO v_admin_count
    FROM public.profiles
    WHERE role = 'admin' AND is_active = TRUE;

    IF v_admin_count <= 1 AND EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id AND role = 'admin') THEN
      RAISE EXCEPTION 'ERR_LAST_ADMIN' USING errcode = 'P0001';
    END IF;
  END IF;

  UPDATE public.profiles
  SET role = p_role
  WHERE id = p_user_id;

  PERFORM public.log_audit_event('role_updated', 'profiles', p_user_id, jsonb_build_object('new_role', p_role));
END;
$$;

CREATE OR REPLACE FUNCTION public.deactivate_user(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin_count INT;
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.is_admin()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT count(*) INTO v_admin_count
  FROM public.profiles
  WHERE role = 'admin' AND is_active = TRUE;

  IF v_admin_count <= 1 AND EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id AND role = 'admin') THEN
    RAISE EXCEPTION 'ERR_LAST_ADMIN' USING errcode = 'P0001';
  END IF;

  UPDATE public.profiles
  SET is_active = FALSE
  WHERE id = p_user_id;

  PERFORM public.log_audit_event('user_deactivated', 'profiles', p_user_id, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_user_permissions(p_user_id UUID, p_permissions TEXT[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_active_user() AND public.is_aal2() AND public.is_admin()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  UPDATE public.profiles
  SET permissions = p_permissions
  WHERE id = p_user_id;

  PERFORM public.log_audit_event('permissions_updated', 'profiles', p_user_id, jsonb_build_object('permissions', p_permissions));
END;
$$;

-- 5. Retire the 0007 rotation entry point.
REVOKE EXECUTE ON FUNCTION public.finish_rotation(INT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
