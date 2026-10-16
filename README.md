# Smart Mess System (SMS)

A mission-critical, zero-knowledge encrypted room inventory, allocation, and ledger management system built with **Expo SDK 58** (React Native 0.88, Android target API 36) (Web, iOS, Android) and **Supabase** (PostgreSQL, Row-Level Security, RPC functions, and pgTAP tests).

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

### Server-side hardening (migration 0019)
A security review of migrations 0014–0018 found five gaps; `0019_security_review_fixes.sql` closes them and `supabase/tests/02_security_fixes.sql` tests each one.

| Gap | Fix |
|---|---|
| A clerk with `manage_rooms` could create, edit, delete or close **suites** | `manage_rooms` covers adding/editing non-suite rooms and closing non-suite rooms only. Suites, deletes and suite closures are admin-only, and non-admins cannot see suite closures. |
| Parallel guesses could beat the **5-tries-per-15-minutes** access-code limit | Attempts are serialized per user with a transaction-scoped advisory lock. |
| An admin **password alone** could read the code-wrapped team key and brute-force the code offline | `team_key_versions` is readable only from a code-verified session. |
| An admin **password alone** could change roles, permissions or deactivate users | `set_user_role`, `set_user_permissions` and `deactivate_user` require a code-verified session. |
| The original `finish_rotation(INT, TEXT, TEXT, JSONB)` could still switch the active key | Revoked; rotation goes through `finish_rotation_with_code()`. |

### Known limits
- **The access code is shared.** The attempt limit is per user, so someone holding several staff passwords gets 5 guesses on each. A global limit was left out because anyone could then lock every user out on purpose. Use an 8+ digit code and change it when staff leave.
- **Database dumps are sensitive.** The team key is wrapped under the code, so a dump plus a short code can be brute-forced offline.
- **Supabase default table privileges** give `authenticated` extra rights such as `TRUNCATE` on some tables. They are not reachable through the app's API, but a later migration should revoke them.

---

## 3. Setup Guide

**From zero to a phone, in order:**
1. **Install** the tools and the project on a computer ([one-command install](#option-1-one-command-install-recommended)).
2. **Set up the database:** a new Supabase project ([Section 4](#4-supabase-setup)), or connect to your team's existing one ([joining](#joining-an-existing-project-teammates)).
3. **Create the first Administrator** and set the access code ([First Administrator](#first-administrator)).
4. **Run it** on the computer: `pnpm web` ([Run the app](#run-the-app)).
5. **Put it on phones:** web app, Android APK or iPhone build ([Install on a phone](#install-on-a-phone)).
6. **Invite staff** from User Directory and give them the access code.

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

### Joining an existing project (teammates)
Someone joining a team that already runs Smart Mess does **not** set up a database. They connect to yours:
1. Run the installer **without** `--local-db` / `-LocalDb`.
2. Put the two public values in their `.env`: `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_KEY`. Send them by any private channel. These values are public by design (they are built into the app) and give no access to data on their own.
3. **Never send `SUPABASE_SERVICE_ROLE_KEY` or the database password.** The service role key bypasses every security rule. Remove it from the file before sharing; if it leaks, rotate it under Project Settings → API.
4. An Administrator invites them from **User Directory** (needs the `invite-user` edge function deployed) and gives them the current access code separately.

To see anything, each person needs their own account **and** the access code.

### Run the app
```bash
pnpm web        # browser at http://localhost:8081
pnpm ios        # iOS Simulator (macOS + Xcode)
pnpm android    # Android emulator (Android Studio)
pnpm start      # Expo dev server; scan the QR code with Expo Go (see Install on a phone)
```

### Install on a phone
Pick the path that fits who is installing. All of them connect to the Supabase project in `.env` (or in EAS environment variables for store builds), so the phone needs internet access to that project.

| Path | Android | iPhone | Needs | Best for |
|---|---|---|---|---|
| **A. Web app on the home screen** | Yes | Yes | A web host | Fastest rollout to staff, no app store |
| **B. Android APK** | Yes | No | Free Expo account | Installing the real app on Android phones |
| **C. iPhone build** | No | Yes | Apple Developer account (paid) | Installing the real app on iPhones |
| **D. Google Play (Internal testing)** | Yes | No | Google Play developer account | Installing on any Android phone without Play Protect warnings |
| **E. Expo Go (testing only)** | Yes | Limited | Phone on the same Wi-Fi | Developers trying a change |

#### A. Web app on the home screen (Android and iPhone)
1. Build the web app:
   ```bash
   pnpm --filter app run export:web
   ```
2. Upload `apps/app/dist/` to any static host that serves HTTPS (Netlify, Vercel, Cloudflare Pages, or your own server). Route every path to `index.html`. Add the headers in [docs/security-headers.md](docs/security-headers.md).
3. On the phone, open the site, then:
   - **Android (Chrome):** menu ⋮ → **Add to Home screen** → **Install**.
   - **iPhone (Safari):** Share button → **Add to Home Screen** → **Add**.
4. Open it from the new icon and sign in.

To update, rebuild and upload again; phones get the new version on next open.

#### B. Android APK (install the real app)
One-time setup on your computer:
```bash
npm install -g eas-cli
eas login                       # free account at expo.dev
cd apps/app
eas init                        # creates the Expo project
```
`eas init` prints a project ID. Because `app.config.ts` is a dynamic config, it can't write it for you: add `EAS_PROJECT_ID=<that id>` to your `.env`.

`.env` is git-ignored, so the cloud build can't see it. Store the two public values in EAS once:
```bash
eas env:create --environment preview --visibility plaintext --name EXPO_PUBLIC_SUPABASE_URL --value https://<project-ref>.supabase.co
eas env:create --environment preview --visibility plaintext --name EXPO_PUBLIC_SUPABASE_KEY --value <anon-or-publishable-key>
```
Never add `SUPABASE_SERVICE_ROLE_KEY` to EAS.

Build the APK (runs in Expo's cloud, about 10–20 minutes):
```bash
eas build --platform android --profile preview
```
When it finishes, EAS prints a download link and a QR code. On each Android phone:
1. Open the link (or scan the QR code) and download the `.apk`.
2. Tap the file. If Android blocks it, allow **Install unknown apps** for your browser or file manager when prompted.
3. Tap **Install**, then open **Smart Mess System** and sign in.

To update, run the same build again and install the new APK over the old one; data stays in Supabase.

Sideloaded APKs can show a Google Play Protect warning on some phones. To avoid it, distribute through Google Play instead (path D).

Without EAS, a computer with Android Studio can build locally:
```bash
cd apps/app
npx expo run:android --variant release
```
The APK lands in `apps/app/android/app/build/outputs/apk/release/`. It's signed with a debug key, so use it for testing only.

#### C. iPhone build
Apple does not allow installing app files directly, so iPhones need an **Apple Developer Program** membership.
- **TestFlight (recommended):** run `eas build --platform ios --profile production`, then `eas submit --platform ios`. Add staff as testers in App Store Connect → TestFlight. They install the **TestFlight** app and accept the invite.
- **Ad hoc (up to 100 registered devices):** run `eas device:create` and open the link on each iPhone to register it. Then run `eas build --platform ios --profile preview` and open the build link on the phone. On iOS 16 or later, turn on **Settings → Privacy & Security → Developer Mode** once.

Set the same EAS environment variables as in B, using `--environment production` for TestFlight builds. Without a developer account, use **path A** on iPhones.

#### D. Google Play Internal testing (Android, no Play Protect warnings)
The app targets Android API 36, which Google Play requires for new apps, so it can be uploaded to the Play Store. The Internal testing track reaches up to 100 testers without a store review.

1. In the [Play Console](https://play.google.com/console), create an app with package name `mil.gov.sms`.
2. Set the EAS environment variables from B with `--environment production`.
3. Build an app bundle:
   ```bash
   eas build --platform android --profile production
   ```
4. Upload the first `.aab` by hand: **Testing → Internal testing → Create new release**. Google requires the first upload to go through the Play Console. Later builds can use `eas submit --platform android` once a Google service account key is configured.
5. Add testers' Google accounts under **Testers**, then share the opt-in link. Testers open it, accept, and install **Smart Mess System** from the Play Store.

Every upload needs a higher Android version code. Before each release, add or raise `versionCode` under `android` in `app.config.ts` (and `version` if you like), then build and upload again.

#### E. Expo Go (developers testing a change)
1. Run `pnpm start` on your computer, with the phone on the same Wi-Fi. Add `--tunnel` if the networks differ: `pnpm --filter app exec expo start --tunnel`.
2. Scan the QR code: with the Camera app on iPhone, or inside Expo Go on Android.

Notes:
- **SDK versions:** this app uses **Expo SDK 58**. The store versions of Expo Go only run the newest SDK. If Expo Go has moved past SDK 58, use path A or C on iPhone, and on Android install the Expo Go build for SDK 58 from [expo.dev/go](https://expo.dev/go).
- **Local database:** if `.env` points at a local Supabase (`http://127.0.0.1:54321`), the phone can't reach it. Use your computer's Wi-Fi IP instead (for example `http://192.168.1.20:54321`), or a cloud project.

### Troubleshooting
- **App on the phone can't sign in** ("Network request failed"): the phone can't reach the Supabase URL. For an APK, check the EAS environment variables and rebuild. With Expo Go, don't use `127.0.0.1`.
- **"Missing Supabase URL"** or a blank sign-in: check `.env`, then restart the dev server with `pnpm --filter app exec expo start --web --clear`.
- **`Docker is not running`**: start Docker Desktop and wait until it says it is running.
- **Port 54321/54322 in use**: another Supabase stack is running. Stop it with `supabase stop --all`.
- **Supabase CLI hangs** on "Connecting to remote database": the migration script stops it after `CLI_TIMEOUT` seconds. Retry, or use `scripts/supabase-migrate.sh remote --psql` (see Section 4).
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

### Option C: Update a cloud project that is already running
Migrations must be applied **in order**: a later file can depend on an earlier one (0019 replaces a function 0018 creates).
1. See what is missing, and whether any migration was applied from the dashboard under a timestamp:
   ```bash
   scripts/supabase-migrate.sh pending
   ```
2. If it reports timestamp rows, first confirm in the database that those migrations' changes really are live, then renumber them:
   ```bash
   scripts/supabase-migrate.sh repair
   ```
3. Preview, then apply:
   ```bash
   scripts/supabase-migrate.sh remote --dry-run
   scripts/supabase-migrate.sh remote
   ```
   If the CLI hangs while connecting, use the psql path instead: `scripts/supabase-migrate.sh remote --psql --dry-run`, then without `--dry-run`.
4. Deploy edge functions if they changed: `scripts/supabase-migrate.sh functions`.

Prefer the CLI or this script over pasting SQL into the dashboard: the dashboard records migrations under timestamps, which is what step 2 has to clean up.

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
| `pnpm db:migrate <local\|remote\|pending\|repair\|functions\|status>` | Run `scripts/supabase-migrate.sh` |
| `pnpm seed:dev` | Encrypt and seed sample bookings, rooms, and dev accounts |
| `pnpm --filter app run export:web` | Export optimized static web distribution to `apps/app/dist` |

---

## 6. Sign-in Flow & Activity Logging

**Sign-in:** email + password (Supabase Auth) → the access code an Administrator set for the current period. The first Administrator sets the first code on first sign-in; after that, admins change it under **More → Access Code** (optionally with a valid-until date). Every session must enter the code before the database returns any data. TOTP MFA is built in but switched off (`app_config.require_mfa`). Invite and password-reset emails land on `/set-password`. Signed-out users are redirected to `/sign-in` from any route.

**Activity log:** every user action is recorded in the hash-chained `audit_log` table against the user's `auth.uid()`:
- Client actions (`screen_view`, `auth.*`, `session.*`, `bookings.*`, `rooms.*`, `users.*`, `keys.*`, `settings.*`, `reports.*`) go through the `log_user_action` RPC via `logAction()` in `apps/app/src/lib/activityLog.ts`. It works at AAL1, so sign-in and MFA steps are captured too. Never pass PII in `meta`; sensitive-looking keys are stripped.
- Server-side triggers and RPCs log bookings, guest PII writes/reveals, rooms, closures, profiles and devices.

Administrators review everything under **Audit Trail**.

### Roles and permissions
There are two roles. **Administrators** can do everything, including suites, user management, access codes and key rotation. **Clerks** get only the permissions an Administrator grants them under **User Directory**:

| Permission | Allows |
|---|---|
| `create_booking` | Create bookings |
| `enter_guest_details` | Enter or backfill guest details |
| `reveal_guest_pii` | Reveal guest personal details, search by ID |
| `cancel_booking` | Cancel bookings |
| `approve_eviction` | Displace lower-priority bookings (MSA over PI/LEAVE/TD, PI over LEAVE/TD) |
| `view_reports` | Reports and statistics |
| `deny_request` | Deny LEAVE/TD requests (MSA and PI cannot be denied) |
| `manage_rooms` | Add and edit rooms, mark rooms out of service, end closures. **Never suites.** |

Suites (VVIP) are admin-only everywhere: booking, editing, closing and viewing closures.

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
