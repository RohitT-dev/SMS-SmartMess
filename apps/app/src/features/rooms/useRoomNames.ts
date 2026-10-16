import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { decryptRoomName } from '../crypto-session/cryptoSession';

/**
 * Room id -> decrypted room name. RPCs such as daily_room_state return room ids only, so
 * screens resolve names from the (RLS-filtered) rooms table instead of the RPC payload.
 */
export function useRoomNames() {
  return useQuery({
    queryKey: ['room_names'],
    queryFn: async () => {
      const { data, error } = await supabase.from('rooms').select('id, name_enc');
      if (error) throw error;
      const names: Record<string, string> = {};
      for (const r of data || []) names[r.id] = decryptRoomName(r.id, r.name_enc);
      return names;
    },
    staleTime: 60_000,
  });
}
