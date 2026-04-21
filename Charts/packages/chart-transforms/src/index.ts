export type DataPoint = { t: number; v: number | null };

type SeriesInput = DataPoint[] | ArrayLike<number | null>;

type TransformOutput<T extends SeriesInput> = T extends DataPoint[] ? DataPoint[] : Float64Array;

type BaseTransformOptions = {
  baseIndex?: number;
  baseValue?: number;
  baseTime?: number;
};

type ZScoreOptions = {
  window?: number;
  ddof?: number;
};

type IndexRebaseOptions = {
  baseTime?: number;
  outputBase?: number;
};

const isFiniteNumber = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isDataPointArray = (input: SeriesInput): input is DataPoint[] => {
  if (!Array.isArray(input)) return false;
  if (input.length === 0) return true;
  const first = input[0] as DataPoint | number | null | undefined;
  return typeof first === 'object' && first !== null && 't' in first && 'v' in first;
};

const resolveBaseValue = (input: SeriesInput, options: BaseTransformOptions): number | null => {
  if (isFiniteNumber(options.baseValue)) {
    return options.baseValue;
  }

  const length = input.length;
  if (length <= 0) return null;

  if (options.baseIndex !== undefined) {
    const idx = Math.max(0, Math.min(length - 1, Math.round(options.baseIndex)));
    const value = isDataPointArray(input) ? input[idx]?.v : input[idx];
    return isFiniteNumber(value) ? value : null;
  }

  if (options.baseTime !== undefined && isDataPointArray(input)) {
    for (let i = 0; i < length; i += 1) {
      const point = input[i]!;
      if (point.t < options.baseTime) continue;
      if (isFiniteNumber(point.v)) return point.v;
    }
    return null;
  }

  for (let i = 0; i < length; i += 1) {
    const value = isDataPointArray(input) ? input[i]!.v : input[i];
    if (isFiniteNumber(value)) return value;
  }
  return null;
};

const mapOutput = <T extends SeriesInput>(
  input: T,
  values: Float64Array,
): TransformOutput<T> => {
  if (!isDataPointArray(input)) return values as TransformOutput<T>;
  const output: DataPoint[] = new Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const point = input[i]!;
    const value = values[i]!;
    output[i] = { t: point.t, v: Number.isFinite(value) ? value : null };
  }
  return output as TransformOutput<T>;
};

export function normalizeToBase100<T extends SeriesInput>(
  input: T,
  options: BaseTransformOptions = {},
): TransformOutput<T> {
  const length = input.length;
  const output = new Float64Array(length);
  const base = resolveBaseValue(input, options);
  if (!isFiniteNumber(base) || base === 0) {
    output.fill(Number.NaN);
    return mapOutput(input, output);
  }

  for (let i = 0; i < length; i += 1) {
    const value = isDataPointArray(input) ? input[i]!.v : input[i];
    output[i] = isFiniteNumber(value) ? (value / base) * 100 : Number.NaN;
  }

  return mapOutput(input, output);
}

export function percentChange<T extends SeriesInput>(
  input: T,
  options: BaseTransformOptions = {},
): TransformOutput<T> {
  const length = input.length;
  const output = new Float64Array(length);
  const base = resolveBaseValue(input, options);
  if (!isFiniteNumber(base) || base === 0) {
    output.fill(Number.NaN);
    return mapOutput(input, output);
  }

  for (let i = 0; i < length; i += 1) {
    const value = isDataPointArray(input) ? input[i]!.v : input[i];
    output[i] = isFiniteNumber(value) ? (value / base - 1) * 100 : Number.NaN;
  }

  return mapOutput(input, output);
}

export function zScore<T extends SeriesInput>(
  input: T,
  options: ZScoreOptions = {},
): TransformOutput<T> {
  const length = input.length;
  const output = new Float64Array(length);
  const window = options.window ? Math.max(2, Math.round(options.window)) : 0;
  const ddof = Math.max(0, Math.round(options.ddof ?? 0));

  if (!window || window >= length) {
    let count = 0;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < length; i += 1) {
      const value = isDataPointArray(input) ? input[i]!.v : input[i];
      if (!isFiniteNumber(value)) continue;
      count += 1;
      sum += value;
      sumSq += value * value;
    }

    if (count <= ddof) {
      output.fill(Number.NaN);
      return mapOutput(input, output);
    }

    const mean = sum / count;
    const variance = (sumSq - (sum * sum) / count) / (count - ddof);
    const safeVariance = variance > 0 ? variance : 0;
    const std = Math.sqrt(safeVariance);

    for (let i = 0; i < length; i += 1) {
      const value = isDataPointArray(input) ? input[i]!.v : input[i];
      if (!isFiniteNumber(value)) {
        output[i] = Number.NaN;
        continue;
      }
      output[i] = std === 0 ? 0 : (value - mean) / std;
    }

    return mapOutput(input, output);
  }

  const buffer = new Float64Array(window);
  const valid = new Uint8Array(window);
  let count = 0;
  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < length; i += 1) {
    const slot = i % window;
    if (valid[slot]) {
      const prev = buffer[slot]!;
      sum -= prev;
      sumSq -= prev * prev;
      count -= 1;
    }

    const value = isDataPointArray(input) ? input[i]!.v : input[i];
    if (isFiniteNumber(value)) {
      buffer[slot] = value;
      valid[slot] = 1;
      sum += value;
      sumSq += value * value;
      count += 1;
    } else {
      buffer[slot] = 0;
      valid[slot] = 0;
    }

    if (!isFiniteNumber(value) || count <= ddof) {
      output[i] = Number.NaN;
      continue;
    }

    const mean = sum / count;
    const variance = (sumSq - (sum * sum) / count) / (count - ddof);
    const safeVariance = variance > 0 ? variance : 0;
    if (safeVariance === 0) {
      output[i] = 0;
      continue;
    }
    output[i] = (value - mean) / Math.sqrt(safeVariance);
  }

  return mapOutput(input, output);
}

export function indexRebase(
  seriesList: DataPoint[][],
  options: IndexRebaseOptions = {},
): DataPoint[][] {
  const outputBase = isFiniteNumber(options.outputBase) ? options.outputBase : 100;
  const baseTime = options.baseTime ?? resolveCommonStart(seriesList);

  return seriesList.map((series) => {
    const baseValue = resolveSeriesBase(series, baseTime);
    const output: DataPoint[] = new Array(series.length);

    if (!isFiniteNumber(baseValue) || baseValue === 0) {
      for (let i = 0; i < series.length; i += 1) {
        const point = series[i]!;
        output[i] = { t: point.t, v: null };
      }
      return output;
    }

    for (let i = 0; i < series.length; i += 1) {
      const point = series[i]!;
      if (point.t < baseTime || !isFiniteNumber(point.v)) {
        output[i] = { t: point.t, v: null };
        continue;
      }
      output[i] = { t: point.t, v: (point.v / baseValue) * outputBase };
    }
    return output;
  });
}

const resolveCommonStart = (seriesList: DataPoint[][]): number => {
  let start = Number.NEGATIVE_INFINITY;
  for (const series of seriesList) {
    for (let i = 0; i < series.length; i += 1) {
      const point = series[i]!;
      if (isFiniteNumber(point.v)) {
        if (point.t > start) start = point.t;
        break;
      }
    }
  }
  return Number.isFinite(start) ? start : 0;
};

const resolveSeriesBase = (series: DataPoint[], baseTime: number): number | null => {
  for (let i = 0; i < series.length; i += 1) {
    const point = series[i]!;
    if (point.t < baseTime) continue;
    if (isFiniteNumber(point.v)) return point.v;
  }
  return null;
};
