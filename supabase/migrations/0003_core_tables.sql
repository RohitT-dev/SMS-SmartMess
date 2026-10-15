-- 0003_core_tables.sql
-- Core business and cryptographic envelope tables.

-- 1. Profiles
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL DEFAULT 'clerk',
  permissions TEXT[] NOT NULL DEFAULT ARRAY['create_booking', 'enter_guest_details', 'view_reports', 'deny_request'],
  display_name_enc TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT check_allowed_permissions CHECK (
    permissions <@ ARRAY[
      'create_booking',
      'enter_guest_details',
      'reveal_guest_pii',
      'cancel_booking',
      'approve_eviction',
      'view_reports',
      'deny_request'
    ]::TEXT[]
  )
);

-- 2. User Keys (X25519 keypairs wrapped under passphrase)
CREATE TABLE IF NOT EXISTS public.user_keys (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  enc_private_key TEXT NOT NULL,
  kdf_salt TEXT NOT NULL,
  kdf_params JSONB NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Team Key Versions (Master symmetric key wrapped under recovery code)
CREATE TABLE IF NOT EXISTS public.team_key_versions (
  version INT PRIMARY KEY,
  recovery_wrap TEXT NOT NULL,
  recovery_kdf_salt TEXT NOT NULL,
  recovery_kdf_params JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_key_versions_single_active
  ON public.team_key_versions(is_active)
  WHERE (is_active = TRUE);

-- 4. User Key Wraps (Team key sealed to individual users' public keys)
CREATE TABLE IF NOT EXISTS public.user_key_wraps (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_version INT NOT NULL REFERENCES public.team_key_versions(version) ON DELETE CASCADE,
  sealed_team_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key_version)
);

-- 5. Devices (Session tracking)
CREATE TABLE IF NOT EXISTS public.devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Rooms
CREATE TABLE IF NOT EXISTS public.rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_type public.room_type NOT NULL,
  name_enc TEXT NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  display_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  capacity SMALLINT NOT NULL DEFAULT 2 CHECK (capacity = 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- 7. Room Closures (Maintenance / out-of-service periods)
CREATE TABLE IF NOT EXISTS public.room_closures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  period DATERANGE NOT NULL,
  reason_enc TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Bookings
CREATE TABLE IF NOT EXISTS public.bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category public.category NOT NULL,
  status public.booking_status NOT NULL DEFAULT 'CONFIRMED',
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  stay DATERANGE GENERATED ALWAYS AS (daterange(check_in, check_out, '[)')) STORED,
  party_size INT NOT NULL CHECK (party_size BETWEEN 1 AND 40),
  is_suite_booking BOOLEAN NOT NULL DEFAULT FALSE,
  notes_enc TEXT,
  key_version INT NOT NULL DEFAULT 1,
  created_by UUID REFERENCES auth.users(id),
  cancelled_at TIMESTAMPTZ,
  cancel_reason_enc TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT check_stay_dates CHECK (check_out > check_in)
);

-- 9. Booking Guests (Demographics required for sharing rule)
CREATE TABLE IF NOT EXISTS public.booking_guests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  gender public.gender NOT NULL,
  rank_code public.rank_code NOT NULL REFERENCES public.ranks(code),
  details public.details_status NOT NULL DEFAULT 'PENDING',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(booking_id, seq)
);

-- 10. Guest PII (Strictly isolated ciphertext blob, zero direct SELECT policy)
CREATE TABLE IF NOT EXISTS public.guest_pii (
  guest_id UUID PRIMARY KEY REFERENCES public.booking_guests(id) ON DELETE CASCADE,
  pii_enc TEXT NOT NULL,
  id_blind_index TEXT NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  updated_by UUID REFERENCES auth.users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guest_pii_blind_index ON public.guest_pii(id_blind_index);

-- 11. Allocations (Individual bed assignments)
CREATE TABLE IF NOT EXISTS public.allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  guest_id UUID NOT NULL REFERENCES public.booking_guests(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  bed_slot SMALLINT NOT NULL CHECK (bed_slot IN (1, 2)),
  stay DATERANGE NOT NULL,
  status public.allocation_status NOT NULL DEFAULT 'ACTIVE',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- 12. Denials
CREATE TABLE IF NOT EXISTS public.denials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category public.category NOT NULL,
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  party_size INT NOT NULL,
  reason_enc TEXT NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  denied_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 13. Evictions
CREATE TABLE IF NOT EXISTS public.evictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evicted_allocation_id UUID NOT NULL REFERENCES public.allocations(id),
  displaced_booking_id UUID NOT NULL REFERENCES public.bookings(id),
  incoming_booking_id UUID NOT NULL REFERENCES public.bookings(id),
  reason_enc TEXT NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  approved_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 14. Audit Log (Cryptographically chained audit trail)
CREATE TABLE IF NOT EXISTS public.audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor UUID,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id UUID,
  meta JSONB NOT NULL DEFAULT '{}'::JSONB,
  prev_hash BYTEA,
  hash BYTEA NOT NULL
);
