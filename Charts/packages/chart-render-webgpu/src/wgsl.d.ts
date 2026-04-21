/**
 * Type declarations for WGSL shader imports.
 * These are used by bundlers like Vite that support ?raw imports.
 */

declare module '*.wgsl?raw' {
  const content: { default: string };
  export default content;
}

