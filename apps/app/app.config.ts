import { ExpoConfig, ConfigContext } from 'expo/config';
import fs from 'fs';
import path from 'path';

// Expo only auto-loads `.env` from this app directory, but the README tells people to
// create it at the repo root. Read both (app dir wins) and expose the public values via
// `extra` so the client can fall back to them at runtime.
function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const fileEnv = {
  ...readEnvFile(path.resolve(__dirname, '../../.env')),
  ...readEnvFile(path.resolve(__dirname, '.env')),
};
const env = (key: string) => process.env[key] || fileEnv[key] || '';

// Also expose EXPO_PUBLIC_* values from the repo-root .env to Metro, which inlines
// process.env.EXPO_PUBLIC_* into the bundle.
for (const [key, value] of Object.entries(fileEnv)) {
  if (key.startsWith('EXPO_PUBLIC_') && !process.env[key]) process.env[key] = value;
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Smart Mess System',
  slug: 'smart-mess-system',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  scheme: 'smartmess',
  assetBundlePatterns: ['**/*'],
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'mil.gov.sms',
  },
  android: {
    adaptiveIcon: {
      backgroundColor: '#12283F',
    },
    package: 'mil.gov.sms',
  },
  web: {
    bundler: 'metro',
    output: 'single',
    favicon: './assets/favicon.png',
  },
  plugins: [
    'expo-router',
    'expo-local-authentication',
    'expo-secure-store',
    // The top-level `splash` field is no longer in the config schema; configure it here.
    ['expo-splash-screen', { backgroundColor: '#12283F' }],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    // Set by `eas init` (or EAS_PROJECT_ID) so phone builds know which Expo project they belong to.
    ...(env('EAS_PROJECT_ID') ? { eas: { projectId: env('EAS_PROJECT_ID') } } : {}),
    supabaseUrl: env('EXPO_PUBLIC_SUPABASE_URL'),
    supabaseAnonKey: env('EXPO_PUBLIC_SUPABASE_ANON_KEY') || env('EXPO_PUBLIC_SUPABASE_KEY'),
  },
});
