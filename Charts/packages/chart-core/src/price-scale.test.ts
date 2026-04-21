import { describe, expect, it } from 'vitest';

import { PriceScale, applyPriceScaleMode } from './price-scale';

describe('PriceScale', () => {
  it('autoscale ignores NaN values', () => {
    const scale = new PriceScale();
    const values = new Float64Array([1, Number.NaN, 5, 2]);
    scale.autoScale(values, 0, values.length);
    const range = scale.getRange();
    expect(range.min).toBe(1);
    expect(range.max).toBe(5);
  });

  it('autoScale limits to visible range', () => {
    const scale = new PriceScale();
    const values = new Float64Array([1, 2, 100, 3, 4]);
    scale.autoScale(values, 0, 2);
    const range = scale.getRange();
    expect(range.max).toBe(2);
  });

  it('falls back to linear when log has non-positive values', () => {
    const scale = new PriceScale({ type: 'log' });
    const values = new Float64Array([-1, 0, 10]);
    scale.autoScale(values, 0, values.length);
    expect(scale.getEffectiveType()).toBe('linear');
  });

  it('generates stable tick steps for small range changes', () => {
    const scale = new PriceScale();
    const values = new Float64Array([0, 100]);
    scale.autoScale(values, 0, values.length);
    const ticksA = scale.getTicks(5);
    const stepA = ticksA[1]! - ticksA[0]!;

    const valuesB = new Float64Array([0, 101]);
    scale.autoScale(valuesB, 0, valuesB.length);
    const ticksB = scale.getTicks(5);
    const stepB = ticksB[1]! - ticksB[0]!;

    expect(stepA).toBe(stepB);
  });

  it('inverts the scale when invertScale is enabled', () => {
    const scale = new PriceScale({ invertScale: true });
    scale.setRange(0, 10, 1);
    scale.setHeight(100);

    expect(scale.valueToY(0)).toBeCloseTo(0, 6);
    expect(scale.valueToY(10)).toBeCloseTo(100, 6);
    expect(scale.yToValue(0)).toBeCloseTo(0, 6);
    expect(scale.yToValue(100)).toBeCloseTo(10, 6);
  });

  it('respects priceFormat precision when formatting', () => {
    const scale = new PriceScale({ priceFormat: { precision: 3 } });
    scale.setRange(0, 1, 1);
    scale.setHeight(100);
    expect(scale.format(1.23456)).toBe('1.235');
  });

  it('aligns tick steps to minMove', () => {
    const scale = new PriceScale({ priceFormat: { minMove: 0.25 } });
    scale.setRange(0, 2, 1);
    scale.setHeight(100);
    const ticks = scale.getTicks(5);
    const step = ticks[1]! - ticks[0]!;
    const remainder = Math.abs(step / 0.25 - Math.round(step / 0.25));
    expect(remainder).toBeLessThan(1e-6);
  });

  it('converts values for percentage and indexed modes', () => {
    expect(applyPriceScaleMode(110, 'percentage', 100)).toBeCloseTo(0.1, 6);
    expect(applyPriceScaleMode(90, 'percentage', 100)).toBeCloseTo(-0.1, 6);
    expect(applyPriceScaleMode(110, 'indexedTo100', 100)).toBeCloseTo(110, 6);
  });

  it('formats percent values using the base in percentage mode', () => {
    const scale = new PriceScale({ mode: 'percentage', decimals: 2 });
    scale.setRange(-0.2, 0.2, 0.1);
    scale.setHeight(100);
    expect(scale.formatValue(110, 100)).toBe('10.00%');
    expect(scale.formatValue(90, 100)).toBe('-10.00%');
  });

  it('formats indexed values against the base', () => {
    const scale = new PriceScale({ mode: 'indexedTo100', decimals: 1 });
    scale.setRange(80, 120, 80);
    scale.setHeight(100);
    expect(scale.formatValue(110, 100)).toBe('110.0');
  });
});
