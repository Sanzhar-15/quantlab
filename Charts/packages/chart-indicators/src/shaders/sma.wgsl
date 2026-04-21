// SMA (Simple Moving Average) GPU Compute Shader

struct SMAUniforms {
  period: u32,
  dataLength: u32,
  startIdx: u32,
  endIdx: u32,
}

@group(0) @binding(0) var<uniform> uniforms: SMAUniforms;
@group(0) @binding(1) var<storage, read> prices: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;

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

  // Compute sum of period values
  var sum: f32 = 0.0;
  var count: u32 = 0;

  let periodStart = select(0u, i - uniforms.period + 1u, i >= uniforms.period);
  for (var j = periodStart; j <= i; j++) {
    let p = prices[j];
    if (isFinite(p)) {
      sum += p;
      count++;
    }
  }

  if (count >= uniforms.period) {
    output[i] = sum / f32(uniforms.period);
  } else {
    output[i] = 0.0 / 0.0; // NaN
  }
}

