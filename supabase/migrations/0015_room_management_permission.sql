-- 0015_room_management_permission.sql
-- Lets an admin grant a clerk the `manage_rooms` permission so they can add
-- rooms and mark closures without being admin. Off by default; admin grants
-- it per-user from the existing permissions editor (set_user_permissions).

ALTER TABLE public.profiles DROP CONSTRAINT check_allowed_permissions;
ALTER TABLE public.profiles ADD CONSTRAINT check_allowed_permissions CHECK (
  permissions <@ ARRAY[
    'create_booking',
    'enter_guest_details',
    'reveal_guest_pii',
    'cancel_booking',
    'approve_eviction',
    'view_reports',
    'deny_request',
    'manage_rooms'
  ]::TEXT[]
);

DROP POLICY IF EXISTS rooms_admin_mutation ON public.rooms;
CREATE POLICY rooms_manage_mutation ON public.rooms
  FOR ALL TO authenticated
  USING (
    public.is_active_user() AND public.is_aal2() AND public.has_perm('manage_rooms')
  )
  WITH CHECK (
    public.is_active_user() AND public.is_aal2() AND public.has_perm('manage_rooms')
  );

DROP POLICY IF EXISTS room_closures_admin ON public.room_closures;
CREATE POLICY room_closures_manage ON public.room_closures
  FOR ALL TO authenticated
  USING (public.is_active_user() AND public.is_aal2() AND public.has_perm('manage_rooms'))
  WITH CHECK (public.is_active_user() AND public.is_aal2() AND public.has_perm('manage_rooms'));
