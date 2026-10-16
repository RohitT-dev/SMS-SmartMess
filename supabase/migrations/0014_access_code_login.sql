-- 0014_access_code_login.sql
-- Simplified login: email + password, then a numeric access code that an
-- Administrator sets for a period. Replaces personal passphrases, per-user
-- keypairs, admin key grants and recovery codes.
--
-- * The code is checked server-side (SHA-256 keyed with a Vault pepper, 5 failed
--   attempts per 15 minutes per user) and marks the current auth session as verified.
-- * public.is_aal2() — which every RLS policy and RPC already calls — now also
--   requires a verified session, so password-only sessions see nothing.
-- * The team encryption key is stored wrapped under the code (Argon2id on the
--   client). Only a verified session receives the wrap.
--   NOTE: a short shared code is far weaker than a personal passphrase; anyone
--   holding a database dump can brute-force it offline. Use 8+ digits.
-- * When a code expires, staff sessions stop working; admins can still verify
--   with the expired code so they can set the next one.

-- ---------------------------------------------------------------------------
-- 1. One-time reset of passphrase-era key material (only if nothing is encrypted yet)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rooms)
     AND NOT EXISTS (SELECT 1 FROM public.room_closures)
     AND NOT EXISTS (SELECT 1 FROM public.bookings)
     AND NOT EXISTS (SELECT 1 FROM public.guest_pii)
     AND NOT EXISTS (SELECT 1 FROM public.denials)
     AND NOT EXISTS (SELECT 1 FROM public.evictions) THEN
    DELETE FROM public.user_key_wraps;
    DELETE FROM public.user_keys;
    DELETE FROM public.team_key_versions;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.access_codes (
  version INT PRIMARY KEY,
  code_salt BYTEA NOT NULL,
  code_hash BYTEA NOT NULL,
  team_key_version INT NOT NULL REFERENCES public.team_key_versions(version) ON DELETE CASCADE,
  team_key_wrap TEXT NOT NULL,
  kdf_salt TEXT NOT NULL,
  kdf_params JSONB NOT NULL,
  valid_until TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_access_codes_single_active
  ON public.access_codes (is_active) WHERE is_active;

-- Auth sessions that entered the active code.
CREATE TABLE IF NOT EXISTS public.code_sessions (
  session_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_version INT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_code_sessions_user ON public.code_sessions (user_id);

CREATE TABLE IF NOT EXISTS public.access_code_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL,
  ok BOOLEAN NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_access_code_attempts_user_at
  ON public.access_code_attempts (user_id, at DESC);

-- Server-only tables: no client access at all; RPCs below are the only path.
ALTER TABLE public.access_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.code_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_code_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.access_codes, public.code_sessions, public.access_code_attempts
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Session gate
-- ---------------------------------------------------------------------------
-- Server-side pepper kept in Supabase Vault (encrypted with a key that lives
-- outside the database), so a table dump alone cannot be used to test codes
-- against code_hash. The Argon2id-wrapped team key is still brute-forceable
-- from a dump, which is why longer codes are recommended.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'access_code_pepper') THEN
    PERFORM vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'access_code_pepper',
      'Pepper for public.hash_access_code (do not rotate without re-setting the access code)'
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.access_code_pepper()
RETURNS BYTEA
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret TEXT;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'access_code_pepper';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'ERR_PEPPER_MISSING' USING errcode = 'P0001';
  END IF;
  RETURN convert_to(v_secret, 'UTF8');
END;
$$;

-- Keyed hash: SHA-256(pepper || salt || code). The code is never logged.
CREATE OR REPLACE FUNCTION public.hash_access_code(p_salt BYTEA, p_code TEXT)
RETURNS BYTEA
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT sha256(public.access_code_pepper() || p_salt || convert_to(p_code, 'UTF8'));
$$;

-- True when the caller's current session entered the active (unexpired) code,
-- or when no code exists yet (first-run admin setup).
CREATE OR REPLACE FUNCTION public.session_code_verified()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.access_codes WHERE is_active)
      OR EXISTS (
        SELECT 1
        FROM public.code_sessions cs
        JOIN public.access_codes ac ON ac.version = cs.code_version AND ac.is_active
        WHERE cs.session_id = public.current_session_id()
          AND cs.user_id = auth.uid()
          AND (ac.valid_until IS NULL OR ac.valid_until > NOW() OR public.is_admin())
      );
$$;

-- Every policy/RPC calls is_aal2(); it now means "fully signed in".
CREATE OR REPLACE FUNCTION public.is_aal2()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (NOT public.mfa_required() OR COALESCE((auth.jwt() ->> 'aal') = 'aal2', FALSE))
     AND public.session_code_verified();
$$;

CREATE OR REPLACE FUNCTION public.mark_session_verified(p_code_version INT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.code_sessions (session_id, user_id, code_version, verified_at)
  VALUES (public.current_session_id(), auth.uid(), p_code_version, NOW())
  ON CONFLICT (session_id) DO UPDATE
  SET code_version = EXCLUDED.code_version, verified_at = NOW(), user_id = EXCLUDED.user_id;
$$;

-- ---------------------------------------------------------------------------
-- 4. RPCs
-- ---------------------------------------------------------------------------
-- Checks the code; on success returns the wrapped team key for this session.
-- Returns {ok:false, error} instead of raising so failed attempts are recorded.
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

CREATE OR REPLACE FUNCTION public.validate_access_code_format(p_code TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF p_code IS NULL OR p_code !~ '^[0-9]{6,12}$' THEN
    RAISE EXCEPTION 'ERR_INVALID_CODE_FORMAT: access code must be 6-12 digits' USING errcode = 'P0001';
  END IF;
END;
$$;

-- Inserts a new active code version wrapping the given team key version.
CREATE OR REPLACE FUNCTION public.store_access_code(
  p_code TEXT,
  p_team_key_version INT,
  p_team_key_wrap TEXT,
  p_kdf_salt TEXT,
  p_kdf_params JSONB,
  p_valid_until TIMESTAMPTZ
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_version INT;
  v_salt BYTEA := decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex');
BEGIN
  PERFORM public.validate_access_code_format(p_code);
  IF p_valid_until IS NOT NULL AND p_valid_until <= NOW() THEN
    RAISE EXCEPTION 'ERR_INVALID_EXPIRY: valid-until must be in the future' USING errcode = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(987654323);
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version FROM public.access_codes;

  UPDATE public.access_codes SET is_active = FALSE WHERE is_active;
  INSERT INTO public.access_codes (
    version, code_salt, code_hash, team_key_version, team_key_wrap,
    kdf_salt, kdf_params, valid_until, is_active, created_by
  ) VALUES (
    v_version, v_salt, public.hash_access_code(v_salt, p_code), p_team_key_version, p_team_key_wrap,
    p_kdf_salt, p_kdf_params, p_valid_until, TRUE, auth.uid()
  );

  -- The admin who set it stays signed in.
  PERFORM public.mark_session_verified(v_version);
  PERFORM public.log_audit_event('access_code_set', 'access_codes', NULL,
    jsonb_build_object('code_version', v_version, 'team_key_version', p_team_key_version,
                       'valid_until', p_valid_until));
  RETURN v_version;
END;
$$;

-- First run: the first Administrator creates the team key and the first code.
CREATE OR REPLACE FUNCTION public.bootstrap_access(
  p_code TEXT,
  p_team_key_wrap TEXT,
  p_kdf_salt TEXT,
  p_kdf_params JSONB,
  p_valid_until TIMESTAMPTZ DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_admin() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(987654322);
  IF EXISTS (SELECT 1 FROM public.team_key_versions) OR EXISTS (SELECT 1 FROM public.access_codes) THEN
    RAISE EXCEPTION 'ERR_ALREADY_INITIALIZED' USING errcode = 'P0001';
  END IF;

  -- recovery_* columns now hold the code-wrapped key (no separate recovery code).
  INSERT INTO public.team_key_versions (version, recovery_wrap, recovery_kdf_salt, recovery_kdf_params, is_active)
  VALUES (1, p_team_key_wrap, p_kdf_salt, p_kdf_params, TRUE);

  PERFORM public.log_audit_event('team_key_bootstrapped', 'team_key_versions', NULL, jsonb_build_object('version', 1));
  RETURN public.store_access_code(p_code, 1, p_team_key_wrap, p_kdf_salt, p_kdf_params, p_valid_until);
END;
$$;

-- Admin sets the code for the next period (re-wrapping the active team key).
CREATE OR REPLACE FUNCTION public.set_access_code(
  p_code TEXT,
  p_team_key_wrap TEXT,
  p_kdf_salt TEXT,
  p_kdf_params JSONB,
  p_valid_until TIMESTAMPTZ DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_team_version INT;
BEGIN
  IF NOT (public.is_admin() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT version INTO v_team_version FROM public.team_key_versions WHERE is_active;
  IF v_team_version IS NULL THEN
    RAISE EXCEPTION 'ERR_NOT_INITIALIZED' USING errcode = 'P0001';
  END IF;

  RETURN public.store_access_code(p_code, v_team_version, p_team_key_wrap, p_kdf_salt, p_kdf_params, p_valid_until);
END;
$$;

-- Key rotation, step 3 (after begin_rotation + reencrypt_batch): activates the new
-- team key and issues a code version wrapping it. begin_rotation's recovery_*
-- arguments carry the new key wrapped under p_code.
CREATE OR REPLACE FUNCTION public.finish_rotation_with_code(
  p_new_version INT,
  p_code TEXT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new public.team_key_versions%ROWTYPE;
  v_valid_until TIMESTAMPTZ;
BEGIN
  IF NOT (public.is_admin() AND public.is_aal2() AND public.is_active_device()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_new FROM public.team_key_versions WHERE version = p_new_version AND NOT is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ERR_ROTATION_VERSION' USING errcode = 'P0001';
  END IF;

  SELECT valid_until INTO v_valid_until FROM public.access_codes WHERE is_active;
  IF v_valid_until IS NOT NULL AND v_valid_until <= NOW() THEN
    v_valid_until := NULL;
  END IF;

  UPDATE public.team_key_versions SET is_active = FALSE WHERE is_active;
  UPDATE public.team_key_versions SET is_active = TRUE WHERE version = p_new_version;

  PERFORM public.log_audit_event('key_rotation_finished', 'team_key_versions', NULL,
    jsonb_build_object('new_version', p_new_version));
  RETURN public.store_access_code(p_code, p_new_version, v_new.recovery_wrap,
    v_new.recovery_kdf_salt, v_new.recovery_kdf_params, v_valid_until);
END;
$$;

-- Admin view of the current code (never the code itself).
CREATE OR REPLACE FUNCTION public.access_code_info()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_admin() AND public.is_aal2()) THEN
    RAISE EXCEPTION 'ERR_PERMISSION' USING errcode = 'P0001';
  END IF;
  RETURN (
    SELECT jsonb_build_object(
      'version', version,
      'team_key_version', team_key_version,
      'valid_until', valid_until,
      'created_at', created_at
    )
    FROM public.access_codes WHERE is_active
  );
END;
$$;

-- Client routing status.
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
    'team_initialized', EXISTS (SELECT 1 FROM public.team_key_versions),
    'has_access_code', EXISTS (SELECT 1 FROM public.access_codes WHERE is_active),
    'require_mfa', public.mfa_required()
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. Privileges
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  public.access_code_pepper(),
  public.hash_access_code(BYTEA, TEXT),
  public.mark_session_verified(INT),
  public.store_access_code(TEXT, INT, TEXT, TEXT, JSONB, TIMESTAMPTZ)
FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION
  public.session_code_verified(),
  public.validate_access_code_format(TEXT),
  public.verify_access_code(TEXT),
  public.bootstrap_access(TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ),
  public.set_access_code(TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ),
  public.finish_rotation_with_code(INT, TEXT),
  public.access_code_info()
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.session_code_verified(),
  public.verify_access_code(TEXT),
  public.bootstrap_access(TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ),
  public.set_access_code(TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ),
  public.finish_rotation_with_code(INT, TEXT),
  public.access_code_info()
TO authenticated;

-- Passphrase-era RPCs are retired.
REVOKE EXECUTE ON FUNCTION
  public.publish_user_key(TEXT, TEXT, TEXT, JSONB, INT),
  public.bootstrap_team_key(TEXT, TEXT, JSONB, TEXT),
  public.finish_rotation(INT)
FROM authenticated;
