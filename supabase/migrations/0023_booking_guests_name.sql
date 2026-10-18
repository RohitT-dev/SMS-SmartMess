-- 0023_booking_guests_name.sql
-- Adds guest_name to booking_guests to guarantee guest name availability on boards, registers, and requests.

ALTER TABLE public.booking_guests
  ADD COLUMN IF NOT EXISTS guest_name TEXT;
