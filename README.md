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
│   ├── migrations/          # 0001–0019: Constraints, triggers, audit hash chain, RLS, RPCs
│   ├── functions/           # Edge Functions (invite-user)
│   └── tests/               # pgTAP suites (01_suite.sql, 02_security_fixes.sql)
├── scripts/
│   ├── install-mac.sh       # One-command macOS installer
│   ├── install-windows.ps1  # One-command Windows installer (+ .cmd launcher)
│   ├── supabase-migrate.sh  # Migration / edge function helper
│   └── seed-dev.ts          # Local encrypted dev seeder
└── docs/                    # ASSUMPTIONS, RUNBOOK, DATA-MODEL, security-headers
```

---

## 2. Security & Zero-Knowledge Encryption

- **Client-Side Envelope Encryption**: Guest names, service numbers, ID numbers, phone numbers, units, notes, room names, and reasons are encrypted on-device before transmission using `XChaCha20-Poly1305`.
- **Location Binding**: AAD = `"<table>.<column>.<row_uuid>"` prevents ciphertext copying between rows.
- **Key Hierarchy**: Master Team Key (256-bit) -> HKDF-SHA256 derived subkeys (`pii`, `room-name`, `reason`, `blind-index`).
- **Access Code Unlock**: the team key is stored wrapped under the Administrator-set access code via Argon2id (`m=19456 KiB, t=2, p=1`). The server releases the wrap only after checking the code (5 wrong attempts per 15 minutes per user). A short shared code is much weaker than personal passphrases: anyone holding a database dump can brute-force it offline, so use 8+ digits.
- **Blind Indexing**: Search by guest ID via `HMAC-SHA256(blindKey, normalize(idNumber))` without plaintext exposure.
- **In-Memory Closure**: Unlocked keys live in a module-level JavaScript closure and are wiped to zeroes upon session lock or inactivity timeout.
- **Immutable Audit Chain**: Advisory-locked SHA-256 hash chaining prevents and detects tampering.

---

## 3. Setup Guide

### What you need
| Tool | Version | Why |
|---|---|---|
| Node.js | 20 or newer (22 LTS recommended) | Runs Expo, the tests and scripts |
| pnpm | 9 or newer | Workspace package manager |
| Git | any | Clone the repo; Git Bash runs `pnpm db:migrate` on Windows |
| Supabase CLI | latest | Migrations, local stack, edge functions |
| Docker Desktop | latest | Only for a **local** Supabase stack |

The install scripts below set all of this up for you.

### Option 1: one-command install (recommended)

**macOS**
```bash
git clone https://github.com/RohitT-dev/SMS-SmartMess.git
cd SMS-SmartMess
scripts/install-mac.sh --local-db
```

**Windows 10/11**: clone the repo, then double-click `scripts\install-windows.cmd`, or run from PowerShell:
```powershell
git clone https://github.com/RohitT-dev/SMS-SmartMess.git
cd SMS-SmartMess
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -LocalDb
```

Both scripts only install what is missing and are safe to re-run. They:
1. Install the toolchain: Homebrew on macOS, `winget` and Scoop on Windows; then Node.js, pnpm, Supabase CLI and Docker Desktop.
2. Run `pnpm install` for the whole workspace.
3. Create `.env` from `.env.example` (an existing `.env` is never overwritten).
4. With `--local-db` / `-LocalDb`: start local Supabase, apply every migration, run the pgTAP tests and write the local URL and keys into `.env`.
5. Type-check the workspace.

| macOS flag | Windows flag | Effect |
|---|---|---|
| `--local-db` | `-LocalDb` | Start and migrate a local Supabase stack, fill `.env` |
| `--skip-docker` | `-SkipDocker` | Skip Docker Desktop (cloud Supabase only) |
| `--start` | `-Start` | Start the web app when done |

> **First run with Docker:** if Docker Desktop was just installed, open it once (Windows may ask to enable WSL 2), then run the script again with `--local-db` / `-LocalDb`.
> **Windows:** run the script from a normal (not Administrator) terminal; Scoop refuses to install as Administrator.

### Option 2: manual install
```bash
git clone https://github.com/RohitT-dev/SMS-SmartMess.git
cd SMS-SmartMess
pnpm install
cp .env.example .env          # Windows: copy .env.example .env
```
Then set up a database with one of the options in [Section 4](#4-supabase-setup).

### Configure `.env`
| Variable | Used by | Where to find it |
|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | App | `supabase status` (local) or Project Settings → API |
| `EXPO_PUBLIC_SUPABASE_KEY` | App | Anon or publishable key from the same place (`EXPO_PUBLIC_SUPABASE_ANON_KEY` also works) |
| `SUPABASE_SERVICE_ROLE_KEY` | `pnpm seed:dev` only | Service role key. Never ship it in the app. |

The app reads `.env` from the repo root or from `apps/app/` (the app directory wins). `.env` is git-ignored.

### First Administrator
Public sign-up is disabled, so the first account is created by hand once per database:
1. Open Supabase Studio (local: http://127.0.0.1:54323, cloud: your project dashboard) → **Authentication → Users → Add user**, enter an email and password and tick **Auto Confirm User**.
2. In **SQL Editor**, make that user an Administrator:
   ```sql
   INSERT INTO public.profiles (id, role)
   SELECT id, 'admin' FROM auth.users WHERE email = 'you@example.com'
   ON CONFLICT (id) DO UPDATE SET role = 'admin';
   ```
3. Start the app (`pnpm web`), sign in, and set the first access code when asked. That creates the team encryption key.
4. Invite everyone else from **User Directory** (this needs the `invite-user` edge function deployed).

### Run the app
```bash
pnpm web        # browser at http://localhost:8081
pnpm ios        # iOS Simulator (macOS + Xcode)
pnpm android    # Android emulator (Android Studio)
pnpm start      # Expo dev server; scan the QR code with Expo Go
```

### Troubleshooting
- **"Missing Supabase URL"** or a blank sign-in: check `.env`, then restart the dev server with `pnpm --filter app exec expo start --web --clear`.
- **`Docker is not running`**: start Docker Desktop and wait until it says it is running.
- **Port 54321/54322 in use**: another Supabase stack is running. Stop it with `supabase stop --all`.
- **`pnpm db:migrate` on Windows**: it is a bash script; run it from Git Bash, or use the Supabase CLI commands from Section 4 directly.

---

## 4. Supabase Setup

### Migration script
`scripts/supabase-migrate.sh` wraps the Supabase CLI (macOS/Linux, or Git Bash on Windows):

```bash
scripts/supabase-migrate.sh local             # start stack, reset DB, apply all migrations, run pgTAP
scripts/supabase-migrate.sh local --no-reset  # apply only pending migrations locally
scripts/supabase-migrate.sh remote --dry-run  # preview migrations for the linked cloud project
scripts/supabase-migrate.sh remote            # push pending migrations (asks for confirmation)
scripts/supabase-migrate.sh functions         # deploy all edge functions
scripts/supabase-migrate.sh status            # local vs remote migration list
scripts/supabase-migrate.sh pending           # local migrations the remote has not recorded
scripts/supabase-migrate.sh repair            # renumber history rows recorded under dashboard timestamps
scripts/supabase-migrate.sh remote --psql     # push through psql when the CLI hangs (add --dry-run to preview)
```
Remote commands need `supabase link --project-ref <ref>` once (or `SUPABASE_PROJECT_REF`); `SUPABASE_DB_PASSWORD` is passed through when set. Remote CLI calls stop after `CLI_TIMEOUT` seconds (default 180) instead of hanging.

`pending`, `repair` and `--psql` read the migration history directly. They need `psql` (macOS: `brew install libpq && brew link --force libpq`) and `SUPABASE_DB_URL`, the **Session pooler** connection string from Project Settings → Database. Keep that URL out of any `.env` you share: it contains the database password.

**Migrations applied from the dashboard or an AI tool** are recorded under a timestamp (for example `20261016064640`) instead of the file's number, so a plain push would try to run them again. `pending` flags them and `repair` renumbers them after you confirm. `--psql` refuses to push until that is done, and applies each file in one transaction together with its history row.

### Option A: Local Supabase (Docker)
```bash
supabase start          # start the local containers (Studio: http://127.0.0.1:54323)
supabase db reset       # apply all migrations (0001–0019)
supabase test db        # run the pgTAP suite
supabase status         # print the URL and keys for .env
```
Optional sample data: `pnpm seed:dev` (needs `SUPABASE_SERVICE_ROLE_KEY`).

### Option B: Cloud Supabase project
```bash
supabase login
supabase link --project-ref <your-project-id>
supabase db push                         # apply all migrations
supabase functions deploy invite-user    # user invitations
```
Copy the project URL and anon/publishable key from **Project Settings → API** into `.env`.

---

## 4b. Booking Scenario Tests

`apps/app/src/dev/bookingScenarios.test.ts` runs the allotment engine against an in-memory stand-in for the database (`apps/app/src/dev/devBackend.ts`, test-only, not part of the app) through ~35 booking permutations: pairs, sharing, fallbacks, full house, alternates, denial, eviction, closures, races, roles and suites. It mirrors the SQL; the pgTAP suite stays the source of truth for the database.

---

## 5. Development & Build Commands

| Command | Action |
|---|---|
| `pnpm typecheck` | Run TypeScript type checks across packages/core, packages/crypto, and apps/app |
| `pnpm test` | Run Vitest unit & smoke tests (Core engine, Crypto primitives, App smoke) |
| `pnpm lint` | Run ESLint with `no-console` enforcement |
| `pnpm web` | Start the Expo Web development server |
| `pnpm ios` / `pnpm android` | Start on the iOS Simulator / Android emulator |
| `pnpm db:migrate <local\|remote\|functions\|status>` | Run `scripts/supabase-migrate.sh` |
| `pnpm seed:dev` | Encrypt and seed sample bookings, rooms, and dev accounts |
| `pnpm --filter app run export:web` | Export optimized static web distribution to `apps/app/dist` |

---

## 6. Sign-in Flow & Activity Logging

**Sign-in:** email + password (Supabase Auth) → the access code an Administrator set for the current period. The first Administrator sets the first code on first sign-in; after that, admins change it under **More → Access Code** (optionally with a valid-until date). Every session must enter the code before the database returns any data. TOTP MFA is built in but switched off (`app_config.require_mfa`). Invite and password-reset emails land on `/set-password`. Signed-out users are redirected to `/sign-in` from any route.

**Activity log:** every user action is recorded in the hash-chained `audit_log` table against the user's `auth.uid()`:
- Client actions (`screen_view`, `auth.*`, `session.*`, `bookings.*`, `rooms.*`, `users.*`, `keys.*`, `settings.*`, `reports.*`) go through the `log_user_action` RPC via `logAction()` in `apps/app/src/lib/activityLog.ts`. It works at AAL1, so sign-in and MFA steps are captured too. Never pass PII in `meta`; sensitive-looking keys are stripped.
- Server-side triggers and RPCs log bookings, guest PII writes/reveals, rooms, closures, profiles and devices.

Administrators review everything under **Audit Trail**.

---

## 7. Testing

### Vitest Unit & App Smoke Tests
```bash
pnpm test
```
- **packages/crypto**: XChaCha20-Poly1305 roundtrip, Argon2id KDF, X25519 sealed box, blind index normalization, key rotation re-encryption.
- **packages/core**: Deterministic allotment heuristics, 90-day alternate windows, fallback room type flags, suite exclusion, sharing constraints, eviction matrix, report math against fixed benchmark fixtures.
- **apps/app**: Session auto-lock key wipe, 15-second masked value countdown and re-masking, booking form validation blocking guests missing rank/gender.

### pgTAP Database Tests
```bash
supabase test db
```
Validates SQL constraints, triggers, RLS policies, audit verification, double-booking exclusion, and last admin safeguards.
`supabase/tests/02_security_fixes.sql` covers the 0019 fixes: suites stay admin-only under `manage_rooms`, the code-wrapped team key and user administration need a code-verified session, the old rotation RPC is closed, and the attempt limit holds.

---

## 8. User Interface

The UI is built from the primitives in `apps/app/src/ui/primitives` and the tokens in `apps/app/src/ui/tokens.ts`. Screens should not hardcode colours or font sizes.
- **Look**: an official service register: a dark navy sidebar, one saffron rule under the top bar, India green for free rooms. Light and dark themes share every token name.
- **Colour rules**: saffron is a mark, never body text (use `saffronInk`). Status backgrounds use the solid `*Soft` tints. Every text and background pair meets WCAG 2.1 AA, and control borders meet 3:1.
- **Icons**: `Icon` draws SVG line icons that follow the theme colour. Don't use emoji.
- **Copy**: sentence case for titles, labels and badges. Show status enums with `humanizeStatus()` (`apps/app/src/lib/labels.ts`).
- **Layout**: sidebar at 1024px and wider, bottom tab bar below that, 44px minimum touch targets, visible keyboard focus on web.

---

## 9. Documentation
- [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md): Explicit records of all product and engineering assumptions.
- [docs/RUNBOOK.md](docs/RUNBOOK.md): Operational procedures for backups, key rotation, and lost device revocation.
- [docs/DATA-MODEL.md](docs/DATA-MODEL.md): Full database schema, column encryption dictionary, triggers, and RPCs.
- [docs/security-headers.md](docs/security-headers.md): Web security headers, CSP, and HSTS setup.
