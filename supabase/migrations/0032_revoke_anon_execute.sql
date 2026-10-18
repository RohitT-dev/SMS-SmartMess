-- 0032_revoke_anon_execute.sql
-- Supabase's default privileges let `anon` execute functions created by migrations; earlier migrations
-- revoke that per function, but the functions (re)created by the catch-up deployment did not. They all
-- reject callers without a signed-in active user, so this is hardening, not a fix for an open hole:
-- the anonymous API role should not be able to reach them at all.
REVOKE EXECUTE ON FUNCTION public.allot_booking_rooms(UUID, JSONB) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_booking_request(JSONB, JSONB) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.mess_today() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.record_denial(public.category, DATE, DATE, INT, TEXT, INT, UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.search_bookings_and_guests(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.update_booking_dates(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trigger_enforce_closure_safety() FROM PUBLIC, anon;

-- generate_guest_code() is a column default; pin its search_path (its body already schema-qualifies).
ALTER FUNCTION public.generate_guest_code() SET search_path = '';
