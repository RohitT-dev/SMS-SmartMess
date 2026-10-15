-- 0006_rls.sql
-- Row Level Security policies and security definer helper functions.

-- 1. Helper functions
CREATE OR REPLACE FUNCTION public.is_aal2()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (auth.jwt() ->> 'aal') = 'aal2',
    FALSE
  );
$$;

CREATE OR REPLACE FUNCTION public.is_active_user()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND is_active = TRUE
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
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

CREATE OR REPLACE FUNCTION public.has_perm(p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND is_active = TRUE
      AND (role = 'admin' OR p_permission = ANY(permissions))
  );
$$;

-- 2. Revoke public/anon access on all tables by default
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, PUBLIC;

-- 3. Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_key_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_key_wraps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_guests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guest_pii ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.denials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- 4. Policies for profiles
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated
  USING (
    public.is_active_user() AND public.is_aal2() AND (id = auth.uid() OR public.is_admin())
  );

CREATE POLICY profiles_update_admin ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user() AND public.is_aal2() AND public.is_admin()
  )
  WITH CHECK (
    public.is_active_user() AND public.is_aal2() AND public.is_admin()
  );

-- 5. Policies for rooms
CREATE POLICY rooms_select ON public.rooms
  FOR SELECT TO authenticated
  USING (
    public.is_active_user() AND public.is_aal2() AND (
      room_type <> 'SUITE' OR public.is_admin()
    )
  );

CREATE POLICY rooms_admin_mutation ON public.rooms
  FOR ALL TO authenticated
  USING (
    public.is_active_user() AND public.is_aal2() AND public.is_admin()
  )
  WITH CHECK (
    public.is_active_user() AND public.is_aal2() AND public.is_admin()
  );

-- 6. Policies for room_closures
CREATE POLICY room_closures_select ON public.room_closures
  FOR SELECT TO authenticated
  USING (public.is_active_user() AND public.is_aal2());

CREATE POLICY room_closures_admin ON public.room_closures
  FOR ALL TO authenticated
  USING (public.is_active_user() AND public.is_aal2() AND public.is_admin())
  WITH CHECK (public.is_active_user() AND public.is_aal2() AND public.is_admin());

-- 7. Policies for bookings, booking_guests, allocations
CREATE POLICY bookings_select ON public.bookings
  FOR SELECT TO authenticated
  USING (
    public.is_active_user() AND public.is_aal2() AND (
      is_suite_booking = FALSE OR public.is_admin()
    )
  );

CREATE POLICY booking_guests_select ON public.booking_guests
  FOR SELECT TO authenticated
  USING (
    public.is_active_user() AND public.is_aal2() AND EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.id = booking_id AND (b.is_suite_booking = FALSE OR public.is_admin())
    )
  );

CREATE POLICY allocations_select ON public.allocations
  FOR SELECT TO authenticated
  USING (
    public.is_active_user() AND public.is_aal2() AND EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.id = booking_id AND (b.is_suite_booking = FALSE OR public.is_admin())
    )
  );

-- NOTE: Direct INSERT / UPDATE / DELETE on bookings, booking_guests, allocations is revoked!
-- All writes must proceed through transactional RPCs.

-- 8. Guest PII table: NO SELECT POLICY FOR ANY ROLE. Strictly accessible via get_guest_pii RPC.
-- (Default deny satisfies this completely).

-- 9. Denials and Evictions
CREATE POLICY denials_select ON public.denials
  FOR SELECT TO authenticated
  USING (public.is_active_user() AND public.is_aal2());

CREATE POLICY evictions_select ON public.evictions
  FOR SELECT TO authenticated
  USING (public.is_active_user() AND public.is_aal2());

-- 10. Audit log: Admin read-only
CREATE POLICY audit_log_select_admin ON public.audit_log
  FOR SELECT TO authenticated
  USING (public.is_active_user() AND public.is_aal2() AND public.is_admin());

-- 11. Key tables
CREATE POLICY user_keys_select ON public.user_keys
  FOR SELECT TO authenticated
  USING (
    public.is_active_user() AND (user_id = auth.uid() OR public.is_admin())
  );

CREATE POLICY user_keys_insert_own ON public.user_keys
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY team_key_versions_select ON public.team_key_versions
  FOR SELECT TO authenticated
  USING (public.is_active_user() AND public.is_admin());

CREATE POLICY user_key_wraps_select ON public.user_key_wraps
  FOR SELECT TO authenticated
  USING (public.is_active_user() AND (user_id = auth.uid() OR public.is_admin()));

CREATE POLICY devices_own ON public.devices
  FOR ALL TO authenticated
  USING (public.is_active_user() AND user_id = auth.uid())
  WITH CHECK (public.is_active_user() AND user_id = auth.uid());
