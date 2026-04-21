// Crosshair shader
// Renders crosshair lines (vertical and horizontal)

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}

struct CrosshairUniforms {
  viewportSize: vec2<f32>,
  plotRect: vec4<f32>,        // x, y, width, height
  crosshairPos: vec2<f32>,    // x, y in screen space
  color: vec4<f32>,
  lineWidth: f32,
}

@group(0) @binding(0) var<uniform> uniforms: CrosshairUniforms;

// Full-screen quad vertices
const QUAD_VERTICES: array<vec2<f32>, 4> = array<vec2<f32>, 4>(
  vec2<f32>(-1.0, -1.0),
  vec2<f32>(1.0, -1.0),
  vec2<f32>(-1.0, 1.0),
  vec2<f32>(1.0, 1.0),
);

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let pos = QUAD_VERTICES[vertexIndex];
  let screenPos = (pos + 1.0) * 0.5 * uniforms.viewportSize;
  
  // Calculate distance to crosshair lines
  let distX = abs(screenPos.x - uniforms.crosshairPos.x);
  let distY = abs(screenPos.y - uniforms.crosshairPos.y);
  
  // Only render if we're near a crosshair line and in the plot area
  let inPlot = screenPos.x >= uniforms.plotRect.x && screenPos.x <= uniforms.plotRect.x + uniforms.plotRect.z &&
               screenPos.y >= uniforms.plotRect.y && screenPos.y <= uniforms.plotRect.y + uniforms.plotRect.w;
  
  let nearLine = (distX < uniforms.lineWidth * 2.0 && screenPos.y >= uniforms.plotRect.y && screenPos.y <= uniforms.plotRect.y + uniforms.plotRect.w) ||
                 (distY < uniforms.lineWidth * 2.0 && screenPos.x >= uniforms.plotRect.x && screenPos.x <= uniforms.plotRect.x + uniforms.plotRect.z);
  
  // Pass distance for fragment shader
  return VertexOutput(
    vec4<f32>(pos, 0.0, 1.0),
    vec4<f32>(f32(select(0.0, 1.0, inPlot && nearLine)), distX, distY, 0.0)
  );
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (input.color.x < 0.5) {
    discard;
  }
  
  let dist = min(input.color.y, input.color.z);
  let alpha = 1.0 - smoothstep(0.0, uniforms.lineWidth, dist);
  
  return vec4<f32>(uniforms.color.rgb, uniforms.color.a * alpha);
}

