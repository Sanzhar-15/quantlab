import { describe, expect, it } from 'vitest';

import { DEFAULT_THEME_TOKENS, THEME_TOKEN_KEYS, normalizeThemeTokens, validateThemeTokens } from './theme';
import { THEME_PRESETS, getThemePreset } from './presets';

describe('normalizeThemeTokens', () => {
  it('returns a copy of defaults when no input provided', () => {
    const result = normalizeThemeTokens();
    expect(result).toEqual(DEFAULT_THEME_TOKENS);
    expect(result).not.toBe(DEFAULT_THEME_TOKENS);
  });

  it('merges valid overrides and ignores invalid values', () => {
    const result = normalizeThemeTokens({
      axisText: '#ffffff',
      fontSizePx: 13.6,
      background: '',
      tooltipText: '   ',
      tooltipBorder: '#123456',
    });

    expect(result.axisText).toBe('#ffffff');
    expect(result.fontSizePx).toBe(14);
    expect(result.background).toBe(DEFAULT_THEME_TOKENS.background);
    expect(result.tooltipText).toBe(DEFAULT_THEME_TOKENS.tooltipText);
    expect(result.tooltipBorder).toBe('#123456');
  });

  it('clamps font sizes to a readable minimum', () => {
    const result = normalizeThemeTokens({ fontSizePx: 4 });
    expect(result.fontSizePx).toBe(10);
  });

  it('reports missing and invalid tokens', () => {
    const report = validateThemeTokens({ background: '', fontSizePx: Number.NaN });
    expect(report.tokens.background).toBe(DEFAULT_THEME_TOKENS.background);
    expect(report.invalid).toEqual(['background', 'fontSizePx']);
    expect(report.missing).toEqual(
      THEME_TOKEN_KEYS.filter((key) => key !== 'background' && key !== 'fontSizePx'),
    );
  });
});

describe('theme presets', () => {
  it('exposes curated presets', () => {
    expect(Object.keys(THEME_PRESETS).sort()).toEqual([
      'atlas-dark',
      'atlas-light',
      'atlas-neutral',
    ]);
    expect(THEME_PRESETS['atlas-dark'].background).toBe(DEFAULT_THEME_TOKENS.background);
    expect(THEME_PRESETS['atlas-light'].tooltipBackground).toBeDefined();
    expect(THEME_PRESETS['atlas-neutral'].tooltipBackground).toBeDefined();
  });

  it('returns a copy of a preset', () => {
    const preset = getThemePreset('atlas-dark');
    expect(preset).toEqual(THEME_PRESETS['atlas-dark']);
    expect(preset).not.toBe(THEME_PRESETS['atlas-dark']);
  });
});
