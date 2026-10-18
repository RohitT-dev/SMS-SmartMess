/**
 * TEST-ONLY in-memory stand-in for the Supabase backend.
 *
 * Used by bookingScenarios.test.ts; it is not wired into the app. It mirrors the behaviour of
 * supabase/migrations (RPC rules, RLS visibility, exclusion/sharing/closure triggers, error
 * strings). Ciphertext is stored exactly as the server would store it.
 *
 * Not a security boundary and not a substitute for the pgTAP suite.
 */

type Row = Record<string, any>;

const randomUUID = (): string =>
  globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
type Tables = Record<string, Row[]>;

const STORAGE_KEY = 'sms.dev.db.v1';
const USER_KEY = 'sms.dev.user';
const LATENCY_MS = typeof window === 'undefined' ? 0 : 40;

export const DEV_USERS = {
  admin: { id: '00000000-0000-4000-8000-0000000000a1', email: 'admin@dev.local', role: 'admin' },
  clerk: { id: '00000000-0000-4000-8000-0000000000c1', email: 'clerk@dev.local', role: 'clerk' },
} as const;
export type DevUserKey = keyof typeof DEV_USERS;

const ALL_PERMISSIONS = [
  'create_booking',
  'enter_guest_details',
  'reveal_guest_pii',
  'cancel_booking',
  'approve_eviction',
  'view_reports',
  'deny_request',
  'manage_rooms',
];
const CLERK_PERMISSIONS = ['create_booking', 'enter_guest_details', 'view_reports', 'deny_request'];

class PgError extends Error {
  code: string;
  constructor(message: string, code = 'P0001') {
    super(message);
    this.code = code;
  }
}

const nowIso = () => new Date().toISOString();
const todayUtc = () => new Date().toISOString().slice(0, 10);
const dayMs = 86400000;
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / dayMs);

/** Parses a Postgres daterange literal like "[2026-10-01,2026-10-05)". */
function parseRange(r: string): [string, string] {
  const m = /^[[(]\s*([0-9-]+)\s*,\s*([0-9-]+)\s*[)\]]$/.exec(r);
  if (!m) throw new PgError(`malformed range literal: "${r}"`, '22P02');
  return [m[1], m[2]];
}
const rangeStr = (a: string, b: string) => `[${a},${b})`;
const overlaps = (a: [string, string], b: [string, string]) => a[0] < b[1] && b[0] < a[1];

function emptyDb(): Tables {
  const mk = (u: (typeof DEV_USERS)[DevUserKey]) => ({
    id: u.id,
    role: u.role,
    permissions: u.role === 'admin' ? [...ALL_PERMISSIONS] : [...CLERK_PERMISSIONS],
    display_name_enc: null,
    is_active: true,
    created_at: nowIso(),
    updated_at: nowIso(),
    email: u.email, // dev-only convenience (real table has no email column)
  });
  return {
    profiles: [mk(DEV_USERS.admin), mk(DEV_USERS.clerk)],
    rooms: [],
    room_closures: [],
    bookings: [],
    booking_guests: [],
    guest_pii: [],
    allocations: [],
    denials: [],
    evictions: [],
    audit_log: [],
    devices: [],
    access_codes: [],
    team_key_versions: [],
  };
}

function hashStr(s: string): string {
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

// Relations used by PostgREST embedded selects in the app.
const RELATIONS: Record<string, Record<string, { table: string; kind: 'one' | 'many'; fk: string }>> = {
  bookings: {
    booking_guests: { table: 'booking_guests', kind: 'many', fk: 'booking_id' },
    allocations: { table: 'allocations', kind: 'many', fk: 'booking_id' },
  },
  allocations: {
    rooms: { table: 'rooms', kind: 'one', fk: 'room_id' },
    bookings: { table: 'bookings', kind: 'one', fk: 'booking_id' },
    booking_guests: { table: 'booking_guests', kind: 'one', fk: 'guest_id' },
  },
};

interface SelectNode {
  star: boolean;
  cols: string[];
  embeds: { name: string; node: SelectNode }[];
}

function parseSelect(src: string): SelectNode {
  let i = 0;
  const parseList = (): SelectNode => {
    const node: SelectNode = { star: false, cols: [], embeds: [] };
    let token = '';
    const flush = () => {
      const t = token.trim();
      if (t === '*') node.star = true;
      else if (t) node.cols.push(t);
      token = '';
    };
    while (i < src.length) {
      const ch = src[i];
      if (ch === '(') {
        const name = token.trim();
        token = '';
        i++;
        node.embeds.push({ name, node: parseList() });
      } else if (ch === ')') {
        flush();
        i++;
        return node;
      } else if (ch === ',') {
        flush();
        i++;
      } else {
        token += ch;
        i++;
      }
    }
    flush();
    return node;
  };
  return parseList();
}

type Listener = (event: string, session: any) => void;

export function createDevSupabase(mode: 'auto' | 'mock') {
  const hasLS = typeof window !== 'undefined' && !!window.localStorage;
  const ls = (fn: () => any) => {
    try {
      return hasLS ? fn() : null;
    } catch {
      return null;
    }
  };

  let db: Tables = emptyDb();
  const saved = ls(() => window.localStorage.getItem(STORAGE_KEY));
  if (saved) {
    try {
      db = { ...emptyDb(), ...JSON.parse(saved) };
    } catch {
      /* start fresh */
    }
  }
  const persist = () => ls(() => window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db)));

  // ---- auth ----
  const listeners = new Set<Listener>();
  const storedUser = (ls(() => window.localStorage.getItem(USER_KEY)) as DevUserKey | null) || 'admin';
  let currentKey: DevUserKey = storedUser in DEV_USERS ? storedUser : 'admin';
  let session: any = null;
  const buildSession = (key: DevUserKey) => ({
    access_token: `dev-token-${key}`,
    refresh_token: 'dev-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: DEV_USERS[key].id, email: DEV_USERS[key].email, aud: 'authenticated', app_metadata: {}, user_metadata: {} },
  });
  if (mode === 'auto') session = buildSession(currentKey);
  const notify = (event: string) => listeners.forEach((l) => l(event, session));
  const uid = () => session?.user?.id as string | undefined;

  // ---- realtime ----
  const channels = new Set<{ name: string; handlers: { table: string; cb: () => void }[] }>();
  const emit = (table: string) =>
    channels.forEach((c) => c.handlers.filter((h) => h.table === table).forEach((h) => h.cb()));

  // ---- helpers over db ----
  const me = () => db.profiles.find((p) => p.id === uid());
  const isActiveUser = () => !!me()?.is_active;
  const isAdmin = () => !!me()?.is_active && me()!.role === 'admin';
  const hasPerm = (p: string) =>
    !!me()?.is_active && (me()!.role === 'admin' || (me()!.permissions as string[]).includes(p));
  const need = (ok: boolean) => {
    if (!ok) throw new PgError('ERR_PERMISSION');
  };

  function audit(action: string, entity: string, entityId: string | null, meta: Row = {}) {
    const prev = db.audit_log[db.audit_log.length - 1];
    const row: Row = {
      id: (prev?.id ?? 0) + 1,
      at: nowIso(),
      actor: uid() ?? null,
      action,
      entity,
      entity_id: entityId,
      meta,
      prev_hash: prev?.hash ?? null,
    };
    row.hash = hashStr(`${row.prev_hash ?? ''}|${row.at}|${row.actor}|${action}|${entity}|${entityId}|${JSON.stringify(meta)}`);
    db.audit_log.push(row);
  }

  const roomById = (id: string) => db.rooms.find((r) => r.id === id);
  const bookingById = (id: string) => db.bookings.find((b) => b.id === id);
  const guestById = (id: string) => db.booking_guests.find((g) => g.id === id);

  // ---- allocation triggers + exclusion constraints ----
  function insertAllocation(row: Row) {
    const booking = bookingById(row.booking_id)!;
    const stay = parseRange(row.stay);
    const room = roomById(row.room_id);
    if (!room) throw new PgError('insert or update on table "allocations" violates foreign key constraint "allocations_room_id_fkey"', '23503');

    // trg_allocations_bounds_rule
    const bStay = parseRange(booking.stay);
    if (!(stay[0] >= bStay[0] && stay[1] <= bStay[1])) throw new PgError('ERR_INVALID_DATES');

    if (row.status === 'ACTIVE') {
      // trg_allocations_closure_rule
      if (db.room_closures.some((c) => c.room_id === row.room_id && overlaps(parseRange(c.period), stay))) {
        throw new PgError('ERR_ROOM_CLOSED');
      }
      // trg_allocations_sharing_rule: ranked people need the same gender and rank; a civilian
      // shares only with their own booking.
      const g = guestById(row.guest_id)!;
      const mismatch = db.allocations.some((a) => {
        if (a.room_id !== row.room_id || a.status !== 'ACTIVE' || !overlaps(parseRange(a.stay), stay)) return false;
        const og = guestById(a.guest_id)!;
        if (og.rank_code && g.rank_code) return og.gender !== g.gender || og.rank_code !== g.rank_code;
        return a.booking_id !== row.booking_id;
      });
      if (mismatch) throw new PgError('ERR_SHARE_RULE');
    }

    // trg_allocations_closure_rule: deleted or offline rooms take no new allocations
    if (row.status === 'ACTIVE' && (!room.is_active || room.deleted_at)) throw new PgError('ERR_ROOM_CLOSED');

    // trg_allocations_suite_rule
    if (room.room_type === 'SUITE') {
      if (!(isAdmin() && booking.is_suite_booking)) throw new PgError('ERR_SUITE_ONLY_ADMIN');
    } else if (booking.is_suite_booking) {
      throw new PgError('ERR_SUITE_ONLY_ADMIN');
    }

    if (row.status === 'ACTIVE') {
      // no_double_booking / one_bed_per_guest exclusion constraints
      if (
        db.allocations.some(
          (a) =>
            a.status === 'ACTIVE' &&
            a.room_id === row.room_id &&
            a.bed_slot === row.bed_slot &&
            overlaps(parseRange(a.stay), stay),
        )
      ) {
        throw new PgError('conflicting key value violates exclusion constraint "no_double_booking"', '23P01');
      }
      if (db.allocations.some((a) => a.status === 'ACTIVE' && a.guest_id === row.guest_id && overlaps(parseRange(a.stay), stay))) {
        throw new PgError('conflicting key value violates exclusion constraint "one_bed_per_guest"', '23P01');
      }
    }
    db.allocations.push(row);
  }

  function createBooking(pBooking: Row, pGuests: Row[], pAllocs: Row[]): string {
    need(isActiveUser() && hasPerm('create_booking'));
    const admin = isAdmin();
    const category = pBooking.category;
    const checkIn = pBooking.check_in;
    const checkOut = pBooking.check_out;
    const partySize = Number(pBooking.party_size);
    const isSuite = !!pBooking.is_suite_booking;

    if (!admin && checkIn < todayUtc()) throw new PgError('ERR_INVALID_DATES: Clerks cannot backdate bookings');
    if (isSuite && !admin) throw new PgError('ERR_SUITE_ONLY_ADMIN');
    if ((pGuests?.length ?? 0) !== partySize) throw new PgError('ERR_PARTY_MISMATCH');
    if (!['MFA', 'PI', 'LEAVE', 'TD'].includes(category)) {
      throw new PgError(`invalid input value for enum category: "${category}"`, '22P02');
    }
    if (!(checkOut > checkIn)) {
      throw new PgError('new row for relation "bookings" violates check constraint "check_stay_dates"', '23514');
    }
    if (partySize < 1 || partySize > 40) {
      throw new PgError('new row for relation "bookings" violates check constraint "bookings_party_size_check"', '23514');
    }
    const minSeq = Math.min(...pGuests.map((g) => Number(g.seq)));
    const relationOf = (g: Row) =>
      g.relation ?? (Number(g.seq) === minSeq ? 'PRIMARY' : g.rank_code ? 'SERVICE' : 'OTHER');
    if (pGuests.filter((g) => relationOf(g) === 'PRIMARY').length !== 1) {
      throw new PgError('ERR_PRIMARY_GUEST: a booking needs exactly one primary ranked person');
    }
    for (const g of pGuests) {
      if (['PRIMARY', 'SERVICE'].includes(relationOf(g)) !== Boolean(g.rank_code)) {
        throw new PgError('new row for relation "booking_guests" violates check constraint "check_guest_rank_matches_relation"', '23514');
      }
    }

    const bookingId = randomUUID();
    db.bookings.push({
      id: bookingId,
      category,
      status: 'CONFIRMED',
      check_in: checkIn,
      check_out: checkOut,
      stay: rangeStr(checkIn, checkOut),
      party_size: partySize,
      is_suite_booking: isSuite,
      notes_enc: pBooking.notes_enc ?? null,
      key_version: pBooking.key_version ?? 1,
      created_by: uid(),
      cancelled_at: null,
      cancel_reason_enc: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    });

    const seqToGuest: Record<string, string> = {};
    for (const g of pGuests) {
      if (db.booking_guests.some((x) => x.booking_id === bookingId && x.seq === Number(g.seq))) {
        throw new PgError('duplicate key value violates unique constraint "booking_guests_booking_id_seq_key"', '23505');
      }
      const gid = randomUUID();
      db.booking_guests.push({
        id: gid,
        booking_id: bookingId,
        seq: Number(g.seq),
        gender: g.gender,
        rank_code: g.rank_code ?? null,
        relation: relationOf(g),
        details: 'PENDING',
        created_by: uid(),
        created_at: nowIso(),
      });
      seqToGuest[String(g.seq)] = gid;
    }

    for (const a of pAllocs ?? []) {
      const guestId = seqToGuest[String(a.guest_seq)] ?? a.guest_id;
      if (!guestId) {
        throw new PgError('null value in column "guest_id" of relation "allocations" violates not-null constraint', '23502');
      }
      insertAllocation({
        id: randomUUID(),
        booking_id: bookingId,
        guest_id: guestId,
        room_id: a.room_id,
        bed_slot: Number(a.bed_slot),
        stay: rangeStr(checkIn, checkOut),
        status: 'ACTIVE',
        created_by: uid(),
        created_at: nowIso(),
        updated_at: nowIso(),
        deleted_at: null,
      });
    }

    audit('booking_created', 'bookings', bookingId, { category, party_size: partySize, is_suite: isSuite });
    return bookingId;
  }

  // ---- RPCs ----
  type Rpc = (a: Row) => any;
  const rpcs: Record<string, Rpc> = {
    my_access_status: () => ({
      has_profile: !!me(),
      is_active: !!me()?.is_active,
      role: me()?.role ?? null,
      team_initialized: db.team_key_versions.length > 0,
      has_access_code: db.access_codes.some((c) => c.is_active),
      require_mfa: false,
    }),

    verify_access_code: (a) => {
      if (!uid()) throw new PgError('ERR_NOT_AUTHENTICATED');
      if (!isActiveUser()) return { ok: false, error: 'ERR_ACCOUNT_INACTIVE' };
      const code = db.access_codes.find((c) => c.is_active);
      if (!code) return { ok: false, error: 'ERR_NO_ACCESS_CODE' };
      if (String(a.p_code ?? '').trim() !== code.code) return { ok: false, error: 'ERR_INVALID_CODE', attempts_left: 4 };
      if (code.valid_until && code.valid_until <= nowIso() && !isAdmin()) return { ok: false, error: 'ERR_CODE_EXPIRED' };
      audit('access_code_verified', 'access_codes', null, { code_version: code.version });
      return {
        ok: true,
        code_version: code.version,
        team_key_version: code.team_key_version,
        team_key_wrap: code.team_key_wrap,
        kdf_salt: code.kdf_salt,
        kdf_params: code.kdf_params,
        valid_until: code.valid_until,
      };
    },

    bootstrap_access: (a) => {
      need(isAdmin());
      if (db.team_key_versions.length > 0) throw new PgError('ERR_ALREADY_INITIALIZED');
      db.team_key_versions.push({ version: 1, is_active: true, created_at: nowIso() });
      db.access_codes.push({
        version: 1,
        is_active: true,
        code: String(a.p_code).trim(),
        team_key_version: 1,
        team_key_wrap: a.p_team_key_wrap,
        kdf_salt: a.p_kdf_salt,
        kdf_params: a.p_kdf_params,
        valid_until: a.p_valid_until ?? null,
        created_at: nowIso(),
      });
      audit('access_bootstrapped', 'access_codes', null, {});
      return null;
    },

    set_access_code: (a) => {
      need(isAdmin());
      const cur = db.access_codes.find((c) => c.is_active);
      const version = (cur?.version ?? 0) + 1;
      if (cur) cur.is_active = false;
      db.access_codes.push({
        version,
        is_active: true,
        code: String(a.p_code).trim(),
        team_key_version: cur?.team_key_version ?? 1,
        team_key_wrap: a.p_team_key_wrap,
        kdf_salt: a.p_kdf_salt,
        kdf_params: a.p_kdf_params,
        valid_until: a.p_valid_until ?? null,
        created_at: nowIso(),
      });
      audit('access_code_changed', 'access_codes', null, { code_version: version });
      return version;
    },

    access_code_info: () => {
      need(isAdmin());
      const c = db.access_codes.find((x) => x.is_active);
      return c
        ? { version: c.version, team_key_version: c.team_key_version, valid_until: c.valid_until, created_at: c.created_at }
        : null;
    },

    register_device: (a) => {
      need(isActiveUser());
      let d = a.p_device_id ? db.devices.find((x) => x.id === a.p_device_id && x.user_id === uid()) : undefined;
      if (d?.revoked_at) throw new PgError('ERR_DEVICE_REVOKED');
      if (!d) {
        d = { id: randomUUID(), user_id: uid(), label: String(a.p_label || 'Unknown device').slice(0, 80), last_seen_at: nowIso(), revoked_at: null, created_at: nowIso() };
        db.devices.push(d);
      } else d.last_seen_at = nowIso();
      return d.id;
    },

    revoke_device: (a) => {
      const d = db.devices.find((x) => x.id === a.p_device_id && x.user_id === uid());
      if (!d) throw new PgError('ERR_NOT_FOUND');
      d.revoked_at = nowIso();
      audit('device_revoked', 'devices', d.id, {});
      return null;
    },

    log_user_action: (a) => {
      if (!uid()) throw new PgError('ERR_NOT_AUTHENTICATED');
      if (!/^[a-z0-9_.:-]{1,64}$/.test(a.p_action ?? '')) throw new PgError('ERR_INVALID_ACTION');
      audit(a.p_action, a.p_entity ?? 'ui', a.p_entity_id ?? null, { ...(a.p_meta ?? {}), source: 'client', aal: 'aal2' });
      return null;
    },

    log_event: (a) => {
      need(isActiveUser());
      audit(a.p_action, a.p_entity, a.p_entity_id ?? null, a.p_meta ?? {});
      return null;
    },

    create_booking: (a) => createBooking(a.p_booking, a.p_guests, a.p_allocations),

    cancel_booking: (a) => {
      need(isActiveUser() && hasPerm('cancel_booking'));
      const b = bookingById(a.p_id);
      if (b) {
        b.status = 'CANCELLED';
        b.cancelled_at = nowIso();
        b.cancel_reason_enc = a.p_reason_enc;
        b.key_version = a.p_key_version;
      }
      db.allocations.forEach((x) => {
        if (x.booking_id === a.p_id && x.status === 'ACTIVE') x.status = 'RELEASED';
      });
      audit('booking_cancelled', 'bookings', a.p_id, {});
      return null;
    },

    set_guest_pii: (a) => {
      need(isActiveUser() && hasPerm('enter_guest_details'));
      if (!guestById(a.p_guest_id)) {
        throw new PgError('insert or update on table "guest_pii" violates foreign key constraint "guest_pii_guest_id_fkey"', '23503');
      }
      const existing = db.guest_pii.find((p) => p.guest_id === a.p_guest_id);
      const next = { guest_id: a.p_guest_id, pii_enc: a.p_pii_enc, id_blind_index: a.p_blind, key_version: a.p_key_version, updated_by: uid(), updated_at: nowIso() };
      if (existing) Object.assign(existing, next);
      else db.guest_pii.push(next);
      guestById(a.p_guest_id)!.details = 'COMPLETE';
      audit('guest_pii_set', 'guest_pii', a.p_guest_id, {});
      return null;
    },

    get_guest_pii: (a) => {
      need(isActiveUser() && hasPerm('reveal_guest_pii'));
      const row = db.guest_pii.find((p) => p.guest_id === a.p_guest_id);
      audit('guest_pii_revealed', 'guest_pii', a.p_guest_id, {});
      return row?.pii_enc ?? null;
    },

    search_guests_by_blind_index: (a) => {
      need(isActiveUser() && hasPerm('reveal_guest_pii'));
      audit('blind_index_search', 'guest_pii', null, {});
      const ids = new Set<string>();
      db.guest_pii.forEach((p) => {
        if (p.id_blind_index != null && p.id_blind_index === a.p_blind) {
          const g = guestById(p.guest_id);
          if (g) ids.add(g.booking_id);
        }
      });
      return [...ids].map((booking_id) => ({ booking_id }));
    },

    daily_room_state: (a) => {
      need(isActiveUser());
      const admin = isAdmin();
      const days: string[] = [];
      for (let d = a.p_from; d < a.p_to; d = addDays(d, 1)) days.push(d);
      const rooms = db.rooms
        .filter((r) => r.is_active && (r.room_type !== 'SUITE' || admin))
        .sort((x, y) => x.display_order - y.display_order);
      const out: Row[] = [];
      for (const r of rooms) {
        for (const d of days) {
          const day: [string, string] = [d, addDays(d, 1)];
          const occ = db.allocations
            .filter((al) => al.room_id === r.id && al.status === 'ACTIVE' && overlaps(parseRange(al.stay), day))
            .map((al) => {
              const b = bookingById(al.booking_id)!;
              const g = guestById(al.guest_id)!;
              return {
                allocationId: al.id,
                bookingId: al.booking_id,
                bedSlot: al.bed_slot,
                gender: g.gender,
                rankCode: g.rank_code,
                relation: g.relation,
                category: b.category,
                bookingStatus: b.status,
                checkIn: b.check_in,
                checkOut: b.check_out,
              };
            });
          out.push({
            room_id: r.id,
            room_type: r.room_type,
            display_order: r.display_order,
            date: d,
            beds_taken: occ.length,
            is_closed: db.room_closures.some((c) => c.room_id === r.id && overlaps(parseRange(c.period), day)),
            occupants: occ,
          });
        }
      }
      return out;
    },

    dashboard_counts: (a) => {
      need(isActiveUser());
      const day: [string, string] = [a.p_date, addDays(a.p_date, 1)];
      const rooms = db.rooms.filter((r) => r.room_type !== 'SUITE' && r.is_active);
      let free = 0, one = 0, full = 0, oos = 0, people = 0;
      for (const r of rooms) {
        const closed = db.room_closures.some((c) => c.room_id === r.id && overlaps(parseRange(c.period), day));
        const n = db.allocations.filter((al) => al.room_id === r.id && al.status === 'ACTIVE' && overlaps(parseRange(al.stay), day)).length;
        if (closed) oos++;
        else if (n === 0) free++;
        else if (n === 1) one++;
        else full++;
        people += n;
      }
      return [
        {
          free_rooms: free,
          one_bed_free_rooms: one,
          full_rooms: full,
          out_of_service_rooms: oos,
          people_in_house: people,
          pending_details_count: db.booking_guests.filter((g) => g.details === 'PENDING' && bookingById(g.booking_id)?.status === 'CONFIRMED').length,
          arrivals_today: db.bookings.filter((b) => b.check_in === a.p_date && b.status === 'CONFIRMED' && !b.is_suite_booking).length,
        },
      ];
    },

    eviction_candidates: (a) => {
      need(isActiveUser());
      const range: [string, string] = [a.p_check_in, a.p_check_out];
      const lower: Record<string, string[]> = { MFA: ['PI', 'LEAVE', 'TD'], PI: ['LEAVE', 'TD'] };
      const today = todayUtc();
      return db.allocations
        .filter((al) => {
          if (al.status !== 'ACTIVE' || !overlaps(parseRange(al.stay), range)) return false;
          const r = roomById(al.room_id);
          const b = bookingById(al.booking_id);
          return !!r && !!b && r.room_type !== 'SUITE' && (lower[a.p_category] ?? []).includes(b.category);
        })
        .sort((x, y) => (bookingById(x.booking_id)!.check_in < bookingById(y.booking_id)!.check_in ? -1 : x.id < y.id ? -1 : 1))
        .map((al) => {
          const b = bookingById(al.booking_id)!;
          const r = roomById(al.room_id)!;
          const g = guestById(al.guest_id)!;
          return {
            allocation_id: al.id,
            booking_id: b.id,
            room_id: r.id,
            room_name_enc: r.name_enc,
            room_type: r.room_type,
            bed_slot: al.bed_slot,
            category: b.category,
            occupant_gender: g.gender,
            occupant_rank: g.rank_code,
            days_stayed: Math.max(0, daysBetween(b.check_in, today)),
            days_remaining: Math.max(0, daysBetween(today, b.check_out)),
            fits_incoming: true,
          };
        });
    },

    approve_eviction: (a) => {
      need(isActiveUser() && hasPerm('approve_eviction'));
      if (!a.p_reason_enc || String(a.p_reason_enc).trim().length < 10) {
        throw new PgError('Eviction reason must be at least 10 characters');
      }
      if (!a.p_reason_aad_id) throw new PgError('ERR_MISSING_REASON_AAD_ID');
      const ids: string[] = a.p_evict_allocation_ids ?? [];
      if (!ids.length) throw new PgError('ERR_NO_EVICTIONS');
      const inc = a.p_incoming ?? {};
      const booking = inc.booking ?? (({ guests: _g, allocations: _a, ...rest }) => rest)(inc);
      const guests: Row[] = inc.guests ?? [];
      let allocs: Row[] | undefined = inc.allocations;

      const incomingCategory = booking?.category;
      const mayDisplace = (inc: string, existing: string) =>
        (inc === 'MFA' && ['PI', 'LEAVE', 'TD'].includes(existing)) ||
        (inc === 'PI' && ['LEAVE', 'TD'].includes(existing));

      const beds: Row[] = [];
      const displaced: string[] = [];
      for (const id of ids) {
        const al = db.allocations.find((x) => x.id === id && x.status === 'ACTIVE');
        if (!al) throw new PgError('ERR_ALLOCATION_NOT_ACTIVE');
        const b = bookingById(al.booking_id);
        if (!mayDisplace(incomingCategory, b?.category)) {
          throw new PgError(`ERR_CANNOT_EVICT: ${incomingCategory} cannot displace ${b?.category}`);
        }
        beds.push({ room_id: al.room_id, bed_slot: al.bed_slot });
        displaced.push(al.booking_id);
        al.status = 'EVICTED';
        // Only a booking with no remaining active bed is DISPLACED (migration 0017).
        if (b && !db.allocations.some((x) => x.booking_id === b.id && x.status === 'ACTIVE')) {
          b.status = 'DISPLACED';
        }
      }
      if (!allocs || allocs.length === 0) {
        if (beds.length < guests.length) {
          throw new PgError('ERR_NOT_ENOUGH_BEDS: select at least one bed per incoming guest');
        }
        allocs = guests.map((g, i) => ({ guest_seq: g.seq ?? i + 1, room_id: beds[i].room_id, bed_slot: beds[i].bed_slot }));
      }
      const newId = createBooking(booking, guests, allocs);
      ids.forEach((id, i) => {
        db.evictions.push({
          id: randomUUID(),
          evicted_allocation_id: id,
          displaced_booking_id: displaced[i],
          incoming_booking_id: newId,
          reason_enc: a.p_reason_enc,
          reason_aad_id: a.p_reason_aad_id,
          key_version: a.p_key_version,
          approved_by: uid(),
          created_at: nowIso(),
        });
      });
      audit('eviction_approved', 'evictions', newId, { evicted_count: ids.length });
      return newId;
    },

    record_denial: (a) => {
      if (['MFA', 'PI'].includes(a.p_category)) throw new PgError('ERR_CANNOT_DENY_PRIORITY');
      need(isActiveUser() && hasPerm('deny_request'));
      const id = a.p_id ?? randomUUID();
      db.denials.push({
        id,
        category: a.p_category,
        check_in: a.p_check_in,
        check_out: a.p_check_out,
        party_size: a.p_party_size,
        reason_enc: a.p_reason_enc,
        key_version: a.p_key_version,
        denied_by: uid(),
        created_at: nowIso(),
      });
      audit('booking_denied', 'denials', id, { category: a.p_category, party_size: a.p_party_size });
      return id;
    },

    report_daily: (a) => {
      need(isActiveUser() && hasPerm('view_reports'));
      const out: Row[] = [];
      for (let d = a.p_from; d < a.p_to; d = addDays(d, 1)) {
        const day: [string, string] = [d, addDays(d, 1)];
        const buckets = new Map<string, Row>();
        db.allocations
          .filter((al) => al.status === 'ACTIVE' && overlaps(parseRange(al.stay), day))
          .forEach((al) => {
            const b = bookingById(al.booking_id)!;
            const r = roomById(al.room_id)!;
            const key = `${b.category}|${r.room_type}`;
            const row = buckets.get(key) ?? { day: d, category: b.category, room_type: r.room_type, people: 0 };
            row.people++;
            buckets.set(key, row);
          });
        out.push(...[...buckets.values()].sort((x, y) => (x.category < y.category ? -1 : 1)));
      }
      return out;
    },

    report_denials: (a) => {
      need(isActiveUser() && hasPerm('view_reports'));
      const m = new Map<string, number>();
      db.denials
        .filter((d) => d.check_in >= a.p_from && d.check_in < a.p_to)
        .forEach((d) => m.set(d.category, (m.get(d.category) ?? 0) + 1));
      return [...m.entries()].map(([category, count]) => ({ category, count }));
    },

    verify_audit_chain: () => {
      need(isAdmin());
      let prev: string | null = null;
      for (const r of db.audit_log) {
        const expect = hashStr(`${prev ?? ''}|${r.at}|${r.actor}|${r.action}|${r.entity}|${r.entity_id}|${JSON.stringify(r.meta)}`);
        if (r.prev_hash !== prev || r.hash !== expect) return [{ ok: false, first_bad_id: r.id }];
        prev = r.hash;
      }
      return [{ ok: true, first_bad_id: null }];
    },

    end_room_closure: (a) => {
      need(isActiveUser() && hasPerm('manage_rooms'));
      const c = db.room_closures.find((x) => x.id === a.p_closure_id);
      if (!c) throw new PgError('ERR_NOT_FOUND');
      if (!isAdmin() && roomById(c.room_id)?.room_type === 'SUITE') throw new PgError('ERR_SUITE_ONLY_ADMIN');
      const [from, to] = parseRange(c.period);
      const today = todayUtc();
      if (from >= today) db.room_closures = db.room_closures.filter((x) => x.id !== c.id);
      else if (to > today) c.period = rangeStr(from, today);
      audit('room_closure_ended', 'room_closures', c.id, { room_id: c.room_id });
      return null;
    },

    delete_room: (a) => {
      need(isAdmin());
      const room = db.rooms.find((r) => r.id === a.p_room_id && !r.deleted_at);
      if (!room) throw new PgError('ERR_NOT_FOUND');
      const today = todayUtc();
      if (
        db.allocations.some(
          (x) => x.room_id === room.id && x.status === 'ACTIVE' && parseRange(x.stay)[1] > today,
        )
      ) {
        throw new PgError('ERR_ROOM_HAS_BOOKINGS');
      }
      db.room_closures = db.room_closures.filter(
        (c) => c.room_id !== room.id || parseRange(c.period)[1] <= today,
      );
      room.is_active = false;
      room.deleted_at = new Date().toISOString();
      audit('room_deleted', 'rooms', room.id, { room_type: room.room_type });
      return null;
    },

    set_user_role: (a) => {
      need(isAdmin());
      const target = db.profiles.find((p) => p.id === a.p_user_id);
      const admins = db.profiles.filter((p) => p.role === 'admin' && p.is_active).length;
      if (a.p_role !== 'admin' && admins <= 1 && target?.role === 'admin') throw new PgError('ERR_LAST_ADMIN');
      if (target) target.role = a.p_role;
      audit('role_updated', 'profiles', a.p_user_id, { new_role: a.p_role });
      return null;
    },

    deactivate_user: (a) => {
      need(isAdmin());
      const target = db.profiles.find((p) => p.id === a.p_user_id);
      const admins = db.profiles.filter((p) => p.role === 'admin' && p.is_active).length;
      if (admins <= 1 && target?.role === 'admin') throw new PgError('ERR_LAST_ADMIN');
      if (target) target.is_active = false;
      audit('user_deactivated', 'profiles', a.p_user_id, {});
      return null;
    },

    set_user_permissions: (a) => {
      need(isAdmin());
      const target = db.profiles.find((p) => p.id === a.p_user_id);
      if (target) target.permissions = a.p_permissions;
      audit('permissions_updated', 'profiles', a.p_user_id, { permissions: a.p_permissions });
      return null;
    },
  };

  for (const name of ['begin_rotation', 'reencrypt_batch', 'admin_page_guest_pii', 'finish_rotation_with_code']) {
    rpcs[name] = () => {
      throw new PgError('Key rotation is not available in the dev backend');
    };
  }

  // ---- table access (RLS + grants) ----
  const SELECTABLE = new Set(['profiles', 'rooms', 'room_closures', 'devices', 'bookings', 'booking_guests', 'allocations', 'audit_log', 'evictions', 'denials']);

  function visibleRows(table: string): Row[] {
    if (!SELECTABLE.has(table)) throw new PgError(`permission denied for table ${table}`, '42501');
    if (!isActiveUser()) return [];
    const admin = isAdmin();
    const suiteBookingIds = new Set(db.bookings.filter((b) => b.is_suite_booking).map((b) => b.id));
    switch (table) {
      case 'profiles':
        return db.profiles.filter((p) => admin || p.id === uid());
      case 'rooms':
        return db.rooms.filter((r) => r.room_type !== 'SUITE' || admin);
      case 'room_closures':
        return db.room_closures.filter((c) => admin || roomById(c.room_id)?.room_type !== 'SUITE');
      case 'devices':
        return db.devices.filter((d) => d.user_id === uid());
      case 'bookings':
        return db.bookings.filter((b) => !b.is_suite_booking || admin);
      case 'booking_guests':
      case 'allocations':
        return db[table].filter((r) => !suiteBookingIds.has(r.booking_id) || admin);
      case 'audit_log':
        return admin ? db.audit_log : [];
      default:
        return db[table];
    }
  }

  function project(table: string, row: Row, node: SelectNode): Row {
    const out: Row = {};
    if (node.star || node.cols.length === 0) Object.assign(out, row);
    else node.cols.forEach((c) => (out[c] = row[c]));
    for (const e of node.embeds) {
      const rel = RELATIONS[table]?.[e.name];
      if (!rel) throw new PgError(`Could not find a relationship between '${table}' and '${e.name}'`, 'PGRST200');
      if (rel.kind === 'many') {
        out[e.name] = db[rel.table].filter((c) => c[rel.fk] === row.id).map((c) => project(rel.table, c, e.node));
      } else {
        const parent = db[rel.table].find((c) => c.id === row[rel.fk]);
        out[e.name] = parent ? project(rel.table, parent, e.node) : null;
      }
    }
    return out;
  }

  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? null));

  class Query implements PromiseLike<any> {
    private filters: ((r: Row) => boolean)[] = [];
    private orders: { col: string; asc: boolean }[] = [];
    private _limit: number | null = null;
    private _range: [number, number] | null = null;
    private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    private payload: Row | Row[] | null = null;
    private selectNode: SelectNode = { star: true, cols: [], embeds: [] };
    private wantCount = false;
    private mode: 'many' | 'single' | 'maybe' = 'many';

    constructor(private table: string) {}

    select(cols = '*', opts?: { count?: string }) {
      this.selectNode = parseSelect(cols);
      if (opts?.count) this.wantCount = true;
      return this;
    }
    insert(row: Row | Row[]) { this.op = 'insert'; this.payload = row; return this; }
    update(row: Row) { this.op = 'update'; this.payload = row; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c: string, v: any) { this.filters.push((r) => r[c] === v); return this; }
    neq(c: string, v: any) { this.filters.push((r) => r[c] !== v); return this; }
    gt(c: string, v: any) { this.filters.push((r) => r[c] > v); return this; }
    gte(c: string, v: any) { this.filters.push((r) => r[c] >= v); return this; }
    lt(c: string, v: any) { this.filters.push((r) => r[c] < v); return this; }
    lte(c: string, v: any) { this.filters.push((r) => r[c] <= v); return this; }
    in(c: string, vs: any[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    is(c: string, v: any) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
    order(col: string, o?: { ascending?: boolean }) { this.orders.push({ col, asc: o?.ascending !== false }); return this; }
    limit(n: number) { this._limit = n; return this; }
    range(a: number, b: number) { this._range = [a, b]; return this; }
    single() { this.mode = 'single'; return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }

    private run(): { data: any; error: any; count?: number | null } {
      try {
        if (this.op === 'insert') return this.runInsert();
        if (this.op !== 'select') throw new PgError(`permission denied for table ${this.table}`, '42501');
        let rows = visibleRows(this.table).filter((r) => this.filters.every((f) => f(r)));
        this.orders.forEach(({ col, asc }) => {
          rows = [...rows].sort((a, b) => (a[col] === b[col] ? 0 : (a[col] > b[col] ? 1 : -1) * (asc ? 1 : -1)));
        });
        const count = rows.length;
        if (this._range) rows = rows.slice(this._range[0], this._range[1] + 1);
        if (this._limit != null) rows = rows.slice(0, this._limit);
        const projected = rows.map((r) => clone(project(this.table, r, this.selectNode)));
        return this.finish(projected, count);
      } catch (e: any) {
        return { data: null, error: toError(e) };
      }
    }

    private finish(rows: Row[], count: number) {
      if (this.mode === 'many') return { data: rows, error: null, count: this.wantCount ? count : null };
      if (rows.length === 1) return { data: rows[0], error: null };
      if (rows.length === 0 && this.mode === 'maybe') return { data: null, error: null };
      return {
        data: null,
        error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116', details: `The result contains ${rows.length} rows`, hint: null },
      };
    }

    private runInsert() {
      const snap = clone(db);
      try {
        if (this.table !== 'rooms' && this.table !== 'room_closures') {
          throw new PgError(`permission denied for table ${this.table}`, '42501');
        }
        // rooms_manage_insert / room_closures_manage_insert policies (0019): suites stay admin-only.
        const rlsDenied = () =>
          new PgError(`new row violates row-level security policy for table "${this.table}"`, '42501');
        if (!(isActiveUser() && hasPerm('manage_rooms'))) throw rlsDenied();
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
        const inserted: Row[] = [];
        for (const r of rows) {
          if (this.table === 'rooms') {
            if (r.room_type === 'SUITE' && !isAdmin()) throw rlsDenied();
            if (!['VIP', 'SEMI_VIP', 'NORMAL', 'SUITE'].includes(r.room_type)) {
              throw new PgError(`invalid input value for enum room_type: "${r.room_type}"`, '22P02');
            }
            if (!r.name_enc) throw new PgError('null value in column "name_enc" of relation "rooms" violates not-null constraint', '23502');
            const row = {
              id: r.id ?? randomUUID(),
              room_type: r.room_type,
              name_enc: r.name_enc,
              key_version: r.key_version ?? 1,
              display_order: r.display_order ?? 0,
              is_active: r.is_active ?? true,
              capacity: 2,
              created_at: nowIso(),
              updated_at: nowIso(),
              deleted_at: null,
            };
            db.rooms.push(row);
            inserted.push(row);
            audit('room_created', 'rooms', row.id, { room_type: row.room_type });
          } else {
            if (!roomById(r.room_id)) {
              throw new PgError('insert or update on table "room_closures" violates foreign key constraint "room_closures_room_id_fkey"', '23503');
            }
            if (roomById(r.room_id)?.room_type === 'SUITE' && !isAdmin()) throw rlsDenied();
            const [from, to] = parseRange(r.period);
            if (!(to > from)) throw new PgError('ERR_INVALID_DATES');
            // trg_room_closures_safety (migration 0018)
            if (db.allocations.some((al) => al.room_id === r.room_id && al.status === 'ACTIVE' && overlaps(parseRange(al.stay), [from, to]))) {
              throw new PgError('ERR_ROOM_OCCUPIED');
            }
            const row = { id: r.id ?? randomUUID(), room_id: r.room_id, period: r.period, reason_enc: r.reason_enc ?? null, created_by: uid(), created_at: nowIso() };
            db.room_closures.push(row);
            inserted.push(row);
            audit('room_closure_created', 'room_closures', row.id, { room_id: row.room_id });
          }
        }
        persist();
        emit(this.table);
        return this.finish(inserted.map((r) => clone(project(this.table, r, this.selectNode))), inserted.length);
      } catch (e: any) {
        db = snap;
        return { data: null, error: toError(e) };
      }
    }

    then<T1 = any, T2 = never>(
      onfulfilled?: ((value: any) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null,
    ): PromiseLike<T1 | T2> {
      return delay().then(() => this.run()).then(onfulfilled, onrejected);
    }
  }

  const toError = (e: any) => ({
    message: e?.message ?? String(e),
    code: e?.code ?? 'P0001',
    details: null,
    hint: null,
  });
  const delay = () => new Promise<void>((r) => setTimeout(r, LATENCY_MS));

  async function rpc(name: string, args: Row = {}) {
    await delay();
    const fn = rpcs[name];
    if (!fn) {
      return { data: null, error: { message: `Could not find the function public.${name} in the schema cache`, code: 'PGRST202', details: null, hint: null } };
    }
    const snap = clone(db);
    try {
      const data = fn(args);
      persist();
      // Only booking writes notify realtime subscribers; read RPCs must not (they'd refetch forever).
      if (['create_booking', 'cancel_booking', 'approve_eviction'].includes(name)) ['allocations', 'bookings'].forEach(emit);
      return { data: data === undefined ? null : clone(data), error: null };
    } catch (e: any) {
      db = snap;
      return { data: null, error: toError(e) };
    }
  }

  const noFactors = { data: { all: [], totp: [] }, error: null };

  const client = {
    __dev: true,
    from: (table: string) => new Query(table),
    rpc,
    functions: {
      invoke: async (name: string, opts: { body?: Row } = {}) => {
        await delay();
        if (name !== 'invite-user') return { data: null, error: { message: `Function ${name} not found` } };
        if (!isAdmin()) return { data: null, error: { message: 'ERR_PERMISSION' } };
        const email = String(opts.body?.email ?? '').trim().toLowerCase();
        if (!email) return { data: null, error: { message: 'Email is required' } };
        if (db.profiles.some((p) => p.email === email)) return { data: null, error: { message: 'A user with this email address has already been registered' } };
        const id = randomUUID();
        db.profiles.push({
          id,
          role: opts.body?.role ?? 'clerk',
          permissions: opts.body?.permissions ?? [...CLERK_PERMISSIONS],
          display_name_enc: null,
          is_active: true,
          created_at: nowIso(),
          updated_at: nowIso(),
          email,
        });
        audit('user_invited', 'profiles', id, { role: opts.body?.role ?? 'clerk' });
        persist();
        return { data: { userId: id }, error: null };
      },
    },
    channel: (name: string) => {
      const ch = { name, handlers: [] as { table: string; cb: () => void }[] };
      const api: any = {
        on: (_t: string, filter: { table: string }, cb: () => void) => {
          ch.handlers.push({ table: filter.table, cb });
          return api;
        },
        subscribe: () => {
          channels.add(ch);
          return api;
        },
      };
      api.__ch = ch;
      return api;
    },
    removeChannel: async (api: any) => {
      channels.delete(api?.__ch);
      return 'ok';
    },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => ({ data: { user: session?.user ?? null }, error: session ? null : { message: 'Auth session missing!' } }),
      onAuthStateChange: (cb: Listener) => {
        listeners.add(cb);
        setTimeout(() => cb('INITIAL_SESSION', session), 0);
        return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
      },
      signInWithPassword: async ({ email }: { email: string }) => {
        await delay();
        const key = (Object.keys(DEV_USERS) as DevUserKey[]).find((k) => DEV_USERS[k].email === String(email).trim().toLowerCase()) ?? 'admin';
        currentKey = key;
        ls(() => window.localStorage.setItem(USER_KEY, key));
        session = buildSession(key);
        notify('SIGNED_IN');
        return { data: { session, user: session.user }, error: null };
      },
      signOut: async () => {
        session = null;
        notify('SIGNED_OUT');
        return { error: null };
      },
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      updateUser: async () => ({ data: { user: session?.user ?? null }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }),
        listFactors: async () => noFactors,
        enroll: async () => ({ data: null, error: { message: 'MFA is disabled in the dev backend' } }),
        unenroll: async () => ({ data: {}, error: null }),
        challengeAndVerify: async () => ({ data: {}, error: null }),
      },
    },
  };

  return client;
}
