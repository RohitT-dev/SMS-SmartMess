# Database Architecture & Data Model

The Smart Mess System employs PostgreSQL on Supabase with PostGIS/btree_gist extensions, an immutable hash-chained audit log, zero-knowledge client-side encryption, and strict Row Level Security (RLS).

---

## 1. Cryptographic Envelope & Security Boundary

All PII, human names, physical room numbers, and free-text justifications are encrypted client-side using `XChaCha20-Poly1305` before being sent over the network. The database and Supabase infrastructure never observe plaintext keys or personal data.

### Envelope Structure
Stored as a `text` string formatted as:
`v1.<keyVersion>.<nonce_b64url>.<ciphertext_b64url>`

- `v1`: Version of envelope specification.
- `keyVersion`: Integer tracking the active team key version (`team_key_versions.version`).
- `nonce_b64url`: 192-bit random nonce encoded in RFC 4648 Base64URL without padding.
- `ciphertext_b64url`: Payload encrypted with XChaCha20-Poly1305 and Base64URL encoded.
- **AAD Binding**: Associated Data is bound to `"<table>.<column>.<row_uuid>"` to defeat ciphertext transplant attacks.

### Column Encryption Dictionary

| Table | Encrypted Columns (`*_enc`) | Plaintext Columns (Database Enforced) |
|---|---|---|
| `profiles` | `display_name_enc` | `id`, `role`, `permissions`, `is_active`, `created_at` |
| `rooms` | `name_enc` | `id`, `room_type`, `key_version`, `display_order`, `is_active`, `capacity` |
| `room_closures` | `reason_enc` | `id`, `room_id`, `period (daterange)`, `created_by` |
| `bookings` | `notes_enc`, `cancel_reason_enc` | `id`, `category`, `status`, `check_in`, `check_out`, `stay`, `party_size`, `is_suite_booking` |
| `booking_guests` | *None (PII separated)* | `id`, `booking_id`, `seq`, `gender`, `rank_code`, `details` |
| `guest_pii` | `pii_enc` (JSON blob) | `guest_id`, `id_blind_index`, `key_version`, `updated_by`, `updated_at` |
| `denials` | `reason_enc` | `id`, `category`, `check_in`, `check_out`, `party_size`, `denied_by` |
| `evictions` | `reason_enc` | `id`, `evicted_allocation_id`, `displaced_booking_id`, `incoming_booking_id`, `approved_by` |
| `audit_log` | *Never logs PII* | `id`, `at`, `actor`, `action`, `entity`, `entity_id`, `meta`, `prev_hash`, `hash` |

---

## 2. Core Tables

### `ranks`
Reference table for military rank seniority (Read-only reference).
- `code rank_code PRIMARY KEY`: (`FO`, `FLT_LT`, `SQN_LDR`, `WG_CDR`, `GP_CAPT`, `AIR_CDRE`, `AVM`, `AM`, `ACM`, `MIAF`).
- `seniority int UNIQUE`: Numerical priority (1 = FO, 10 = MIAF).
- `label text NOT NULL`: Display name.

### `profiles`
User accounts synced with `auth.users`.
- `id uuid PRIMARY KEY REFERENCES auth.users(id)`
- `role app_role NOT NULL DEFAULT 'clerk'`: (`admin`, `clerk`).
- `permissions text[] NOT NULL`: Array of granted permissions.
- `display_name_enc text`: Encrypted user display name.
- `is_active bool NOT NULL DEFAULT true`: Active status flag.

### `team_key_versions`
Historical and active symmetric team keys.
- `version int PRIMARY KEY`
- `recovery_wrap text NOT NULL`: Team key encrypted under Argon2id-derived recovery code.
- `recovery_kdf_salt text NOT NULL`
- `recovery_kdf_params jsonb NOT NULL`: `{ m: 19456, t: 2, p: 1 }`.
- `is_active bool NOT NULL DEFAULT false`: Exactly one row has `is_active = true` (enforced by partial unique index).

### `user_keys` & `user_key_wraps`
X25519 public keys and sealed team key envelopes.
- `user_keys`: `user_id`, `public_key`, `enc_private_key`, `kdf_salt`, `kdf_params`, `key_version`.
- `user_key_wraps`: `(user_id, key_version) PRIMARY KEY`, `sealed_team_key`.

### `rooms` & `room_closures`
Room inventory.
- `rooms`: `id`, `room_type ('VIP' | 'SEMI_VIP' | 'NORMAL' | 'SUITE')`, `name_enc`, `display_order`, `is_active`, `capacity = 2`.
- `room_closures`: `id`, `room_id`, `period daterange`, `reason_enc`, `created_by`.

### `bookings` & `booking_guests` & `guest_pii`
- `bookings`: `id`, `category ('MFA' | 'PI' | 'LEAVE' | 'TD')`, `status ('CONFIRMED' | 'CANCELLED' | 'DISPLACED' | 'COMPLETED')`, `check_in date`, `check_out date`, `stay daterange GENERATED ALWAYS AS (daterange(check_in, check_out, '[)')) STORED`, `party_size int (1..40)`, `is_suite_booking bool`.
- `booking_guests`: `id`, `booking_id`, `seq int`, `gender ('M' | 'F')`, `rank_code`, `details ('PENDING' | 'COMPLETE')`.
- `guest_pii`: `guest_id PRIMARY KEY`, `pii_enc text` (encrypted `{ name, idNumber, phone, serviceNumber, unit, notes }`), `id_blind_index text` (`HMAC-SHA256(blindKey, normalize(idNumber))`). **Direct SELECT revoked from all roles; accessible only via `get_guest_pii` RPC with logged audit trail.**

### `allocations`
Physical bed assignments.
- `id uuid PRIMARY KEY`, `booking_id uuid`, `guest_id uuid`, `room_id uuid`, `bed_slot smallint (1 or 2)`, `stay daterange`, `status ('ACTIVE' | 'RELEASED' | 'EVICTED')`.

---

## 3. Database Constraints & Triggers

1. **Anti-Double Booking (`allocations_no_double_book_gist`)**:
   ```sql
   EXCLUDE USING gist (room_id WITH =, bed_slot WITH =, stay WITH &&) WHERE (status = 'ACTIVE');
   ```
2. **One Guest Per Bed (`allocations_one_bed_per_guest_gist`)**:
   ```sql
   EXCLUDE USING gist (guest_id WITH =, stay WITH &&) WHERE (status = 'ACTIVE');
   ```
3. **Sharing Rule Trigger (`trg_check_sharing_rule`)**:
   - Acquires row lock `FOR UPDATE` on `rooms`.
   - Inspects any other active allocation in the room with overlapping `stay`.
   - Enforces identical `gender` AND `rank_code`. Raises `ERR_SHARE_RULE` upon mismatch.
4. **Suite Isolation Trigger (`trg_check_suite_allocation`)**:
   - Blocks Suite allocations for non-admin callers or bookings without `is_suite_booking = true`. Raises `ERR_SUITE_ONLY_ADMIN`.
5. **Closure Enforcement Trigger (`trg_check_room_closures`)**:
   - Rejects allocations overlapping active `room_closures`. Raises `ERR_ROOM_CLOSED`.
6. **Immutable Audit Hash Chain (`trg_audit_log_hash_chain`)**:
   - Advisory lock on insert; computes `hash = digest(prev_hash || row_bytes, 'sha256')`. Updates and deletes are blocked.

---

## 4. Stored Procedures (RPCs)

| RPC Name | Access Control | Description |
|---|---|---|
| `create_booking` | `create_booking` | Transactional booking, guests, and allocations allotment. |
| `cancel_booking` | `cancel_booking` | Releases active allocations, sets status to `CANCELLED`. |
| `move_allocation` | `create_booking` | Reassigns bed or room with trigger validation. |
| `get_guest_pii` | `reveal_guest_pii` | Audits "guest PII revealed", returns ciphertext blob. |
| `set_guest_pii` | `enter_guest_details` | Stores encrypted PII & blind index; sets details `COMPLETE`. |
| `search_guests_by_blind_index` | `reveal_guest_pii` | Audits blind search, returns matching booking IDs. |
| `approve_eviction` | `approve_eviction` | Atomic displacement of existing booking and creation of incoming booking. |
| `record_denial` | `deny_request` | Records denial reason. Blocks `MFA`/`PI` with `ERR_CANNOT_DENY_PRIORITY`. |
| `verify_audit_chain` | `admin` | Cryptographically verifies the unbroken SHA-256 chain. |
| `daily_room_state` | `is_active_user` | Aggregates room and bed state by date. Filters suites for non-admins. |
| `dashboard_counts` | `is_active_user` | Live counts of free rooms, partial occupancy, and pending actions. |
