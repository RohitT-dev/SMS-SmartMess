import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';

/** Tables whose changes alter what inventory, bookings or room screens show. */
const WATCHED_TABLES = ['allocations', 'bookings', 'rooms', 'room_closures'] as const;

/** Cached queries that do not depend on those tables and must not refetch on every change. */
const STATIC_QUERIES = new Set(['access_code_info', 'mfa_required', 'user_devices', 'admin_profiles']);

/**
 * Keeps every open screen current: when any user changes a booking, allocation, room or
 * room closure, Supabase Realtime notifies this client and the affected queries refetch.
 * A burst of changes (one booking touches several rows) collapses into a single refetch.
 */
export function useRealtimeSync(): void {
  const queryClient = useQueryClient();
  // Unique per mount: removeChannel() unsubscribes asynchronously, so a shared topic can be
  // reused by a remount while still subscribed (dev-mode mount, cleanup, remount).
  const channelName = useRef(`app-realtime-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        queryClient.invalidateQueries({
          predicate: (q) => !STATIC_QUERIES.has(String(q.queryKey[0])),
        });
      }, 250);
    };

    let channel = supabase.channel(channelName.current);
    for (const table of WATCHED_TABLES) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, refresh);
    }
    channel.subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [queryClient]);
}
