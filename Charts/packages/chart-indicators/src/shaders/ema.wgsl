// EMA (Exponential Moving Average) GPU Compute Shader

struct EMAUniforms {
  period: f32,
  multiplier: f32,
  dataLength: u32,
  startIdx: u32,
  endIdx: u32,
  _padding: u32,
}

@group(0) @binding(0) var<uniform> uniforms: EMAUniforms;
@group(0) @binding(1) var<storage, read> prices: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;
@group(0) @binding(3) var<storage, read_write> state: array<f32>; // Last EMA value

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let idx = globalId.x;
  if (idx >= uniforms.dataLength) {
    return;
  }

  let i = uniforms.startIdx + idx;
  if (i > uniforms.endIdx) {
    return;
  }

  let price = prices[i];
  if (!isFinite(price)) {
    output[i] = 0.0 / 0.0; // NaN
    return;
  }

  var ema: f32;
  
  if (idx == 0) {
    // First value: use state if available, otherwise initialize with SMA
    if (state[0] != 0.0 / 0.0 && isFinite(state[0])) {
      ema = state[0];
    } else {
      // Initialize with SMA of first period values
      var sum: f32 = 0.0;
      var count: u32 = 0;
      let periodStart = select(0u, i - uniforms.period + 1u, i >= uniforms.period);
      for (var j = periodStart; j < i; j++) {
        let p = prices[j];
        if (isFinite(p)) {
          sum += p;
          count++;
        }
      }
      if (count > 0u) {
        ema = sum / f32(count);
      } else {
        ema = price;
      }
    }
  } else {
    // Use previous EMA value
    ema = output[i - 1u];
    if (!isFinite(ema)) {
      ema = price;
    }
  }

  // EMA formula: EMA = (Price - EMA_prev) * multiplier + EMA_prev
  ema = (price - ema) * uniforms.multiplier + ema;
  output[i] = ema;

  // Update state for next computation
  if (idx == uniforms.dataLength - 1u) {
    state[0] = ema;
  }
}

