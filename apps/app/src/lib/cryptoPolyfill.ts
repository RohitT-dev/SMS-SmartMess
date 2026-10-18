import * as Crypto from 'expo-crypto';
import { setRandomBytesProvider } from '@sms/crypto';

// Polyfill globalThis.crypto if not present (Hermes/React Native)
if (typeof globalThis !== 'undefined') {
  if (!globalThis.crypto) {
    (globalThis as any).crypto = {};
  }
  if (!globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
      if (!array) return array;
      return Crypto.getRandomValues(array as any) as any;
    };
  }
}

// Directly register native expo-crypto RNG provider into @sms/crypto
setRandomBytesProvider((length: number): Uint8Array => {
  return Crypto.getRandomBytes(length);
});
