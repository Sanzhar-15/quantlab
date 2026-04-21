/**
 * WebGPU device manager with loss recovery and resource management.
 * Handles device initialization, loss recovery, and resource budgets.
 */

export type DeviceTier = 'A' | 'B';

export interface DeviceManagerOptions {
  /** Force a specific tier (for testing) */
  forceTier?: DeviceTier;
  /** Maximum texture size (for resource budgeting) */
  maxTextureSize?: number;
  /** Maximum buffer size (for resource budgeting) */
  maxBufferSize?: number;
}

export interface GPUDeviceInfo {
  device: GPUDevice;
  adapter: GPUAdapter;
  format: GPUTextureFormat;
  limits: GPUSupportedLimits;
  tier: DeviceTier;
}

/**
 * Device manager for WebGPU rendering.
 * Handles device initialization, loss recovery, and resource budgets.
 */
export class DeviceManager {
  private adapter: GPUAdapter | null = null;
  private device: GPUDevice | null = null;
  private format: GPUTextureFormat | null = null;
  private limits: GPUSupportedLimits | null = null;
  private tier: DeviceTier | null = null;
  private destroyed = false;
  private lossCallbacks = new Set<() => void>();

  /**
   * Initialize the device manager.
   * @param options Device manager options.
   * @returns A promise that resolves when initialization is complete.
   */
  public async initialize(options: DeviceManagerOptions = {}): Promise<void> {
    if (this.device) {
      throw new Error('DeviceManager already initialized');
    }

    // Check for WebGPU support
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      throw new Error('WebGPU is not supported in this browser');
    }

    // Request adapter
    const gpu = (navigator as any).gpu;
    if (!gpu) {
      throw new Error('WebGPU is not supported in this browser');
    }
    this.adapter = await gpu.requestAdapter();
    if (!this.adapter) {
      throw new Error('Failed to get WebGPU adapter');
    }

    // Determine tier
    if (options.forceTier) {
      this.tier = options.forceTier;
    } else {
      // Tier A requires SharedArrayBuffer (for worker communication)
      this.tier = typeof SharedArrayBuffer !== 'undefined' ? 'A' : 'B';
    }

    // Request device with loss callback
    await this.requestDevice();

    // Get preferred canvas format
    this.format = gpu.getPreferredCanvasFormat();
  }

  /**
   * Request a new device (used for initialization and loss recovery).
   */
  private async requestDevice(): Promise<void> {
    if (!this.adapter) {
      throw new Error('Adapter not available');
    }

    // Request device
    this.device = await this.adapter.requestDevice({
      requiredFeatures: [],
      requiredLimits: {},
    });

    // Store limits
    this.limits = this.device.limits;

    // Set up loss callback
    this.device.addEventListener('uncapturederror', (event: any) => {
      console.error('WebGPU device lost:', event);
      this.handleDeviceLoss();
    });

    // Monitor for device loss (some browsers don't fire uncapturederror)
    // We'll detect this during rendering if commands fail
  }

  /**
   * Handle device loss and attempt recovery.
   */
  private async handleDeviceLoss(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    console.warn('WebGPU device lost, attempting recovery...');

    // Destroy old device
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }

    // Notify callbacks
    for (const callback of this.lossCallbacks) {
      try {
        callback();
      } catch (error) {
        console.error('Error in device loss callback:', error);
      }
    }

    // Attempt to recover
    try {
      await this.requestDevice();
      console.info('WebGPU device recovered successfully');
    } catch (error) {
      console.error('Failed to recover WebGPU device:', error);
      // Fallback to Canvas2D would happen at a higher level
      throw error;
    }
  }

  /**
   * Get the current device info.
   * @throws If device is not initialized.
   */
  public getDeviceInfo(): GPUDeviceInfo {
    if (!this.device || !this.adapter || !this.format || !this.limits || !this.tier) {
      throw new Error('DeviceManager not initialized');
    }

    return {
      device: this.device,
      adapter: this.adapter,
      format: this.format,
      limits: this.limits,
      tier: this.tier,
    };
  }

  /**
   * Get the device (for direct access when needed).
   * @throws If device is not initialized.
   */
  public getDevice(): GPUDevice {
    if (!this.device) {
      throw new Error('DeviceManager not initialized');
    }
    return this.device;
  }

  /**
   * Get the adapter.
   * @throws If adapter is not initialized.
   */
  public getAdapter(): GPUAdapter {
    if (!this.adapter) {
      throw new Error('DeviceManager not initialized');
    }
    return this.adapter;
  }

  /**
   * Get the preferred canvas format.
   * @throws If format is not initialized.
   */
  public getFormat(): GPUTextureFormat {
    if (!this.format) {
      throw new Error('DeviceManager not initialized');
    }
    return this.format;
  }

  /**
   * Get the device tier.
   * @throws If tier is not initialized.
   */
  public getTier(): DeviceTier {
    if (!this.tier) {
      throw new Error('DeviceManager not initialized');
    }
    return this.tier;
  }

  /**
   * Get the device limits.
   * @throws If limits are not initialized.
   */
  public getLimits(): GPUSupportedLimits {
    if (!this.limits) {
      throw new Error('DeviceManager not initialized');
    }
    return this.limits;
  }

  /**
   * Register a callback to be called when the device is lost.
   * @param callback The callback function.
   * @returns A function to unregister the callback.
   */
  public onDeviceLoss(callback: () => void): () => void {
    this.lossCallbacks.add(callback);
    return () => {
      this.lossCallbacks.delete(callback);
    };
  }

  /**
   * Check if the device is still valid.
   * @returns True if the device is valid, false if it was lost.
   */
  public isDeviceValid(): boolean {
    return this.device !== null && !this.destroyed;
  }

  /**
   * Destroy the device manager and clean up resources.
   */
  public destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    // Destroy device
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }

    // Clear callbacks
    this.lossCallbacks.clear();

    // Clear state
    this.adapter = null;
    this.format = null;
    this.limits = null;
    this.tier = null;
  }
}

