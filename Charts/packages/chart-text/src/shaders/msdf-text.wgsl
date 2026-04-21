// MSDF text shader
// Renders text using Multi-Channel Signed Distance Fields for crisp rendering at any scale

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) color: vec4<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
}

struct TextUniforms {
  viewportSize: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: TextUniforms;
@group(0) @binding(1) var atlasTexture: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  // Convert position to clip space
  let clipX = (input.position.x / uniforms.viewportSize.x) * 2.0 - 1.0;
  let clipY = 1.0 - (input.position.y / uniforms.viewportSize.y) * 2.0;
  
  return VertexOutput(
    vec4<f32>(clipX, clipY, 0.0, 1.0),
    input.uv,
    input.color
  );
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  // Sample MSDF texture
  let msdf = textureSample(atlasTexture, atlasSampler, input.uv);
  
  // MSDF stores distance in RGB channels
  // We use the median to get the signed distance
  let distance = msdf.r - 0.5; // Convert from [0,1] to [-0.5,0.5]
  
  // Calculate edge coverage using derivatives for anti-aliasing
  let width = length(vec2<f32>(
    dpdx(input.uv.x) * uniforms.viewportSize.x,
    dpdy(input.uv.y) * uniforms.viewportSize.y
  ));
  
  // Smooth step for anti-aliasing
  let alpha = 1.0 - smoothstep(-width * 0.5, width * 0.5, distance);
  
  // Apply color
  return vec4<f32>(input.color.rgb, input.color.a * alpha);
}

