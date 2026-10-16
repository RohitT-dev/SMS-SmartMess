-- 0011_optional_mfa.sql
-- Makes TOTP MFA (AAL2) switchable. While `require_mfa` is FALSE, a password
-- session (AAL1) satisfies every policy and RPC that checks public.is_aal2().
--
-- Turn MFA back on later with:
--   UPDATE public.app_config SET value = 'true'::jsonb WHERE key = 'require_mfa';

CREATE TABLE IF NOT EXISTS public.app_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_config FROM anon, authenticated, PUBLIC;

INSERT INTO public.app_config (key, value)
VALUES ('require_mfa', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.mfa_required()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT (value)::text::boolean FROM public.app_config WHERE key = 'require_mfa'),
    TRUE
  );
$$;

-- Every RLS policy and RPC already calls is_aal2(); redefining it here switches
-- the whole schema at once.
CREATE OR REPLACE FUNCTION public.is_aal2()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT NOT public.mfa_required()
      OR COALESCE((auth.jwt() ->> 'aal') = 'aal2', FALSE);
$$;

-- Expose the flag to the client so it can skip the MFA screen.
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
    'team_initialized', EXISTS (SELECT 1 FROM public.team_key_versions),
    'require_mfa', public.mfa_required()
  );
$$;

REVOKE EXECUTE ON FUNCTION public.mfa_required() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mfa_required() TO authenticated, service_role;
