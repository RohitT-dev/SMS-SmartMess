import { create } from 'zustand';
import type { Session } from '@supabase/supabase-js';

interface AuthState {
  /** True once the persisted Supabase session has been restored from storage. */
  ready: boolean;
  session: Session | null;
  /** Set while the user is completing an invite or password-recovery link. */
  needsPasswordSet: boolean;
  setSession: (session: Session | null) => void;
  setReady: () => void;
  setNeedsPasswordSet: (value: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  ready: false,
  session: null,
  needsPasswordSet: false,
  setSession: (session) => set({ session }),
  setReady: () => set({ ready: true }),
  setNeedsPasswordSet: (value) => set({ needsPasswordSet: value }),
}));
