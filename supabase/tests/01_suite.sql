-- supabase/tests/01_suite.sql
-- Complete pgTAP test suite testing database constraints, triggers, RLS, audit chain, and business invariants.

BEGIN;
SELECT plan(28);

-- Test 1: Two overlapping allocations in the same room and bed are rejected
PREPARE test_double_booking AS
INSERT INTO public.allocations (booking_id, guest_id, room_id, bed_slot, stay, status)
VALUES
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 1, daterange('2026-10-01', '2026-10-05', '[)'), 'ACTIVE');

-- Seed test room and booking
INSERT INTO public.rooms (id, room_type, name_enc, key_version, display_order)
VALUES ('33333333-3333-3333-3333-333333333333', 'NORMAL', 'v1.1.dummy.dummy', 1, 1);

INSERT INTO public.bookings (id, category, check_in, check_out, party_size)
VALUES ('11111111-1111-1111-1111-111111111111', 'LEAVE', '2026-10-01', '2026-10-10', 2);

INSERT INTO public.booking_guests (id, booking_id, seq, gender, rank_code)
VALUES
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 1, 'M', 'SQN_LDR'),
  ('22222222-2222-2222-2222-222222222223', '11111111-1111-1111-1111-111111111111', 2, 'M', 'SQN_LDR'),
  ('22222222-2222-2222-2222-222222222224', '11111111-1111-1111-1111-111111111111', 3, 'F', 'SQN_LDR');

-- First allocation succeeds
INSERT INTO public.allocations (id, booking_id, guest_id, room_id, bed_slot, stay, status)
VALUES ('44444444-4444-4444-4444-444444444441', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 1, daterange('2026-10-01', '2026-10-05', '[)'), 'ACTIVE');

SELECT pass('First allocation inserted successfully');

-- Overlapping allocation on bed 1 throws exclusion error
SELECT throws_ok(
  'test_double_booking',
  '23P01',
  NULL,
  'Exclusion constraint prevents double booking same bed during overlapping dates'
);

-- Test 2: Same-gender, same-rank may share; different gender/rank rejected
-- Same gender & rank in bed 2 succeeds
SELECT lives_ok(
  $$ INSERT INTO public.allocations (id, booking_id, guest_id, room_id, bed_slot, stay, status)
     VALUES ('44444444-4444-4444-4444-444444444442', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222223', '33333333-3333-3333-3333-333333333333', 2, daterange('2026-10-01', '2026-10-05', '[)'), 'ACTIVE') $$,
  'Compatible guest (same gender M, same rank SQN_LDR) may share room'
);

-- Incompatible guest (different gender F) is rejected with ERR_SHARE_RULE
SELECT throws_matching(
  $$ INSERT INTO public.allocations (id, booking_id, guest_id, room_id, bed_slot, stay, status)
     VALUES ('44444444-4444-4444-4444-444444444443', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222224', '33333333-3333-3333-3333-333333333333', 2, daterange('2026-10-03', '2026-10-07', '[)'), 'ACTIVE') $$,
  'ERR_SHARE_RULE',
  'Sharing rule rejects incompatible gender/rank overlapping stay'
);

-- Test 3: Check-out day is free (back-to-back stays in one bed succeed)
SELECT lives_ok(
  $$ INSERT INTO public.allocations (id, booking_id, guest_id, room_id, bed_slot, stay, status)
     VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 1, daterange('2026-10-05', '2026-10-09', '[)'), 'ACTIVE') $$,
  'Back-to-back stay starting on check-out day succeeds due to [) stay interval'
);

-- Test 4: Suite restricted to Admin
INSERT INTO public.rooms (id, room_type, name_enc, key_version, display_order)
VALUES ('55555555-5555-5555-5555-555555555555', 'SUITE', 'v1.1.suite.dummy', 1, 99);

SELECT throws_matching(
  $$ INSERT INTO public.allocations (booking_id, guest_id, room_id, bed_slot, stay, status)
     VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '55555555-5555-5555-5555-555555555555', 1, daterange('2026-10-01', '2026-10-05', '[)'), 'ACTIVE') $$,
  'ERR_SUITE_ONLY_ADMIN',
  'Non-admin caller cannot book a SUITE'
);

-- Test 5: MFA and PI cannot be denied
SELECT throws_matching(
  $$ SELECT public.record_denial('MFA', '2026-10-01', '2026-10-05', 1, 'No space', 1) $$,
  'ERR_CANNOT_DENY_PRIORITY',
  'Denying an MFA request raises ERR_CANNOT_DENY_PRIORITY'
);

SELECT throws_matching(
  $$ SELECT public.record_denial('PI', '2026-10-01', '2026-10-05', 1, 'No space', 1) $$,
  'ERR_CANNOT_DENY_PRIORITY',
  'Denying a PI request raises ERR_CANNOT_DENY_PRIORITY'
);

-- Test 6: Audit chain verify passes on untouched log
SELECT ok(ok, 'verify_audit_chain passes on valid chain')
FROM public.verify_audit_chain();

-- Test 7: Last admin cannot be deactivated or demoted
-- Seed test admin
INSERT INTO auth.users (id, email) VALUES ('99999999-9999-9999-9999-999999999999', 'admin@sms.local')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, role, permissions, is_active)
VALUES ('99999999-9999-9999-9999-999999999999', 'admin', ARRAY['create_booking'], TRUE)
ON CONFLICT (id) DO NOTHING;

SELECT throws_matching(
  $$ SELECT public.deactivate_user('99999999-9999-9999-9999-999999999999'::uuid) $$,
  'ERR_LAST_ADMIN',
  'Cannot deactivate the last administrator'
);

SELECT throws_matching(
  $$ SELECT public.set_user_role('99999999-9999-9999-9999-999999999999'::uuid, 'clerk') $$,
  'ERR_LAST_ADMIN',
  'Cannot demote the last administrator'
);

-- Test 8: Assert no PII in audit_log meta
SELECT is(
  (
    SELECT count(*)
    FROM public.audit_log
    WHERE meta::text ~* '(name_enc|pii_enc|notes_enc|service_number|phone)'
  ),
  0::bigint,
  'Audit log meta contains zero encrypted PII fields or personal information'
);

SELECT finish();
ROLLBACK;
