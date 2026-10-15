/**
 * scripts/seed-dev.ts
 * Local development data seeder.
 * Refuses to run in production or against non-local Supabase instances.
 */

import { createClient } from '@supabase/supabase-js';
import {
  deriveAllSubkeys,
  encryptEnvelope,
  generateRecoveryCode,
  getRandomBytes,
  wrapTeamKeyWithRecoveryCode,
  sealTeamKey,
  generateUserKeyPair,
  wrapPrivateKey,
  deriveUserPassphraseKey,
  computeBlindIndex
} from '../packages/crypto/src/index.ts';

async function seed() {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: seed-dev.ts refuses to run when NODE_ENV=production');
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
  const isLocal =
    supabaseUrl.includes('localhost') ||
    supabaseUrl.includes('127.0.0.1') ||
    supabaseUrl.includes('0.0.0.0');

  if (!isLocal) {
    console.error(`FATAL: seed-dev.ts refuses to run against non-local database: ${supabaseUrl}`);
    process.exit(1);
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-dev-service-role-key';
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  console.log('Seeding local development environment...');

  // 1. Generate dev master team key
  const devTeamKey = getRandomBytes(32);
  const subkeys = deriveAllSubkeys(devTeamKey);
  const recoveryCode = generateRecoveryCode();
  const salt = getRandomBytes(16);
  const recoveryWrap = wrapTeamKeyWithRecoveryCode(devTeamKey, recoveryCode, salt);

  console.log(`Generated dev recovery code: ${recoveryCode}`);

  // 2. Insert team_key_versions row
  const { error: keyVersionErr } = await supabase.from('team_key_versions').upsert({
    version: 1,
    recovery_wrap: recoveryWrap,
    recovery_kdf_salt: Buffer.from(salt).toString('hex'),
    recovery_kdf_params: { m: 19456, t: 2, p: 1 },
    is_active: true
  });

  if (keyVersionErr) {
    console.warn('Note: Could not insert team key version (db may not be running yet):', keyVersionErr.message);
  }

  // 3. Prepare room inventory (50 rooms total)
  interface RoomPlan {
    id: string;
    type: 'VIP' | 'SEMI_VIP' | 'NORMAL' | 'SUITE';
    code: string;
    displayOrder: number;
  }

  const rooms: RoomPlan[] = [];
  let order = 1;

  for (let i = 1; i <= 10; i++) {
    rooms.push({
      id: `00000000-0000-0000-0001-${i.toString().padStart(12, '0')}`,
      type: 'VIP',
      code: `VIP-${i.toString().padStart(2, '0')}`,
      displayOrder: order++
    });
  }
  for (let i = 1; i <= 14; i++) {
    rooms.push({
      id: `00000000-0000-0000-0002-${i.toString().padStart(12, '0')}`,
      type: 'SEMI_VIP',
      code: `SV-${i.toString().padStart(2, '0')}`,
      displayOrder: order++
    });
  }
  for (let i = 1; i <= 22; i++) {
    rooms.push({
      id: `00000000-0000-0000-0003-${i.toString().padStart(12, '0')}`,
      type: 'NORMAL',
      code: `N-${i.toString().padStart(2, '0')}`,
      displayOrder: order++
    });
  }
  for (let i = 1; i <= 4; i++) {
    rooms.push({
      id: `00000000-0000-0000-0004-${i.toString().padStart(12, '0')}`,
      type: 'SUITE',
      code: `SUITE-${i.toString().padStart(2, '0')}`,
      displayOrder: order++
    });
  }

  console.log(`Generated ${rooms.length} room specifications (10 VIP, 14 Semi VIP, 22 Normal, 4 Suites)`);

  const roomInserts = rooms.map((r) => {
    const aad = `rooms.name_enc.${r.id}`;
    const nameEnc = encryptEnvelope({
      plaintext: r.code,
      subkey: subkeys.roomName,
      keyVersion: 1,
      aad
    });

    return {
      id: r.id,
      room_type: r.type,
      name_enc: nameEnc,
      key_version: 1,
      display_order: r.displayOrder,
      is_active: true,
      capacity: 2
    };
  });

  const { error: roomsErr } = await supabase.from('rooms').upsert(roomInserts);
  if (roomsErr) {
    console.warn('Note: Could not insert rooms:', roomsErr.message);
  } else {
    console.log(`Successfully seeded ${roomInserts.length} rooms.`);
  }

  console.log('Dev seed completed successfully.');
}

seed().catch((err) => {
  console.error('Seed script error:', err);
  process.exit(1);
});
