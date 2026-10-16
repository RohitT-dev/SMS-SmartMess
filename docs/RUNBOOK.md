# Operational Runbook: Smart Mess System

This document outlines critical operational and cryptographic procedures for administrators of the Smart Mess System.

---

## 1. Cryptographic Key Management Architecture

The system uses client-side envelope encryption, unlocked by a shared access code:
- **Team Key**: A cryptographically secure 256-bit symmetric key (`XChaCha20-Poly1305`) created upon initial setup. It is never transmitted or stored in plaintext; the server stores it only wrapped under the access code.
- **Subkeys (HKDF-SHA256)**:
  - `pii`: Encrypts guest names, phone numbers, service numbers, ID numbers, and notes.
  - `room-name`: Encrypts room identifiers and physical room numbers.
  - `reason`: Encrypts cancellation, denial, and eviction rationale.
  - `blind-index`: Key for HMAC-SHA256 blind indexing of guest ID numbers.
- **Access Code**: 6–12 digits set by an Administrator, optionally with a valid-until date. The team key is wrapped under a key derived from the code with Argon2id (`m=19456 KiB, t=2, p=1`) in `access_codes`. The server checks the code (SHA-256 keyed with a Supabase Vault pepper, 5 wrong attempts per 15 minutes per user) before marking the session verified and returning the wrap. Because the code is short and shared, a database dump can be brute-forced offline: use 8+ digits and treat dumps as sensitive.
- **Envelope Format**: `v1.<keyVersion>.<nonce_b64url>.<ciphertext_b64url>`, cryptographically bound to row location via AAD = `<table>.<column>.<row_uuid>`.
  - **Exception — `evictions.reason_enc`**: one eviction can displace several beds, producing several `evictions` rows that share a single reason ciphertext. That ciphertext is bound to a *batch* id (`evictions.reason_aad_id`), not to any individual row's own primary key. Always use `reason_aad_id` as the AAD id for this column, never `evictions.id`. Rows written before migration `0010_rotation_pii_reasons.sql` never had this id persisted; their `reason_enc` is permanently unrecoverable and is left on its original key version by rotation (see below).

---

## 2. Procedure: Key Rotation

Key rotation generates a new Team Key version and re-encrypts all database ciphertext without service interruption.

### When to Rotate
- Routine security schedule (e.g. annually).
- Departure or compromise of an administrative user.
- Suspected device compromise.

### Step-by-step Rotation Flow
1. Navigate to **More** -> **Access Code** (`/admin/keys`).
2. Verify that your local session is unlocked.
3. Click **Begin Key Rotation** and enter the access code staff will use afterwards (current or new).
4. The system will:
   - Generate a new 256-bit Team Key (Version $N+1$).
   - Derive the new subkey hierarchy.
   - Incrementally re-encrypt, in pages of 200 rows, every ciphertext column still on the old key version:
     `rooms.name_enc`, `guest_pii.pii_enc`, `bookings.cancel_reason_enc`, `denials.reason_enc`,
     `evictions.reason_enc`, and `room_closures.reason_enc`. A progress bar tracks each phase.
     `guest_pii` has no SELECT policy for any role, so it is paged through the admin-only
     `admin_page_guest_pii` RPC instead of a direct table read.
   - Flip `team_key_versions.is_active` to activate the new version and issue a new access-code version wrapping it (`finish_rotation_with_code`).
5. Other staff are asked for the access code again on their next unlock.

### Rows That Cannot Be Re-Encrypted

A row that fails to decrypt under the old key (wrong AAD, corrupt ciphertext) does **not** abort
the rotation. It is skipped, left on its original key version, and reported both in the
post-rotation alert and as a `keys.rotation_unrecoverable_rows` entry in the activity log (table
names and row count only — never ciphertext or plaintext). The only rows expected to hit this path
are `evictions.reason_enc` values written before migration `0010_rotation_pii_reasons.sql`, whose
AAD id was never persisted (see Section 1). If a rotation reports unrecoverable rows outside
`evictions`, treat it as a bug, not routine behavior — investigate before rotating again.

---

## 3. Procedure: Changing or Losing the Access Code

- **Change it** (new period, or a staff member left): **More** -> **Access Code** -> **Set a New Access Code**, optionally with a valid-until date. It takes effect immediately; every other session must enter the new code before it can read data again.
- **Expired code**: staff can no longer sign in. Admins can still enter the expired code to reach the Access Code page and set the next one.
- **Forgotten code**: any signed-in Administrator can set a new code. If **every** Administrator has forgotten the current code and no session is still unlocked, the team key, and with it all encrypted data, cannot be recovered.

---

## 4. Procedure: Lost or Stolen Device

If an operator loses a mobile phone or laptop:
1. An Admin logs into the **Admin Console** -> **Users & Access** (`/admin/users`).
2. Select the compromised user.
3. In the **Active Devices** section, locate the lost device identifier and click **Revoke Device**.
4. If the user themselves is suspect, click **Deactivate User**. This sets `profiles.is_active = false`.
5. Set a new access code (Section 3) so a device that still knows the old code cannot unlock again.
6. Optionally initiate a **Key Rotation** (Section 2) so that old ciphertexts cannot be decrypted even if an attacker attempts an offline brute-force on the device storage.

---

## 5. Procedure: Database Backup & Restoration

### Backup Contents
- Supabase automated or manual pg_dump backups contain **strictly ciphertext** for all PII fields (`guest_pii.pii_enc`, `bookings.notes_enc`, `rooms.name_enc`, etc.).
- Encrypted columns cannot be read without the access code (but see the brute-force caveat in Section 1).
- **Caution**: Plaintext operational columns (`check_in`, `check_out`, `gender`, `rank_code`, `category`) remain visible in the raw database for scheduling triggers and sharing constraints. Handle database dumps as confidential military documents.

### Disaster Restoration
1. Restore SQL dump into the PostgreSQL cluster:
   ```bash
   supabase db reset
   # or
   psql -h <host> -U postgres -d postgres < backup.sql
   ```
2. Verify table row counts and hash integrity:
   ```sql
   SELECT * FROM verify_audit_chain();
   ```
   Must return `(ok: true, first_bad_id: null)`.
3. An Admin signs in and enters the access code that was active when the backup was taken.

---

## 6. Procedure: Audit Chain Verification

The audit log is an immutable cryptographic hash chain:
$\text{hash}_n = \text{SHA256}(\text{hash}_{n-1} \parallel \text{row\_data})$

### To verify audit integrity:
1. In the app: Visit **Admin** -> **Audit Log** -> **Verify Audit Chain**.
2. Or via SQL:
   ```sql
   SELECT * FROM verify_audit_chain();
   ```
3. If tampering has occurred (e.g. direct row modification or deletion by a rogue database admin), `ok` will be `false` and `first_bad_id` will identify the exact tampered row.
