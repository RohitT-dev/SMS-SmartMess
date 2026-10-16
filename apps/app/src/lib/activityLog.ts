import { Platform } from 'react-native';
import { supabase } from './supabase';

/**
 * Per-user activity logging.
 *
 * Every entry is written through the `log_user_action` RPC into the hash-chained
 * `audit_log` table against the caller's auth.uid(). Logging is fire-and-forget:
 * a failed log never blocks or breaks the user's action.
 *
 * NEVER pass PII (names, ID numbers, phone numbers, emails, passphrases, recovery
 * codes) in `meta`. Keys that look sensitive are stripped as a safety net, and only
 * primitive values are kept.
 */

export type ActionMetaValue = string | number | boolean | null | undefined;
export type ActionMeta = Record<string, ActionMetaValue | ActionMetaValue[]>;

export interface LogActionOptions {
  entity?: string;
  entityId?: string | null;
  meta?: ActionMeta;
}

const SENSITIVE_KEY =
  /(name|phone|email|mail|id_?number|service_?no|pii|pass|secret|recovery|totp|otp|token|private|sealed|reason|note)/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STRING = 120;

function sanitizeValue(value: ActionMetaValue): ActionMetaValue {
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

export function sanitizeMeta(meta: ActionMeta = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SENSITIVE_KEY.test(key) || value === undefined) continue;
    out[key] = Array.isArray(value) ? value.slice(0, 20).map(sanitizeValue) : sanitizeValue(value);
  }
  return out;
}

export function normalizeAction(action: string): string {
  return action
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .slice(0, 64);
}

/** Returns a promise that never rejects; most callers don't need to await it. */
export function logAction(action: string, options: LogActionOptions = {}): Promise<void> {
  const payload = {
    p_action: normalizeAction(action),
    p_entity: normalizeAction(options.entity || 'ui'),
    p_entity_id: options.entityId && UUID_RE.test(options.entityId) ? options.entityId : null,
    p_meta: { ...sanitizeMeta(options.meta), platform: Platform.OS },
  };

  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.info(
      '[activity]',
      payload.p_action,
      payload.p_entity,
      payload.p_entity_id ?? '',
      payload.p_meta,
    );
  }

  return (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      // Nothing to attribute the action to before sign-in; Supabase Auth logs cover that.
      if (!data.session) return;
      const { error } = await supabase.rpc('log_user_action', payload);
      if (error && __DEV__) console.warn('[activity] log failed:', error.message);
    } catch (err) {
      if (__DEV__) console.warn('[activity] log failed:', err);
    }
  })();
}
