-- 0008_grants_realtime.sql
-- Grants executable permissions on RPCs and configures Realtime publication.

-- 1. Grant execute on RPC functions strictly to authenticated users
GRANT EXECUTE ON FUNCTION public.create_booking(JSONB, JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking(UUID, TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.move_allocation(UUID, UUID, SMALLINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_guest_pii(UUID, TEXT, TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_guest_pii(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_guests_by_blind_index(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.daily_room_state(DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_counts(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.eviction_candidates(public.category, DATE, DATE, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_eviction(JSONB, UUID[], TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_denial(public.category, DATE, DATE, INT, TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_daily(DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_denials(DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_event(TEXT, TEXT, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_role(UUID, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_permissions(UUID, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.deactivate_user(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.publish_user_key(TEXT, TEXT, TEXT, JSONB, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.grant_key_access(UUID, INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finish_rotation(INT, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_audit_chain() TO authenticated;

-- 2. Supabase Realtime publication configuration
-- Only tables holding non-PII operational state are published.
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.allocations;
EXCEPTION
  WHEN duplicate_object THEN null;
  WHEN undefined_object THEN null;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.bookings;
EXCEPTION
  WHEN duplicate_object THEN null;
  WHEN undefined_object THEN null;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;
EXCEPTION
  WHEN duplicate_object THEN null;
  WHEN undefined_object THEN null;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.room_closures;
EXCEPTION
  WHEN duplicate_object THEN null;
  WHEN undefined_object THEN null;
END $$;
