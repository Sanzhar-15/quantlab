// Tile compositor shader
// Renders cached tiles from texture atlas to screen

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) tileUV: vec2<f32>,
}

struct TileCompositorUniforms {
  viewportSize: vec2<f32>,
  tileSize: f32,
}

struct TileInstance {
  screenX: f32,
  screenY: f32,
  uvOffset: vec2<f32>,
  uvScale: vec2<f32>,
  opacity: f32,
}

@group(0) @binding(0) var<uniform> uniforms: TileCompositorUniforms;
@group(0) @binding(1) var<storage, read> tiles: array<TileInstance>;
@group(0) @binding(2) var atlasTexture: texture_2d<f32>;
@group(0) @binding(3) var atlasSampler: sampler;

// Quad vertices for tile rendering
const QUAD_VERTICES: array<vec2<f32>, 4> = array<vec2<f32>, 4>(
  vec2<f32>(0.0, 0.0),  // Top-left
  vec2<f32>(1.0, 0.0),  // Top-right
  vec2<f32>(0.0, 1.0),  // Bottom-left
  vec2<f32>(1.0, 1.0),  // Bottom-right
);

const QUAD_INDICES: array<u32, 6> = array<u32, 6>(
  0u, 1u, 2u,
  1u, 3u, 2u,
);

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let tile = tiles[instanceIndex];
  let quadPos = QUAD_VERTICES[vertexIndex];
  
  // Calculate screen position
  let screenX = tile.screenX + quadPos.x * uniforms.tileSize;
  let screenY = tile.screenY + quadPos.y * uniforms.tileSize;
  
  // Convert to clip space
  let clipX = (screenX / uniforms.viewportSize.x) * 2.0 - 1.0;
  let clipY = 1.0 - (screenY / uniforms.viewportSize.y) * 2.0;
  
  // Calculate UV for tile in atlas
  let tileUV = tile.uvOffset + quadPos * tile.uvScale;
  
  return VertexOutput(
    vec4<f32>(clipX, clipY, 0.0, 1.0),
    quadPos,  // Full-screen UV (for debugging)
    tileUV    // Atlas UV
  );
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  // Sample from atlas texture
  let color = textureSample(atlasTexture, atlasSampler, input.tileUV);
  
  // Apply opacity (for fade-in effects or invalid tile indication)
  // Opacity is stored per-instance, but we'll use a uniform for simplicity
  // In a full implementation, this would come from the instance data
  
  return color;
}

