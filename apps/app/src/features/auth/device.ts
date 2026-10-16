import { Platform } from 'react-native';
import { supabase } from '../../lib/supabase';

const DEVICE_ID_KEY = 'sms.device_id';

export class DeviceRevokedError extends Error {
  constructor() {
    super('This device has been revoked. Contact an Administrator.');
    this.name = 'DeviceRevokedError';
  }
}

async function readLocal(key: string): Promise<string | null> {
  try {
    if (Platform.OS === 'web') {
      return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    }
    const SecureStore = await import('expo-secure-store');
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function writeLocal(key: string, value: string): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
      return;
    }
    const SecureStore = await import('expo-secure-store');
    await SecureStore.setItemAsync(key, value);
  } catch {
    // Non-fatal: device tracking simply restarts next time.
  }
}

function deviceLabel(): string {
  if (Platform.OS === 'web') {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isPhone = /Mobi|Android|iPhone/i.test(ua);
    return isPhone ? 'Mobile browser' : 'Desktop browser';
  }
  return `${Platform.OS === 'ios' ? 'iOS' : 'Android'} app (${String(Platform.Version)})`;
}

/**
 * Registers this install as a device for the signed-in user and binds it to the
 * current Supabase session (server-side, via register_device). Fails closed:
 * any error blocks unlock, and DeviceRevokedError is thrown for revoked devices.
 * Guest PII RPCs refuse sessions that are not bound to an active device.
 */
export async function touchDevice(userId: string): Promise<void> {
  const storageKey = `${DEVICE_ID_KEY}.${userId}`;
  const storedId = await readLocal(storageKey);

  const { data, error } = await supabase.rpc('register_device', {
    p_device_id: storedId,
    p_label: deviceLabel(),
  });

  if (error) {
    if (error.message.includes('ERR_DEVICE_REVOKED')) throw new DeviceRevokedError();
    throw new Error(`Device registration failed: ${error.message}`);
  }
  if (typeof data !== 'string') {
    throw new Error('Device registration failed: no device id returned');
  }

  if (data !== storedId) {
    await writeLocal(storageKey, data);
  }
}
