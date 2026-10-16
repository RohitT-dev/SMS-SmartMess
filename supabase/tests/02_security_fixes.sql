-- supabase/tests/02_security_fixes.sql
-- Regression tests for 0019_security_review_fixes.sql. Each test acts as a real caller:
-- request.jwt.claims sets auth.uid() / session_id, and SET ROLE authenticated turns RLS on.

BEGIN;
SELECT plan(16);

-- Fixtures (as postgres, RLS bypassed) ------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'admin@sec.test'),
  ('a0000000-0000-0000-0000-000000000002', 'roomclerk@sec.test'),
  ('a0000000-0000-0000-0000-000000000003', 'clerk@sec.test');

INSERT INTO public.profiles (id, role, permissions, is_active) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'admin', ARRAY['create_booking'], TRUE),
  ('a0000000-0000-0000-0000-000000000002', 'clerk', ARRAY['manage_rooms'], TRUE),
  ('a0000000-0000-0000-0000-000000000003', 'clerk', ARRAY['create_booking'], TRUE);

INSERT INTO public.team_key_versions (version, recovery_wrap, recovery_kdf_salt, recovery_kdf_params, is_active)
VALUES (1, 'wrap-under-code', 'salt', '{}'::jsonb, TRUE);

INSERT INTO public.access_codes (version, code_salt, code_hash, team_key_version, team_key_wrap, kdf_salt, kdf_params)
VALUES (1, '\x01'::bytea, public.hash_access_code('\x01'::bytea, '12345678'), 1, 'wrap-under-code', 'salt', '{}'::jsonb);

-- Sessions ...01 (admin) and ...02 (room clerk) have entered the code; ...03 (admin) has not.
INSERT INTO public.code_sessions (session_id, user_id, code_version) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 1),
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 1);

INSERT INTO public.rooms (id, room_type, name_enc, key_version, display_order) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'NORMAL', 'v1.1.n.n', 1, 1),
  ('c0000000-0000-0000-0000-000000000002', 'SUITE', 'v1.1.s.s', 1, 2);

INSERT INTO public.room_closures (id, room_id, period) VALUES
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002',
   daterange(CURRENT_DATE + 30, CURRENT_DATE + 35, '[)'));

-- Switch identity. Called as postgres; the caller then runs SET LOCAL ROLE authenticated.
CREATE FUNCTION pg_temp.act_as(p_user UUID, p_session UUID) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object(
    'sub', p_user, 'session_id', p_session, 'aal', 'aal1', 'role', 'authenticated')::text, TRUE);
$$;

-- Runs a statement as the current role; insufficient_privilege counts as "blocked".
CREATE FUNCTION pg_temp.try_exec(p_sql TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$$;

-- Rows visible to the current role, or 0 when the table is not granted at all.
CREATE FUNCTION pg_temp.visible_rows(p_sql TEXT) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v BIGINT;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN v;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN 0;
END;
$$;

GRANT EXECUTE ON FUNCTION pg_temp.try_exec(TEXT), pg_temp.visible_rows(TEXT) TO authenticated;

-- 1. manage_rooms stops at suites -----------------------------------------------------------
SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002');
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ INSERT INTO public.rooms (room_type, name_enc, key_version, display_order)
     VALUES ('NORMAL', 'v1.1.x.x', 1, 10) $$,
  'manage_rooms clerk can add a normal room'
);

SELECT throws_ok(
  $$ INSERT INTO public.rooms (room_type, name_enc, key_version, display_order)
     VALUES ('SUITE', 'v1.1.y.y', 1, 11) $$,
  '42501', NULL,
  'manage_rooms clerk cannot add a suite'
);

SELECT pg_temp.try_exec($$ UPDATE public.rooms SET display_order = 777 WHERE id = 'c0000000-0000-0000-0000-000000000002' $$);
SELECT pg_temp.try_exec($$ DELETE FROM public.rooms WHERE id = 'c0000000-0000-0000-0000-000000000001' $$);

SELECT throws_ok(
  $$ INSERT INTO public.room_closures (room_id, period)
     VALUES ('c0000000-0000-0000-0000-000000000002', daterange(CURRENT_DATE + 40, CURRENT_DATE + 41, '[)')) $$,
  '42501', NULL,
  'manage_rooms clerk cannot close a suite'
);

SELECT lives_ok(
  $$ INSERT INTO public.room_closures (room_id, period)
     VALUES ('c0000000-0000-0000-0000-000000000001', daterange(CURRENT_DATE + 40, CURRENT_DATE + 41, '[)')) $$,
  'manage_rooms clerk can close a normal room'
);

SELECT throws_matching(
  $$ SELECT public.end_room_closure('d0000000-0000-0000-0000-000000000002') $$,
  'ERR_SUITE_ONLY_ADMIN',
  'manage_rooms clerk cannot end a suite closure'
);

SELECT is(
  pg_temp.visible_rows($$ SELECT count(*) FROM public.room_closures WHERE room_id = 'c0000000-0000-0000-0000-000000000002' $$),
  0::bigint,
  'Non-admins cannot see suite closures'
);

RESET ROLE;

SELECT is(
  (SELECT display_order FROM public.rooms WHERE id = 'c0000000-0000-0000-0000-000000000002'),
  2,
  'manage_rooms clerk cannot edit a suite'
);

SELECT ok(
  EXISTS (SELECT 1 FROM public.rooms WHERE id = 'c0000000-0000-0000-0000-000000000001'),
  'manage_rooms clerk cannot delete rooms'
);

-- 3. Code-wrapped team key needs a code-verified session -------------------------------------
SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003');
SET LOCAL ROLE authenticated;

SELECT is(
  pg_temp.visible_rows($$ SELECT count(*) FROM public.team_key_versions $$),
  0::bigint,
  'Admin without the access code cannot read team_key_versions'
);

-- 4. User administration needs a code-verified session ---------------------------------------
SELECT throws_matching(
  $$ SELECT public.set_user_role('a0000000-0000-0000-0000-000000000003', 'admin') $$,
  'ERR_PERMISSION',
  'Admin without the access code cannot change roles'
);

SELECT throws_matching(
  $$ SELECT public.set_user_permissions('a0000000-0000-0000-0000-000000000003', ARRAY['reveal_guest_pii']) $$,
  'ERR_PERMISSION',
  'Admin without the access code cannot change permissions'
);

SELECT throws_matching(
  $$ SELECT public.deactivate_user('a0000000-0000-0000-0000-000000000003') $$,
  'ERR_PERMISSION',
  'Admin without the access code cannot deactivate users'
);

RESET ROLE;
SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001');
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT public.set_user_permissions('a0000000-0000-0000-0000-000000000003', ARRAY['create_booking', 'view_reports']) $$,
  'Admin with the access code can change permissions'
);

RESET ROLE;

-- 5. Old rotation entry point is retired -----------------------------------------------------
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.finish_rotation(integer, text, text, jsonb)', 'EXECUTE'),
  'authenticated cannot call the 0007 finish_rotation overload'
);

-- 2. Attempt limit still applies (sequential regression check) -------------------------------
SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000004');
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  FOR i IN 1..5 LOOP
    PERFORM public.verify_access_code('00000000');
  END LOOP;
END $$;

SELECT is(
  public.verify_access_code('12345678') ->> 'error',
  'ERR_TOO_MANY_ATTEMPTS',
  'Sixth attempt in 15 minutes is refused even with the right code'
);

RESET ROLE;
SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000005');
SET LOCAL ROLE authenticated;

SELECT is(
  public.verify_access_code('12345678') ->> 'ok',
  'true',
  'Correct code still verifies a fresh session'
);

RESET ROLE;

SELECT finish();
ROLLBACK;
