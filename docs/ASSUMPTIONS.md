# Architectural & Product Assumptions

This document records deliberate design and engineering decisions where requirements were unspecified or deferred. Format: Decision | Reason | How to change.

1. **Room Inventory Split**: 50 total rooms divided into 10 VIP, 14 Semi VIP, 22 Normal, and 4 Suites for dev seeding.
   - *Reason*: Section 1 specifies ~50 spare rooms with 4 room types; this realistic split covers diverse capacity and priority scenarios.
   - *How to change*: Adjust seed counts in `scripts/seed-dev.ts` or add/remove rooms via the Admin Data screen (`/admin/data`).

2. **Junior-most Rank Label**: Assigned `FO` as Flying Officer.
   - *Reason*: Standard Indian Air Force officer rank structure starting from Flying Officer (seniority 1).
   - *How to change*: Modify label in `packages/core/src/constants.ts` and `supabase/migrations/0002_reference.sql`.

3. **Whole-Day Stays Convention**: Check-out day is free for incoming guests; stay interval is half-open `[check_in, check_out)`.
   - *Reason*: Enables seamless back-to-back stays without vacancy gaps (e.g. guest departs morning, next guest arrives afternoon).
   - *How to change*: Change `STAY_BOUNDS` in `packages/core/src/constants.ts` and the generated column expression in `0003_core_tables.sql`.

4. **Recording Denials**: All denials for `LEAVE` and `TD` are recorded in the `denials` table with client-side encrypted reasons.
   - *Reason*: Section 1.4 requires recorded reasons for reporting and operational audits.
   - *How to change*: Modify `record_denial` RPC in `0007_rpcs.sql` and the denial handler in `bookings/new/alternates.tsx`.

5. **Unranked Eviction Candidates**: Candidates for eviction review are presented in stable FIFO order without heuristic ranking.
   - *Reason*: Section 1.4 explicitly defers ranking rules to human discretion; marked with `-- TODO(ranking)`.
   - *How to change*: Implement score/sorting logic inside `rankCandidates()` in `packages/core/src/engine.ts` and the `eviction_candidates` RPC in `0007_rpcs.sql`.

6. **Hosting Architecture**: Web output is configured as a static SPA (`web: { output: 'single' }`); mobile binaries built via Expo EAS.
   - *Reason*: Minimizes server infrastructure complexity and guarantees all client-side decryption runs strictly on end-user devices.
   - *How to change*: Change `output` in `apps/app/app.config.ts` to `static` or `server` if SSR is required.

7. **No Waiting List in v1**: Incoming requests that cannot be fulfilled immediately are either offered alternates, denied, or trigger eviction.
   - *Reason*: Keeps reservation state deterministic and avoids complex asynchronous queue states.
   - *How to change*: Create a `waitlist` table in a future migration with an automated notification cron or webhook.

8. **Second Bed Sharing Availability**: A single guest assigned to a 2-bed room leaves the remaining bed slot open for a compatible guest of identical rank and gender.
   - *Reason*: Maximizes room occupancy while strictly honoring non-commissioned/officer pairing and gender rules.
   - *How to change*: Add a `single_occupancy` boolean flag on bookings to block allocation of bed slot 2.

9. **Single Admin Default**: Exactly one Admin user is configured by default; creating or promoting a second Admin requires an explicit confirmation modal.
   - *Reason*: Enforces strict separation of duty and prevents unauthorized key-sharing or administrative privilege escalation.
   - *How to change*: Update `apps/app/app/(app)/admin/users.tsx` and the `set_user_role` RPC in `0007_rpcs.sql`.
