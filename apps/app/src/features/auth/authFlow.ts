import { supabase } from '../../lib/supabase';
import { logAction } from '../../lib/activityLog';
import { useSessionStore } from '../../state/sessionStore';
import { touchDevice } from './device';

export type PostAuthRoute =
  '/(auth)/mfa' | '/(auth)/key-setup' | '/(auth)/waiting-for-access' | '/(auth)/unlock';

export interface AccessStatus {
  has_profile: boolean;
  is_active: boolean;
  role: 'admin' | 'clerk' | null;
  team_initialized: boolean;
  has_access_code: boolean;
  /** Server switch (app_config.require_mfa); MFA is skipped while false. */
  require_mfa: boolean;
}

export class AccountInactiveError extends Error {
  constructor() {
    super('Your account is not active. Contact an Administrator to restore access.');
    this.name = 'AccountInactiveError';
  }
}

export async function fetchAccessStatus(): Promise<AccessStatus> {
  const { data, error } = await supabase.rpc('my_access_status');
  if (error) throw error;
  return data as AccessStatus;
}

/**
 * Decides where a signed-in user goes next:
 * MFA (only when the server requires it) → first-run access code setup (first admin)
 * → waiting for an access code → enter access code.
 */
export async function resolvePostAuthRoute(): Promise<{
  pathname: PostAuthRoute;
  params?: Record<string, string>;
}> {
  const status = await fetchAccessStatus();
  if (!status.has_profile || !status.is_active) {
    throw new AccountInactiveError();
  }

  if (status.require_mfa) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (!aal || aal.currentLevel !== 'aal2') {
      return { pathname: '/(auth)/mfa' };
    }
  }

  if (status.role === 'admin' && !status.team_initialized) {
    return { pathname: '/(auth)/key-setup' };
  }
  if (!status.has_access_code) {
    return { pathname: '/(auth)/waiting-for-access' };
  }
  return { pathname: '/(auth)/unlock' };
}

/** Wipes in-memory keys and ends the Supabase session. */
export async function signOut(
  reason: 'user' | 'inactive' | 'device_revoked' = 'user',
): Promise<void> {
  // Await the log so it is sent while the access token is still valid.
  await logAction('auth.sign_out', { meta: { trigger: reason } });
  useSessionStore.getState().lockSession();
  await supabase.auth.signOut();
}

/**
 * Runs after the team key is loaded into memory (access code or first-run setup):
 * loads the caller's role/permissions and registers this device.
 * Throws DeviceRevokedError when this device was revoked.
 */
export async function completeUnlock(): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Session expired. Please sign in again.');

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, permissions')
    .eq('id', user.id)
    .single();
  if (profileError) throw profileError;
  useSessionStore.getState().setUserProfile(profile.role, profile.permissions);

  try {
    await touchDevice(user.id);
  } catch (err) {
    useSessionStore.getState().lockSession();
    throw err;
  }
}
