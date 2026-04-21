// RSI (Relative Strength Index) GPU Compute Shader

struct RSIUniforms {
  period: u32,
  dataLength: u32,
  startIdx: u32,
  endIdx: u32,
}

@group(0) @binding(0) var<uniform> uniforms: RSIUniforms;
@group(0) @binding(1) var<storage, read> prices: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let idx = globalId.x;
  if (idx >= uniforms.dataLength) {
    return;
  }

  let i = uniforms.startIdx + idx;
  if (i > uniforms.endIdx || i < 1u) {
    return;
  }

  let currentPrice = prices[i];
  let prevPrice = prices[i - 1u];

  if (!isFinite(currentPrice) || !isFinite(prevPrice)) {
    output[i] = 0.0 / 0.0; // NaN
    return;
  }

  let change = currentPrice - prevPrice;
  let gain = select(0.0, change, change > 0.0);
  let loss = select(0.0, -change, change < 0.0);

  // For RSI, we need to compute average gain/loss over period
  // This is simplified - full implementation would use Wilder's smoothing
  if (i < uniforms.period + 1u) {
    output[i] = 0.0 / 0.0; // NaN (not enough data)
    return;
  }

  // Compute average gain and loss over period
  var avgGain: f32 = 0.0;
  var avgLoss: f32 = 0.0;
  var gainCount: u32 = 0;
  var lossCount: u32 = 0;

  for (var j = i - uniforms.period + 1u; j <= i; j++) {
    if (j < 1u) continue;
    let p = prices[j];
    let prev = prices[j - 1u];
    if (isFinite(p) && isFinite(prev)) {
      let ch = p - prev;
      if (ch > 0.0) {
        avgGain += ch;
        gainCount++;
      } else if (ch < 0.0) {
        avgLoss += -ch;
        lossCount++;
      }
    }
  }

  if (gainCount > 0u) avgGain /= f32(gainCount);
  if (lossCount > 0u) avgLoss /= f32(lossCount);

  if (avgLoss == 0.0) {
    output[i] = 100.0;
  } else {
    let rs = avgGain / avgLoss;
    output[i] = 100.0 - (100.0 / (1.0 + rs));
  }
}

