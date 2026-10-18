-- supabase/tests/03_room_sharing.sql
-- Regression tests for 0029_room_sharing.sql: the "Allow room sharing" option and the relaxed
-- (same gender, any rank) sharing rule. Fixtures are inserted as the table owner (triggers run,
-- RLS is bypassed), like 01_suite.sql.

BEGIN;
SELECT plan(9);

INSERT INTO public.rooms (id, room_type, name_enc, key_version, display_order) VALUES
  ('a3000000-0000-4000-8000-000000000001', 'NORMAL', 'v1.1.dummy.dummy', 1, 901),
  ('a3000000-0000-4000-8000-000000000002', 'NORMAL', 'v1.1.dummy.dummy', 1, 902),
  ('a3000000-0000-4000-8000-000000000003', 'NORMAL', 'v1.1.dummy.dummy', 1, 903),
  ('a3000000-0000-4000-8000-000000000004', 'NORMAL', 'v1.1.dummy.dummy', 1, 904);

-- Bookings 1, 2, 4, 5 allow sharing; 3, 6, 7, 8 do not.
INSERT INTO public.bookings (id, category, check_in, check_out, party_size, allow_sharing) VALUES
  ('b3000000-0000-4000-8000-000000000001', 'LEAVE', '2030-01-01', '2030-01-05', 1, TRUE),
  ('b3000000-0000-4000-8000-000000000002', 'LEAVE', '2030-01-01', '2030-01-05', 1, TRUE),
  ('b3000000-0000-4000-8000-000000000003', 'LEAVE', '2030-01-01', '2030-01-05', 2, FALSE),
  ('b3000000-0000-4000-8000-000000000004', 'LEAVE', '2030-01-01', '2030-01-05', 1, TRUE),
  ('b3000000-0000-4000-8000-000000000005', 'LEAVE', '2030-01-01', '2030-01-05', 1, TRUE),
  ('b3000000-0000-4000-8000-000000000006', 'LEAVE', '2030-01-01', '2030-01-05', 1, FALSE),
  ('b3000000-0000-4000-8000-000000000007', 'LEAVE', '2030-01-05', '2030-01-08', 1, FALSE),
  ('b3000000-0000-4000-8000-000000000008', 'LEAVE', '2030-01-01', '2030-01-05', 1, FALSE);

INSERT INTO public.booking_guests (id, booking_id, seq, gender, rank_code) VALUES
  ('c3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 1, 'M', 'WG_CDR'),
  ('c3000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-000000000002', 1, 'M', 'FO'),
  ('c3000000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-000000000003', 1, 'M', 'FO'),
  ('c3000000-0000-4000-8000-000000000004', 'b3000000-0000-4000-8000-000000000004', 1, 'F', 'FO'),
  ('c3000000-0000-4000-8000-000000000005', 'b3000000-0000-4000-8000-000000000005', 1, 'M', 'FO'),
  ('c3000000-0000-4000-8000-000000000006', 'b3000000-0000-4000-8000-000000000006', 1, 'M', 'FO'),
  ('c3000000-0000-4000-8000-000000000007', 'b3000000-0000-4000-8000-000000000007', 1, 'M', 'FO'),
  ('c3000000-0000-4000-8000-000000000009', 'b3000000-0000-4000-8000-000000000008', 1, 'M', 'FO'),
  -- Booking 3 is a party of two (same exclusive booking, one room).
  ('c3000000-0000-4000-8000-000000000008', 'b3000000-0000-4000-8000-000000000003', 2, 'M', 'SQN_LDR');

-- 1. Existing and new rows: the column exists, is NOT NULL, and defaults to FALSE for new rows.
SELECT is(
  (SELECT column_default FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'allow_sharing'),
  'false',
  'bookings.allow_sharing defaults to FALSE for new bookings'
);

-- 2. Two sharing bookings: same gender, different ranks (WG_CDR beside FO) may share a room.
INSERT INTO public.allocations (id, booking_id, guest_id, room_id, bed_slot, stay, status) VALUES
  ('d3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 1, daterange('2030-01-01', '2030-01-05', '[)'), 'ACTIVE');

SELECT lives_ok(
  $$ INSERT INTO public.allocations (id, booking_id, guest_id, room_id, bed_slot, stay, status)
     VALUES ('d3000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000002',
             'a3000000-0000-4000-8000-000000000001', 2, daterange('2030-01-01', '2030-01-05', '[)'), 'ACTIVE') $$,
  'Two sharing bookings of the same gender and different ranks may share a room'
);

-- 3. A different gender is still refused, even between two sharing bookings.
INSERT INTO public.allocations (id, booking_id, guest_id, room_id, bed_slot, stay, status) VALUES
  ('d3000000-0000-4000-8000-000000000004', 'b3000000-0000-4000-8000-000000000004', 'c3000000-0000-4000-8000-000000000004',
   'a3000000-0000-4000-8000-000000000002', 1, daterange('2030-01-01', '2030-01-05', '[)'), 'ACTIVE');

SELECT throws_matching(
  $$ INSERT INTO public.allocations (id, booking_id, guest_id, room_id, bed_slot, stay, status)
     VALUES ('d3000000-0000-4000-8000-000000000005', 'b3000000-0000-4000-8000-000000000005', 'c3000000-0000-4000-8000-000000000005',
             'a3000000-0000-4000-8000-000000000002', 2, daterange('2030-01-01', '2030-01-05', '[)'), 'ACTIVE') $$,
  'ERR_SHARE_RULE',
  'A different gender cannot share, whatever the rank'
);

-- 4. A party of two in one exclusive booking fills its own room.
INSERT INTO public.allocations (id, booking_id, guest_id, room_id, bed_slot, stay, status) VALUES
  ('d3000000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000003',
   'a3000000-0000-4000-8000-000000000003', 1, daterange('2030-01-01', '2030-01-05', '[)'), 'ACTIVE');

SELECT lives_ok(
  $$ INSERT INTO public.allocations (id, booking_id, guest_id, room_id, bed_slot, stay, status)
     VALUES ('d3000000-0000-4000-8000-000000000008', 'b3000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000008',
             'a3000000-0000-4000-8000-000000000003', 2, daterange('2030-01-01', '2030-01-05', '[)'), 'ACTIVE') $$,
  'A party in one exclusive booking may fill both beds of its room'
);

-- 5. (b) Nobody else may be placed beside an exclusive booking, even a compatible guest.
INSERT INTO public.allocations (id, booking_id, guest_id, room_id, bed_slot, stay, status) VALUES
  ('d3000000-0000-4000-8000-000000000010', 'b3000000-0000-4000-8000-000000000006', 'c3000000-0000-4000-8000-000000000006',
   'a3000000-0000-4000-8000-000000000004', 1, daterange('2030-01-01', '2030-01-05', '[)'), 'ACTIVE');

SELECT throws_matching(
  $$ INSERT INTO public.allocations (id, booking_id, guest_id, room_id, bed_slot, stay, status)
     VALUES ('d3000000-0000-4000-8000-000000000009', 'b3000000-0000-4000-8000-000000000005', 'c3000000-0000-4000-8000-000000000005',
             'a3000000-0000-4000-8000-000000000004', 2, daterange('2030-01-01', '2030-01-05', '[)'), 'ACTIVE') $$,
  'ERR_ROOM_EXCLUSIVE',
  'A different booking cannot take the second bed of a room held by a non-sharing booking'
);

-- 6. (a) A non-sharing booking cannot move in beside a sharing one.
SELECT throws_matching(
  $$ INSERT INTO public.allocations (id, booking_id, guest_id, room_id, bed_slot, stay, status)
     VALUES ('d3000000-0000-4000-8000-000000000006', 'b3000000-0000-4000-8000-000000000008', 'c3000000-0000-4000-8000-000000000009',
             'a3000000-0000-4000-8000-000000000001', 2, daterange('2030-01-02', '2030-01-04', '[)'), 'ACTIVE') $$,
  'ERR_ROOM_EXCLUSIVE',
  'A non-sharing booking cannot be placed in a room another booking occupies'
);

-- 7. Only overlapping dates count: the check-out day of the exclusive stay is free.
SELECT lives_ok(
  $$ INSERT INTO public.allocations (id, booking_id, guest_id, room_id, bed_slot, stay, status)
     VALUES ('d3000000-0000-4000-8000-000000000007', 'b3000000-0000-4000-8000-000000000007', 'c3000000-0000-4000-8000-000000000007',
             'a3000000-0000-4000-8000-000000000003', 2, daterange('2030-01-05', '2030-01-08', '[)'), 'ACTIVE') $$,
  'A booking starting on the check-out day of an exclusive stay may use the room'
);

-- 8. Extending a stay into another booking's dates re-checks the rule (UPDATE fires the trigger).
UPDATE public.bookings SET check_out = '2030-01-07' WHERE id = 'b3000000-0000-4000-8000-000000000003';

SELECT throws_matching(
  $$ UPDATE public.allocations
     SET stay = daterange('2030-01-01', '2030-01-07', '[)')
     WHERE id = 'd3000000-0000-4000-8000-000000000003' $$,
  'ERR_ROOM_EXCLUSIVE',
  'Extending an exclusive stay over another booking is refused'
);

-- 9. daily_room_state reports allowSharing per occupant (the function exists with the new key).
SELECT matches(
  pg_get_functiondef('public.daily_room_state(date, date)'::regprocedure),
  'allowSharing',
  'daily_room_state reports allowSharing for each occupant'
);

SELECT finish();
ROLLBACK;
