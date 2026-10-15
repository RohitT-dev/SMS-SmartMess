import { create } from 'zustand';
import { ColorTokens, darkColors, lightColors } from '../ui/tokens';

export type ThemeMode = 'light' | 'dark';

interface ThemeState {
  mode: ThemeMode;
  isDark: boolean;
  reduceMotion: boolean;
  colors: ColorTokens;
  setMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
  setReduceMotion: (reduce: boolean) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: 'light',
  isDark: false,
  reduceMotion: false,
  colors: lightColors,
  setMode: (mode: ThemeMode) =>
    set({
      mode,
      isDark: mode === 'dark',
      colors: mode === 'dark' ? darkColors : lightColors
    }),
  toggleTheme: () =>
    set((state) => {
      const nextDark = !state.isDark;
      return {
        mode: nextDark ? 'dark' : 'light',
        isDark: nextDark,
        colors: nextDark ? darkColors : lightColors
      };
    }),
  setReduceMotion: (reduceMotion: boolean) => set({ reduceMotion })
}));
