// Grid shader
// Renders grid lines as a full-screen quad with analytic lines

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

struct GridUniforms {
  viewportSize: vec2<f32>,
  plotRect: vec4<f32>,        // x, y, width, height
  gridColor: vec4<f32>,
  gridSpacing: vec2<f32>,     // Horizontal and vertical grid spacing in pixels
  gridOffset: vec2<f32>,      // Grid offset in pixels
}

@group(0) @binding(0) var<uniform> uniforms: GridUniforms;

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Full-screen quad
  let x = f32((vertexIndex << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vertexIndex & 2u) * 2.0 - 1.0;
  
  return VertexOutput(
    vec4<f32>(x, y, 0.0, 1.0),
    vec2<f32>(x * 0.5 + 0.5, y * 0.5 + 0.5)
  );
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  // Convert UV to screen space
  let screenPos = input.uv * uniforms.viewportSize;
  
  // Check if we're in the plot area
  if (screenPos.x < uniforms.plotRect.x || screenPos.x > uniforms.plotRect.x + uniforms.plotRect.z ||
      screenPos.y < uniforms.plotRect.y || screenPos.y > uniforms.plotRect.y + uniforms.plotRect.w) {
    discard;
  }
  
  // Calculate position relative to plot area
  let plotPos = screenPos - uniforms.plotRect.xy;
  
  // Calculate distance to nearest grid line
  let gridPos = plotPos - uniforms.gridOffset;
  let distX = abs(fract(gridPos.x / uniforms.gridSpacing.x) - 0.5) * uniforms.gridSpacing.x;
  let distY = abs(fract(gridPos.y / uniforms.gridSpacing.y) - 0.5) * uniforms.gridSpacing.y;
  let dist = min(distX, distY);
  
  // Anti-aliased grid line (1 pixel wide)
  let lineWidth = 1.0;
  let alpha = 1.0 - smoothstep(0.0, lineWidth, dist);
  
  return vec4<f32>(uniforms.gridColor.rgb, uniforms.gridColor.a * alpha);
}
