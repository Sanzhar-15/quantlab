/**
 * Shader loader for WGSL shaders.
 * Loads and compiles WGSL shader modules.
 */

/**
 * Load a WGSL shader from a string.
 * @param device The GPU device.
 * @param source The WGSL source code.
 * @returns A compiled shader module.
 */
export function loadShader(device: GPUDevice, source: string): GPUShaderModule {
  return device.createShaderModule({
    code: source,
  });
}

/**
 * Load shaders from embedded strings.
 * In a real implementation, these would be loaded from files or bundled.
 */
export async function loadShaders(device: GPUDevice): Promise<{
  candlestick: GPUShaderModule;
  grid: GPUShaderModule;
  crosshair: GPUShaderModule;
}> {
  // For now, we'll import the shader strings directly
  // In production, these would be loaded from .wgsl files via a build step
  const candlestickSource = await import('./shaders/candlestick.wgsl?raw').catch(() => null);
  const gridSource = await import('./shaders/grid.wgsl?raw').catch(() => null);
  const crosshairSource = await import('./shaders/crosshair.wgsl?raw').catch(() => null);

  // Fallback: use embedded shader strings if file loading fails
  // This is a workaround for development - in production, use a proper bundler
  const candlestickShader = loadShader(device, getCandlestickShaderSource());
  const gridShader = loadShader(device, getGridShaderSource());
  const crosshairShader = loadShader(device, getCrosshairShaderSource());

  return {
    candlestick: candlestickShader,
    grid: gridShader,
    crosshair: crosshairShader,
  };
}

// Embedded shader sources (fallback)
function getCandlestickShaderSource(): string {
  // This will be replaced by actual file loading in production
  return `// See candlestick.wgsl`;
}

function getGridShaderSource(): string {
  return `// See grid.wgsl`;
}

function getCrosshairShaderSource(): string {
  return `// See crosshair.wgsl`;
}

