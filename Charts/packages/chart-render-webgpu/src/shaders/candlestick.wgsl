// Candlestick series shader
// Renders OHLC candlesticks using instanced quads for bodies and lines for wicks

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) @builtin(instance_index) instanceIndex: u32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}

struct CandlestickData {
  time: f32,        // Normalized time (0-1)
  open: f32,        // Normalized price (0-1)
  high: f32,        // Normalized price (0-1)
  low: f32,         // Normalized price (0-1)
  close: f32,       // Normalized price (0-1)
  bodyWidth: f32,   // Body width in pixels
  wickWidth: f32,   // Wick width in pixels
  upColor: vec4<f32>,
  downColor: vec4<f32>,
}

struct CameraUniforms {
  viewportSize: vec2<f32>,      // Canvas size in pixels
  plotRect: vec4<f32>,          // x, y, width, height
  timeRange: vec2<f32>,         // from, to (normalized 0-1)
  priceRange: vec2<f32>,        // min, max (normalized 0-1)
  barSpacing: f32,              // Bar spacing in pixels
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<storage, read> candlesticks: array<CandlestickData>;

// Quad vertices for candlestick body: [left-top, right-top, left-bottom, right-bottom]
const QUAD_VERTICES: array<vec2<f32>, 4> = array<vec2<f32>, 4>(
  vec2<f32>(-0.5, -0.5),  // Left-top
  vec2<f32>(0.5, -0.5),   // Right-top
  vec2<f32>(-0.5, 0.5),   // Left-bottom
  vec2<f32>(0.5, 0.5),    // Right-bottom
);

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  let candle = candlesticks[input.instanceIndex];
  let isUp = candle.close >= candle.open;
  let color = select(candle.downColor, candle.upColor, isUp);
  
  // Get quad vertex position
  let quadPos = QUAD_VERTICES[input.position.x < 0.0 ? (input.position.y < 0.0 ? 0u : 2u) : (input.position.y < 0.0 ? 1u : 3u)];
  
  // Calculate body bounds
  let bodyTop = min(candle.open, candle.close);
  let bodyBottom = max(candle.open, candle.close);
  let bodyHeight = bodyBottom - bodyTop;
  
  // Ensure minimum body height
  let minBodyHeight = 0.001;
  if (bodyHeight < minBodyHeight) {
    let mid = (bodyTop + bodyBottom) * 0.5;
    bodyTop = mid - minBodyHeight * 0.5;
    bodyBottom = mid + minBodyHeight * 0.5;
  }
  
  // Transform to screen space
  let timeX = candle.time * (camera.timeRange.y - camera.timeRange.x) + camera.timeRange.x;
  let screenX = camera.plotRect.x + timeX * camera.plotRect.z;
  let screenY = camera.plotRect.y + (1.0 - bodyTop) * camera.plotRect.w;
  
  // Scale quad to body size
  let bodyWidth = candle.bodyWidth;
  let bodyHeightPx = bodyHeight * camera.plotRect.w;
  
  let worldPos = vec2<f32>(
    screenX + quadPos.x * bodyWidth,
    screenY + quadPos.y * bodyHeightPx
  );
  
  // Convert to clip space
  let clipX = (worldPos.x / camera.viewportSize.x) * 2.0 - 1.0;
  let clipY = 1.0 - (worldPos.y / camera.viewportSize.y) * 2.0;
  
  return VertexOutput(
    vec4<f32>(clipX, clipY, 0.0, 1.0),
    color
  );
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
