/**
 * apps/app/src/ui/tokens.ts
 * Visual design system tokens for Smart Mess System.
 * Clean, flat, dense official look. WCAG 2.1 AA compliant.
 */

export interface ColorTokens {
  navy: string;
  blue: string;
  saffron: string;
  green: string;
  orange: string;
  grey: string;
  red: string;
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
}

export const lightColors: ColorTokens = {
  navy: '#12283F',
  blue: '#2F5D8C',
  saffron: '#FF9933',
  green: '#138808',
  orange: '#C25E00',
  grey: '#8795A5',
  red: '#B3261E',
  bg: '#F4F6F8',
  surface: '#FFFFFF',
  border: '#DDE2E8',
  text: '#1B2733',
  muted: '#5B6877'
};

export const darkColors: ColorTokens = {
  navy: '#E0E6ED',
  blue: '#5A94D4',
  saffron: '#FF9933',
  green: '#2ECC71',
  orange: '#E67E22',
  grey: '#95A5A6',
  red: '#E74C3C',
  bg: '#0F172A',
  surface: '#1E293B',
  border: '#334155',
  text: '#F8FAFC',
  muted: '#94A3B8'
};

export const typography = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 20,
  xl: 28,
  weights: {
    regular: '400' as const,
    medium: '500' as const,
    bold: '700' as const
  }
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32
};

export const layout = {
  borderRadius: 4,
  borderWidth: 1,
  minTouchTarget: 44,
  saffronBarHeight: 3,
  sidebarWidth: 240,
  webBreakpoint: 1024
};
