# Operational Runbook: Smart Mess System

This document outlines critical operational and cryptographic procedures for administrators of the Smart Mess System.

---

## 1. Cryptographic Key Management Architecture

The system operates under a zero-knowledge, client-side encryption envelope model:
- **Team Key**: A cryptographically secure 256-bit symmetric key (`XChaCha20-Poly1305`) created upon initial setup. It is NEVER transmitted in plaintext or stored on the server.
- **Subkeys (HKDF-SHA256)**:
  - `pii`: Encrypts guest names, phone numbers, service numbers, ID numbers, and notes.
  - `room-name`: Encrypts room identifiers and physical room numbers.
  - `reason`: Encrypts cancellation, denial, and eviction rationale.
  - `blind-index`: Key for HMAC-SHA256 blind indexing of guest ID numbers.
- **User Keypairs**: Each operator has an X25519 keypair. The private key is encrypted on their device using Argon2id (`m=19456 KiB, t=2, p=1`) derived from their passphrase.
- **Envelope Format**: `v1.<keyVersion>.<nonce_b64url>.<ciphertext_b64url>`, cryptographically bound to row location via AAD = `<table>.<column>.<row_uuid>`.

---

## 2. Procedure: Key Rotation

Key rotation generates a new Team Key version and re-encrypts all database ciphertext without service interruption.

### When to Rotate
- Routine security schedule (e.g. annually).
- Departure or compromise of an administrative user.
- Suspected device compromise.

### Step-by-step Rotation Flow
1. Navigate to **Admin Console** -> **Keys** (`/admin/keys`).
2. Verify that your local session is unlocked.
3. Click **Initiate Key Rotation**.
4. The system will:
   - Generate a new 256-bit Team Key (Version $N+1$).
   - Derive the new subkey hierarchy.
   - Display a new 160-bit Crockford Base32 Recovery Code. **Record and confirm this code immediately.**
   - Re-seal the new team key for all active user public keys using ephemeral X25519 sealed boxes.
   - Incrementally re-encrypt records in `rooms`, `guest_pii`, `bookings`, `denials`, and `evictions`. A progress bar tracks completed batches.
   - Flip `team_key_versions.is_active` to activate the new version.
5. All connected clients seamlessly transition to the new key version upon next sync.

---

## 3. Procedure: Lost Passphrase Recovery

If an operator forgets their passphrase, **neither the Admin nor Supabase support can reset it**.
The private key is mathematically unrecoverable without the passphrase or the team recovery code.

### Operator Instructions
1. On the **Unlock Screen**, select **Recover with Emergency Code**.
2. Enter the 160-bit Team Recovery Code (formatted as `XXXX-XXXX-XXXX-XXXX-XXXX`).
3. Set a new personal passphrase (minimum 12 characters).
4. The app derives the user encryption key via Argon2id, recovers the team key, and re-wraps the user keypair.

### Admin Verification Action
Admins can verify recovery code validity at any time without side effects:
- Go to `/admin/keys`.
- Click **Test Recovery Code**.
- Enter the code to verify that Argon2id unwraps the active team key version successfully.

---

## 4. Procedure: Lost or Stolen Device

If an operator loses a mobile phone or laptop:
1. An Admin logs into the **Admin Console** -> **Users & Access** (`/admin/users`).
2. Select the compromised user.
3. In the **Active Devices** section, locate the lost device identifier and click **Revoke Device**.
4. If the user themselves is suspect, click **Deactivate User**. This sets `profiles.is_active = false` and revokes key wraps.
5. Initiate a **Key Rotation** (Section 2) so that old ciphertexts cannot be decrypted even if an attacker attempts an offline brute-force on the device storage.

---

## 5. Procedure: Database Backup & Restoration

### Backup Contents
- Supabase automated or manual pg_dump backups contain **strictly ciphertext** for all PII fields (`guest_pii.pii_enc`, `bookings.notes_enc`, `rooms.name_enc`, etc.).
- Backups are zero-knowledge useless without the recovery code or an authorized user key.
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
3. An Admin signs in and enters the **160-bit Recovery Code** at `/recover` to unlock the recovered instance and re-wrap team keys.

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
