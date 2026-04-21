/**
 * createChart factory function.
 */

import type { ChartOptions, ChartApi } from './types';
import { Chart } from './chart';

/**
 * Create a new chart instance.
 * Returns a promise that resolves when the chart is fully initialized.
 */
export async function createChart(container: HTMLElement | string, options?: Partial<ChartOptions>): Promise<ChartApi> {
  // Resolve container
  let containerElement: HTMLElement;
  if (typeof container === 'string') {
    const element = document.querySelector(container);
    if (!element || !(element instanceof HTMLElement)) {
      throw new Error(`Container selector "${container}" not found or not an HTMLElement`);
    }
    containerElement = element;
  } else {
    containerElement = container;
  }

  // Merge options
  const mergedOptions: ChartOptions = {
    container: containerElement,
    autoSize: options?.autoSize ?? true,
    ...(options?.width !== undefined && { width: options.width }),
    ...(options?.height !== undefined && { height: options.height }),
    ...(options?.theme !== undefined && { theme: options.theme }),
    ...(options?.timeFormatter !== undefined && { timeFormatter: options.timeFormatter }),
    ...(options?.gapThresholdMs !== undefined && { gapThresholdMs: options.gapThresholdMs }),
    ...(options?.rawRetentionMs !== undefined && { rawRetentionMs: options.rawRetentionMs }),
  };

  // Create chart instance
  const chart = new Chart(containerElement, mergedOptions);
  
  // Wait for initialization
  await chart.waitForInit();
  
  return chart;
}

