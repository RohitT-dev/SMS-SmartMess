-- 0016_table_grants.sql
-- Every table except `ranks` (0002_reference.sql) was missing table-level
-- GRANTs to `authenticated`. RLS policies restrict rows, but Postgres also
-- requires a table-level privilege before RLS is even consulted — without it
-- every direct PostgREST `.from(table).select()/.insert()` call fails with
-- "permission denied for table X", even when the RLS policy would allow the
-- row. RPC calls (SECURITY DEFINER) were unaffected, which is why only the
-- direct-select screens (profiles, rooms, admin rotation, etc.) broke.
--
-- Granted only for the operations the app actually performs directly via
-- `.from()` (everything else goes through RPCs, already granted in
-- 0008_grants_realtime.sql). guest_pii, access_codes, access_code_attempts,
-- code_sessions, and app_config are intentionally left ungranted — they are
-- RPC-only by design.

GRANT SELECT ON public.profiles TO authenticated;
GRANT SELECT, INSERT ON public.rooms TO authenticated;
GRANT SELECT, INSERT ON public.room_closures TO authenticated;
GRANT SELECT ON public.devices TO authenticated;
GRANT SELECT ON public.bookings TO authenticated;
GRANT SELECT ON public.booking_guests TO authenticated;
GRANT SELECT ON public.allocations TO authenticated;
GRANT SELECT ON public.audit_log TO authenticated;
GRANT SELECT ON public.evictions TO authenticated;
GRANT SELECT ON public.denials TO authenticated;
