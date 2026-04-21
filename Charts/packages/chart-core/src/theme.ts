import type { ThemeTokens, ThemeTokensInput } from './api';

export const DEFAULT_THEME_TOKENS: ThemeTokens = {
  background: '#0a0f18',
  gridMajor: 'rgba(255,255,255,0.15)',
  gridMinor: 'rgba(255,255,255,0.05)',
  axisText: 'rgba(230, 236, 245, 0.72)',
  crosshair: 'rgba(230, 236, 245, 0.55)',
  focusBand: 'rgba(89, 145, 255, 0.12)',
  tooltipBackground: 'rgba(12, 18, 32, 0.92)',
  tooltipText: '#e7edf8',
  tooltipBorder: 'rgba(255, 255, 255, 0.15)',
  seriesPrimary: '#5cc8ff',
  seriesSecondary: '#f3b766',
  seriesTertiary: '#4fe1b5',
  seriesQuaternary: '#f0776c',
  seriesQuinary: '#b6e36a',
  fontFamily: '"Space Grotesk", "Sora", "Avenir Next", "Helvetica Neue", sans-serif',
  fontSizePx: 12,
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const normalizeFontSize = (value: number): number => Math.max(10, Math.round(value));

const THEME_STRING_KEYS = [
  'background',
  'gridMajor',
  'gridMinor',
  'axisText',
  'crosshair',
  'focusBand',
  'tooltipBackground',
  'tooltipText',
  'tooltipBorder',
  'seriesPrimary',
  'seriesSecondary',
  'seriesTertiary',
  'seriesQuaternary',
  'seriesQuinary',
  'fontFamily',
] as const;

type ThemeStringKey = (typeof THEME_STRING_KEYS)[number];

export type ThemeTokenKey = ThemeStringKey | 'fontSizePx';

export const THEME_TOKEN_KEYS: ThemeTokenKey[] = [...THEME_STRING_KEYS, 'fontSizePx'];

export const normalizeThemeTokens = (
  input?: ThemeTokensInput | null,
  base: ThemeTokens = DEFAULT_THEME_TOKENS,
): ThemeTokens => {
  const next: ThemeTokens = { ...base };
  if (!input) return next;

  const assignString = (key: ThemeStringKey, value: unknown) => {
    if (isNonEmptyString(value)) {
      next[key] = value;
    }
  };

  for (const key of THEME_STRING_KEYS) {
    assignString(key, input[key]);
  }

  if (typeof input.fontSizePx === 'number' && Number.isFinite(input.fontSizePx)) {
    next.fontSizePx = normalizeFontSize(input.fontSizePx);
  }

  return next;
};

export const validateThemeTokens = (
  input?: ThemeTokensInput | null,
  base: ThemeTokens = DEFAULT_THEME_TOKENS,
): { tokens: ThemeTokens; missing: ThemeTokenKey[]; invalid: ThemeTokenKey[] } => {
  const tokens = normalizeThemeTokens(input, base);
  const missing: ThemeTokenKey[] = [];
  const invalid: ThemeTokenKey[] = [];
  const source = (input ?? {}) as Record<string, unknown>;

  for (const key of THEME_STRING_KEYS) {
    const value = source[key];
    if (value === undefined || value === null) {
      missing.push(key);
    } else if (!isNonEmptyString(value)) {
      invalid.push(key);
    }
  }

  const fontSize = source.fontSizePx;
  if (fontSize === undefined || fontSize === null) {
    missing.push('fontSizePx');
  } else if (typeof fontSize !== 'number' || !Number.isFinite(fontSize)) {
    invalid.push('fontSizePx');
  }

  return { tokens, missing, invalid };
};
