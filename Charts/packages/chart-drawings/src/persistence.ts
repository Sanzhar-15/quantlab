/**
 * Local persistence for drawings (localStorage).
 */

import type { Drawing } from './types';

/**
 * Persistence manager.
 */
export class DrawingPersistence {
  private storageKey: string;

  public constructor(chartId: string = 'default') {
    this.storageKey = `charts-plus-drawings-${chartId}`;
  }

  /**
   * Save drawings to localStorage.
   */
  public save(drawings: Drawing[]): void {
    try {
      const serialized = JSON.stringify(drawings, this.replacer);
      localStorage.setItem(this.storageKey, serialized);
    } catch (error) {
      console.error('Failed to save drawings:', error);
    }
  }

  /**
   * Load drawings from localStorage.
   */
  public load(): Drawing[] {
    try {
      const serialized = localStorage.getItem(this.storageKey);
      if (!serialized) {
        return [];
      }
      return JSON.parse(serialized, this.reviver);
    } catch (error) {
      console.error('Failed to load drawings:', error);
      return [];
    }
  }

  /**
   * Clear saved drawings.
   */
  public clear(): void {
    try {
      localStorage.removeItem(this.storageKey);
    } catch (error) {
      console.error('Failed to clear drawings:', error);
    }
  }

  /**
   * JSON replacer for serialization.
   */
  private replacer(key: string, value: any): any {
    // Handle ArrayBuffer (for brush paths)
    if (value instanceof ArrayBuffer) {
      // Convert to base64
      const bytes = new Uint8Array(value);
      const binary = String.fromCharCode(...bytes);
      return {
        __type: 'ArrayBuffer',
        __data: btoa(binary),
      };
    }
    return value;
  }

  /**
   * JSON reviver for deserialization.
   */
  private reviver(key: string, value: any): any {
    // Handle ArrayBuffer (for brush paths)
    if (value && value.__type === 'ArrayBuffer') {
      const binary = atob(value.__data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes.buffer;
    }
    return value;
  }
}

