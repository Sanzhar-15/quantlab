import type { ThemeTokens } from './api';

import { DEFAULT_THEME_TOKENS } from './theme';

export type ThemePresetName = 'atlas-dark' | 'atlas-neutral' | 'atlas-light';

export const THEME_PRESETS: Record<ThemePresetName, ThemeTokens> = {
  'atlas-dark': {
    ...DEFAULT_THEME_TOKENS,
  },
  'atlas-neutral': {
    background: '#141824',
    gridMajor: 'rgba(255,255,255,0.08)',
    gridMinor: 'rgba(255,255,255,0.03)',
    axisText: 'rgba(214, 223, 236, 0.72)',
    crosshair: 'rgba(214, 223, 236, 0.5)',
    focusBand: 'rgba(124, 154, 255, 0.1)',
    tooltipBackground: 'rgba(18, 24, 38, 0.92)',
    tooltipText: '#e4e9f2',
    tooltipBorder: 'rgba(255, 255, 255, 0.12)',
    seriesPrimary: '#6ab7ff',
    seriesSecondary: '#f0c070',
    seriesTertiary: '#65e0c2',
    seriesQuaternary: '#f18b7f',
    seriesQuinary: '#c1e27b',
    fontFamily: DEFAULT_THEME_TOKENS.fontFamily,
    fontSizePx: DEFAULT_THEME_TOKENS.fontSizePx,
  },
  'atlas-light': {
    background: '#f6f1e8',
    gridMajor: 'rgba(24, 32, 47, 0.12)',
    gridMinor: 'rgba(24, 32, 47, 0.05)',
    axisText: 'rgba(24, 32, 47, 0.72)',
    crosshair: 'rgba(24, 32, 47, 0.55)',
    focusBand: 'rgba(82, 140, 255, 0.12)',
    tooltipBackground: 'rgba(255, 255, 255, 0.95)',
    tooltipText: '#1a2437',
    tooltipBorder: 'rgba(24, 32, 47, 0.14)',
    seriesPrimary: '#1f6fd6',
    seriesSecondary: '#c9731a',
    seriesTertiary: '#0f766e',
    seriesQuaternary: '#c2410c',
    seriesQuinary: '#65a30d',
    fontFamily: DEFAULT_THEME_TOKENS.fontFamily,
    fontSizePx: DEFAULT_THEME_TOKENS.fontSizePx,
  },
};

export const getThemePreset = (name: ThemePresetName): ThemeTokens => ({
  ...THEME_PRESETS[name],
});
