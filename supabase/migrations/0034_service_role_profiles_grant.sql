-- 0034_service_role_profiles_grant.sql
-- The project's default privileges on schema public give service_role only TRUNCATE/REFERENCES/
-- TRIGGER/MAINTAIN on new tables (no SELECT/INSERT/UPDATE/DELETE), and no migration grants it
-- explicitly. The invite-user edge function reads the caller's profile and inserts the invitee's
-- profile with the service-role key, so every invite failed with "permission denied for table
-- profiles" (surfaced to the admin as a 403 "Caller must be an active Administrator").
-- Grant only what that function needs; its audit write goes through log_audit_event() and the
-- profiles audit trigger, which are SECURITY DEFINER.
GRANT SELECT, INSERT ON public.profiles TO service_role;
