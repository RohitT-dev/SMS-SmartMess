# Smart Mess System (SMS)

A mission-critical, zero-knowledge encrypted room inventory, allocation, and ledger management system built with **Expo SDK 52** (Web, iOS, Android) and **Supabase** (PostgreSQL, Row-Level Security, RPC functions, and pgTAP tests).

---

## 1. System Architecture

```
.
├── apps/
│   └── app/                 # Expo Router application (Single codebase for Web & Native)
│       ├── app/             # File-based routing ((auth), (app), admin, bookings, reports)
│       └── src/             # Custom UI primitives, design tokens, stores, and crypto session
├── packages/
│   ├── core/                # Pure TS: Deterministic allotment engine, schemas, ranks, reports
│   └── crypto/              # Pure TS: XChaCha20-Poly1305, Argon2id, X25519, HKDF, blind index
├── supabase/
│   ├── migrations/          # 0001–0008: Constraints, triggers, audit hash chain, RLS, RPCs
│   ├── functions/           # Edge Functions (invite-user)
│   └── tests/               # Comprehensive pgTAP test suite (01_suite.sql)
├── scripts/
│   └── seed-dev.ts          # Local encrypted dev seeder
└── docs/                    # ASSUMPTIONS, RUNBOOK, DATA-MODEL, security-headers
```

---

## 2. Security & Zero-Knowledge Encryption

- **Client-Side Envelope Encryption**: Guest names, service numbers, ID numbers, phone numbers, units, notes, room names, and reasons are encrypted on-device before transmission using `XChaCha20-Poly1305`.
- **Location Binding**: AAD = `"<table>.<column>.<row_uuid>"` prevents ciphertext copying between rows.
- **Key Hierarchy**: Master Team Key (256-bit) -> HKDF-SHA256 derived subkeys (`pii`, `room-name`, `reason`, `blind-index`).
- **User Passphrase & Key Derivation**: Argon2id (`m=19456 KiB, t=2, p=1`) protects user X25519 private keys.
- **Emergency Recovery**: 160-bit Crockford Base32 recovery code wrapped via Argon2id.
- **Blind Indexing**: Search by guest ID via `HMAC-SHA256(blindKey, normalize(idNumber))` without plaintext exposure.
- **In-Memory Closure**: Unlocked keys live in a module-level JavaScript closure and are wiped to zeroes upon session lock or inactivity timeout.
- **Immutable Audit Chain**: Advisory-locked SHA-256 hash chaining prevents and detects tampering.

---

## 3. Quickstart & Installation

### Prerequisites
- Node.js (>= 20.x, tested with Node v22 / v25)
- `pnpm` (>= 9.x)
- Docker Desktop (for local Supabase CLI development)
- Supabase CLI (`brew install supabase/tap/supabase` or `npm i -g supabase`)

### 1. Clone & Install Dependencies
```bash
git clone <repo-url>
cd SmartMessSystem-SMS
pnpm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```
Ensure `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` point to your Supabase instance.

---

## 4. Supabase Setup Instructions

### Option A: Local Development with Supabase CLI (Recommended)
1. Start the Supabase local Docker containers:
   ```bash
   supabase start
   ```
2. Reset the database to apply all migrations (0001 to 0008) and seeds:
   ```bash
   supabase db reset
   ```
3. Run the automated pgTAP database verification test suite:
   ```bash
   supabase test db
   ```
4. Populate with realistic encrypted dev data:
   ```bash
   pnpm seed:dev
   ```

### Option B: Cloud Supabase Project
1. Log in and link your remote project:
   ```bash
   supabase login
   supabase link --project-ref <your-project-id>
   ```
2. Push all migrations to the cloud database:
   ```bash
   supabase db push
   ```
3. Deploy the user invitation Edge Function:
   ```bash
   supabase functions deploy invite-user
   ```
4. Copy your project's URL and anon key from **Project Settings -> API** into `.env`.

---

## 5. Development & Build Commands

| Command | Action |
|---|---|
| `pnpm typecheck` | Run TypeScript type checks across packages/core, packages/crypto, and apps/app |
| `pnpm test` | Run Vitest unit & smoke tests (Core engine, Crypto primitives, App smoke) |
| `pnpm lint` | Run ESLint with `no-console` enforcement |
| `pnpm web` | Start the Expo Web development server |
| `pnpm seed:dev` | Encrypt and seed sample bookings, rooms, and dev accounts |
| `pnpm --filter app run export:web` | Export optimized static web distribution to `apps/app/dist` |

---

## 6. Testing

### Vitest Unit & App Smoke Tests
```bash
pnpm test
```
- **packages/crypto**: XChaCha20-Poly1305 roundtrip, Argon2id KDF, X25519 sealed box, recovery code unwrapping, blind index normalization, key rotation re-encryption.
- **packages/core**: Deterministic allotment heuristics, 90-day alternate windows, fallback room type flags, suite exclusion, sharing constraints, eviction matrix, report math against fixed benchmark fixtures.
- **apps/app**: Session auto-lock key wipe, 15-second masked value countdown and re-masking, booking form validation blocking guests missing rank/gender.

### pgTAP Database Tests
```bash
supabase test db
```
Validates SQL constraints, triggers, RLS policies, audit verification, double-booking exclusion, and last admin safeguards.

---

## 7. Documentation
- [docs/ASSUMPTIONS.md](file:///Users/rohittiwari/antigravity/SmartMessSystem-SMS/docs/ASSUMPTIONS.md): Explicit records of all product and engineering assumptions.
- [docs/RUNBOOK.md](file:///Users/rohittiwari/antigravity/SmartMessSystem-SMS/docs/RUNBOOK.md): Operational procedures for backups, key rotation, lost device revocation, and recovery.
- [docs/DATA-MODEL.md](file:///Users/rohittiwari/antigravity/SmartMessSystem-SMS/docs/DATA-MODEL.md): Full database schema, column encryption dictionary, triggers, and RPCs.
- [docs/security-headers.md](file:///Users/rohittiwari/antigravity/SmartMessSystem-SMS/docs/security-headers.md): Web security headers, CSP, and HSTS setup.
