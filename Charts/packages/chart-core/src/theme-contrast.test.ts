import { describe, expect, it } from 'vitest';

import { DEFAULT_THEME_TOKENS } from './theme';
import { THEME_PRESETS } from './presets';

type Rgba = { r: number; g: number; b: number; a: number };

const MIN_AXIS_TEXT_CONTRAST = 4.5;
const MIN_TOOLTIP_TEXT_CONTRAST = 4.5;
const MIN_GRID_MAJOR_CONTRAST = 1.2;
const MIN_GRID_MINOR_CONTRAST = 1.05;
const MIN_FOCUS_BAND_CONTRAST = 1.1;

const parseColor = (color: string): Rgba | null => {
  const trimmed = color.trim();
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0]! + hex[0]!, 16);
      const g = parseInt(hex[1]! + hex[1]!, 16);
      const b = parseInt(hex[2]! + hex[2]!, 16);
      return { r, g, b, a: 1 };
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return { r, g, b, a: 1 };
    }
    return null;
  }

  const match = trimmed.match(/rgba?\(([^)]+)\)/);
  if (match) {
    const parts = match[1]!.split(',').map((part) => part.trim());
    if (parts.length >= 3) {
      const toChannel = (value: string): number => {
        if (value.endsWith('%')) {
          const percent = Number.parseFloat(value);
          return Math.round((percent / 100) * 255);
        }
        return Number.parseFloat(value);
      };
      const r = toChannel(parts[0]!);
      const g = toChannel(parts[1]!);
      const b = toChannel(parts[2]!);
      const a = parts.length >= 4 ? Number.parseFloat(parts[3]!) : 1;
      if (
        Number.isFinite(r) &&
        Number.isFinite(g) &&
        Number.isFinite(b) &&
        Number.isFinite(a)
      ) {
        return { r, g, b, a };
      }
    }
  }

  return null;
};

const blend = (fg: Rgba, bg: Rgba): Rgba => {
  const alpha = Math.max(0, Math.min(1, fg.a));
  return {
    r: Math.round(bg.r + (fg.r - bg.r) * alpha),
    g: Math.round(bg.g + (fg.g - bg.g) * alpha),
    b: Math.round(bg.b + (fg.b - bg.b) * alpha),
    a: 1,
  };
};

const toLinear = (value: number): number => {
  const normalized = value / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
};

const luminance = (color: Rgba): number =>
  0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);

const contrastRatio = (a: Rgba, b: Rgba): number => {
  const lumA = luminance(a);
  const lumB = luminance(b);
  const light = Math.max(lumA, lumB);
  const dark = Math.min(lumA, lumB);
  return (light + 0.05) / (dark + 0.05);
};

const resolveEffective = (color: string, base: Rgba): Rgba => {
  const parsed = parseColor(color);
  if (!parsed) {
    throw new Error(`Unable to parse color: ${color}`);
  }
  if (parsed.a >= 1) return { ...parsed, a: 1 };
  return blend(parsed, base);
};

describe('theme contrast checks', () => {
  const themes = {
    default: DEFAULT_THEME_TOKENS,
    ...THEME_PRESETS,
  };

  it('meets minimum contrast thresholds for text, grid, and focus', () => {
    for (const [name, theme] of Object.entries(themes)) {
      const background = resolveEffective(theme.background, { r: 255, g: 255, b: 255, a: 1 });
      const axisText = resolveEffective(theme.axisText, background);
      const gridMajor = resolveEffective(theme.gridMajor, background);
      const gridMinor = resolveEffective(theme.gridMinor, background);
      const focusBand = resolveEffective(theme.focusBand, background);
      const tooltipBackground = resolveEffective(
        theme.tooltipBackground ?? theme.background,
        background,
      );
      const tooltipText = resolveEffective(
        theme.tooltipText ?? theme.axisText,
        tooltipBackground,
      );

      expect(
        contrastRatio(axisText, background),
        `${name} axis text contrast`,
      ).toBeGreaterThanOrEqual(MIN_AXIS_TEXT_CONTRAST);
      expect(
        contrastRatio(tooltipText, tooltipBackground),
        `${name} tooltip text contrast`,
      ).toBeGreaterThanOrEqual(MIN_TOOLTIP_TEXT_CONTRAST);
      expect(
        contrastRatio(gridMajor, background),
        `${name} grid major contrast`,
      ).toBeGreaterThanOrEqual(MIN_GRID_MAJOR_CONTRAST);
      expect(
        contrastRatio(gridMinor, background),
        `${name} grid minor contrast`,
      ).toBeGreaterThanOrEqual(MIN_GRID_MINOR_CONTRAST);
      expect(
        contrastRatio(focusBand, background),
        `${name} focus band contrast`,
      ).toBeGreaterThanOrEqual(MIN_FOCUS_BAND_CONTRAST);
    }
  });
});
