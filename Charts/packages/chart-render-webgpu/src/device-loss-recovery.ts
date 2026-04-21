/**
 * Device loss recovery with automatic re-initialization.
 */

// GPUDevice is a WebGPU API type, not exported from device-manager

/**
 * Device loss state.
 */
export type DeviceLossState = 'normal' | 'lost' | 'recovering' | 'failed';

/**
 * Device loss recovery manager.
 */
export class DeviceLossRecovery {
  private state: DeviceLossState = 'normal';
  private recoveryAttempts = 0;
  private maxRecoveryAttempts = 3;
  private onRecoveryCallback: (() => Promise<void>) | null = null;
  private onFallbackCallback: (() => void) | null = null;

  /**
   * Set recovery callback (re-initialize device).
   */
  public setRecoveryCallback(callback: () => Promise<void>): void {
    this.onRecoveryCallback = callback;
  }

  /**
   * Set fallback callback (fallback to Canvas2D).
   */
  public setFallbackCallback(callback: () => void): void {
    this.onFallbackCallback = callback;
  }

  /**
   * Handle device loss.
   */
  public async handleDeviceLoss(reason: string): Promise<void> {
    console.warn('WebGPU device lost:', reason);
    this.state = 'lost';
    this.recoveryAttempts = 0;

    // Attempt recovery
    await this.attemptRecovery();
  }

  /**
   * Attempt device recovery.
   */
  private async attemptRecovery(): Promise<void> {
    if (this.recoveryAttempts >= this.maxRecoveryAttempts) {
      console.error('Max recovery attempts reached, falling back to Canvas2D');
      this.state = 'failed';
      if (this.onFallbackCallback) {
        this.onFallbackCallback();
      }
      return;
    }

    this.state = 'recovering';
    this.recoveryAttempts++;

    try {
      if (this.onRecoveryCallback) {
        await this.onRecoveryCallback();
        this.state = 'normal';
        this.recoveryAttempts = 0;
        console.log('Device recovery successful');
      }
    } catch (error) {
      console.error('Device recovery failed:', error);
      // Retry after delay
      setTimeout(() => this.attemptRecovery(), 1000 * this.recoveryAttempts);
    }
  }

  /**
   * Get current state.
   */
  public getState(): DeviceLossState {
    return this.state;
  }

  /**
   * Check if device is operational.
   */
  public isOperational(): boolean {
    return this.state === 'normal';
  }

  /**
   * Reset recovery state.
   */
  public reset(): void {
    this.state = 'normal';
    this.recoveryAttempts = 0;
  }
}

