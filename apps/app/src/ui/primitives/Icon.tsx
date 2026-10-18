import React from 'react';
import { Platform } from 'react-native';
import Svg, { Path } from 'react-native-svg';

/**
 * Line icons drawn on a 24px grid with a 1.75 stroke. Replaces emoji glyphs,
 * which render differently on every platform and ignore the theme colour.
 */
const PATHS = {
  bed: ['M3 18V7', 'M3 14h18v4', 'M21 14v-3a3 3 0 0 0-3-3h-7v6', 'M7 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  plus: ['M12 5v14', 'M5 12h14'],
  ledger: ['M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z', 'M5 18a2 2 0 0 1 2-2h12', 'M9 8h6'],
  chart: ['M4 20h16', 'M7 16v-5', 'M12 16V7', 'M17 16v-8'],
  star: ['M12 4l2.4 5 5.3.6-4 3.6 1.1 5.3L12 15.8 7.2 18.5l1.1-5.3-4-3.6 5.3-.6z'],
  users: [
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    'M3 20a6 6 0 0 1 12 0',
    'M16 4.5a3.5 3.5 0 0 1 0 6.5',
    'M18 14.5a6 6 0 0 1 3 5.5',
  ],
  building: ['M5 20V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15', 'M15 10h3a1 1 0 0 1 1 1v9', 'M3 20h18', 'M9 8h2', 'M9 12h2', 'M9 16h2'],
  audit: ['M7 3h7l4 4v14H7z', 'M14 3v4h4', 'M10 12h5', 'M10 16h5'],
  key: ['M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M10.8 12.2L19 4', 'M16 7l2 2', 'M14 9l1.5 1.5'],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.07-.4.1-.8.1-1.2z',
  ],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  lock: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  sun: [
    'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4',
    'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4',
  ],
  moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'],
  back: ['M15 5l-7 7 7 7'],
  chevron: ['M9 5l7 7-7 7'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  hourglass: ['M7 3h10', 'M7 21h10', 'M8 3v3a4 4 0 0 0 8 0V3', 'M8 21v-3a4 4 0 0 1 8 0v3'],
  logout: ['M10 4H5v16h5', 'M15 8l4 4-4 4', 'M19 12H9'],
} as const;

// react-native-svg forwards unknown props to the DOM on web, where the native
// a11y props trigger React warnings; use aria-hidden there instead.
const HIDDEN_FROM_A11Y =
  Platform.OS === 'web'
    ? ({ 'aria-hidden': true } as const)
    : ({ accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const);

export type IconName = keyof typeof PATHS;

export interface IconProps {
  name: IconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}

export const Icon: React.FC<IconProps> = ({ name, size = 20, color, strokeWidth = 1.75 }) => (
  <Svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...HIDDEN_FROM_A11Y}
  >
    {PATHS[name].map((d) => (
      <Path key={d} d={d} />
    ))}
  </Svg>
);
