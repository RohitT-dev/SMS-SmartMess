import { wipeBytes } from './utils.ts';

let _activeTeamKey: Uint8Array | null = null;
let _activeKeyVersion: number | null = null;

/**
 * Stores the decrypted team key in an isolated module closure.
 * This key is never placed in React state, window, storage, or logs.
 */
export function setSessionKey(teamKey: Uint8Array, version: number): void {
  if (teamKey.length !== 32) {
    throw new Error('Team key must be 32 bytes');
  }
  // Clear any existing key safely first
  clearSessionKey();

  _activeTeamKey = new Uint8Array(teamKey.length);
  _activeTeamKey.set(teamKey);
  _activeKeyVersion = version;
}

/**
 * Retrieves the currently active team key and version.
 * Returns null if the session is locked.
 */
export function getSessionKey(): { teamKey: Uint8Array; version: number } | null {
  if (!_activeTeamKey || _activeKeyVersion === null) {
    return null;
  }
  return {
    teamKey: _activeTeamKey,
    version: _activeKeyVersion
  };
}

/**
 * Checks whether the team key is currently loaded in memory.
 */
export function isSessionUnlocked(): boolean {
  return _activeTeamKey !== null && _activeKeyVersion !== null;
}

/**
 * Wipes the active team key from memory using constant zeroing.
 * MUST be called immediately on lock or app backgrounding.
 */
export function clearSessionKey(): void {
  if (_activeTeamKey) {
    wipeBytes(_activeTeamKey);
    _activeTeamKey = null;
  }
  _activeKeyVersion = null;
}
