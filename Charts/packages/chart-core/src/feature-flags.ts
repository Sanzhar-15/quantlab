/**
 * Feature flags and kill switches.
 */

/**
 * Feature flag value.
 */
export type FeatureFlagValue = boolean | string | number;

/**
 * Feature flags configuration.
 */
export interface FeatureFlagsConfig {
  [key: string]: FeatureFlagValue;
}

/**
 * Feature flags manager.
 */
export class FeatureFlagsManager {
  private flags: FeatureFlagsConfig = {};
  private remoteEndpoint: string | null = null;
  private updateInterval: number | null = null;

  /**
   * Set local feature flags.
   */
  public setFlags(flags: FeatureFlagsConfig): void {
    this.flags = { ...this.flags, ...flags };
  }

  /**
   * Get feature flag value.
   */
  public getFlag(key: string, defaultValue: FeatureFlagValue = false): FeatureFlagValue {
    return this.flags[key] ?? defaultValue;
  }

  /**
   * Check if feature is enabled.
   */
  public isEnabled(key: string, defaultValue: boolean = false): boolean {
    const value = this.getFlag(key, defaultValue);
    return value === true || value === 'true' || value === 1;
  }

  /**
   * Enable remote feature flags.
   */
  public enableRemote(endpoint: string, updateIntervalMs: number = 60000): void {
    this.remoteEndpoint = endpoint;
    this.updateInterval = updateIntervalMs;

    // Initial fetch
    this.fetchRemoteFlags();

    // Periodic updates
    if (this.updateInterval > 0) {
      setInterval(() => this.fetchRemoteFlags(), this.updateInterval);
    }
  }

  /**
   * Fetch remote feature flags.
   */
  private async fetchRemoteFlags(): Promise<void> {
    if (!this.remoteEndpoint) {
      return;
    }

    try {
      const response = await fetch(this.remoteEndpoint);
      if (response.ok) {
        const flags = await response.json();
        this.setFlags(flags);
      }
    } catch (error) {
      console.warn('Failed to fetch remote feature flags:', error);
    }
  }

  /**
   * Check kill switch (feature disabled remotely).
   */
  public isKilled(key: string): boolean {
    return this.getFlag(`kill_${key}`, false) === true;
  }

  /**
   * Clear all flags.
   */
  public clear(): void {
    this.flags = {};
  }
}

/**
 * Global feature flags instance.
 */
export const featureFlags = new FeatureFlagsManager();

