/**
 * apps/app/src/ui/tokens.ts
 * Visual design system tokens for Smart Mess System.
 *
 * Direction: an official service register. Deep navy chrome, a single saffron
 * rule as the institutional mark, India green for "free". Flat, dense, quiet.
 * Every text/background pair below is checked for WCAG 2.1 AA (4.5:1 body).
 *
 * Rules:
 * - Saffron is a mark, never body text: use `saffronInk` when saffron must be read.
 * - Status tints (`*Soft`) are solid colours, not alpha hacks, so they hold up in dark mode.
 * - `chrome` (sidebar) stays dark navy in both themes; `navy` is the heading ink and flips.
 */

export interface ColorTokens {
  /** Heading ink and selected-state fill. Flips to a light tone in dark mode. */
  navy: string;
  /** Text/icon colour for content drawn on a `navy` background. */
  onNavy: string;
  /** Primary action colour. */
  blue: string;
  /** Pressed / hover state for primary actions. */
  bluePressed: string;
  /** Text colour for content on `blue` and `red` fills. */
  onAction: string;
  saffron: string;
  /** Saffron that passes AA as text (badges, labels). */
  saffronInk: string;
  green: string;
  orange: string;
  grey: string;
  red: string;
  redPressed: string;
  /** Solid tints for status backgrounds (banners, badges). */
  blueSoft: string;
  greenSoft: string;
  orangeSoft: string;
  redSoft: string;
  saffronSoft: string;
  greySoft: string;
  bg: string;
  surface: string;
  /** Subtle raised/hover background inside a surface. */
  surfaceAlt: string;
  border: string;
  /** Stronger border for inputs and controls. */
  borderStrong: string;
  text: string;
  muted: string;
  /** Keyboard focus ring. */
  focus: string;
  /** Sidebar / app chrome. Always dark. */
  chrome: string;
  chromeRaised: string;
  onChrome: string;
  chromeMuted: string;
}

export const lightColors: ColorTokens = {
  navy: '#12283F',
  onNavy: '#FFFFFF',
  blue: '#2A5885',
  bluePressed: '#1D4268',
  onAction: '#FFFFFF',
  saffron: '#FF9933',
  saffronInk: '#9A4A00',
  green: '#11750A',
  orange: '#A84F00',
  grey: '#6B7A8A',
  red: '#B3261E',
  redPressed: '#8E1D16',
  blueSoft: '#E8F0F8',
  greenSoft: '#E6F3E4',
  orangeSoft: '#FBEEE1',
  redSoft: '#FBE9E8',
  saffronSoft: '#FFF1E2',
  greySoft: '#EEF1F4',
  bg: '#F2F4F7',
  surface: '#FFFFFF',
  surfaceAlt: '#F7F9FB',
  border: '#DCE1E7',
  borderStrong: '#8A95A2',
  text: '#17222E',
  muted: '#566373',
  focus: '#2A5885',
  chrome: '#12283F',
  chromeRaised: '#1C3550',
  onChrome: '#FFFFFF',
  chromeMuted: '#A9B8C8',
};

export const darkColors: ColorTokens = {
  navy: '#DCE6F0',
  onNavy: '#0C1825',
  blue: '#6FA3DA',
  bluePressed: '#8DB8E4',
  onAction: '#0C1825',
  saffron: '#FF9933',
  saffronInk: '#FFB066',
  green: '#5BC151',
  orange: '#EE9A4A',
  grey: '#8D9CAC',
  red: '#F07A71',
  redPressed: '#F59B94',
  blueSoft: '#16283B',
  greenSoft: '#13291A',
  orangeSoft: '#2E2114',
  redSoft: '#331A1A',
  saffronSoft: '#2F2214',
  greySoft: '#1B2734',
  bg: '#0B1520',
  surface: '#121F2D',
  surfaceAlt: '#182839',
  border: '#24364A',
  borderStrong: '#5A7591',
  text: '#E7EDF3',
  muted: '#95A5B6',
  focus: '#8DB8E4',
  chrome: '#0E1B29',
  chromeRaised: '#1A2C40',
  onChrome: '#E7EDF3',
  chromeMuted: '#8D9CAC',
};

export const typography = {
  xs: 12,
  sm: 14,
  base: 16,
  md: 18,
  lg: 20,
  xl: 28,
  xxl: 32,
  weights: {
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
  },
  /** Fixed-width digits so counts and dates line up in columns. */
  numeric: { fontVariant: ['tabular-nums'] as ('tabular-nums')[] },
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const layout = {
  /** Controls: buttons, inputs, badges. */
  borderRadius: 4,
  /** Surfaces: cards, dialogs, tiles. */
  surfaceRadius: 6,
  borderWidth: 1,
  minTouchTarget: 44,
  saffronBarHeight: 3,
  sidebarWidth: 248,
  webBreakpoint: 1024,
  phoneBreakpoint: 600,
};
