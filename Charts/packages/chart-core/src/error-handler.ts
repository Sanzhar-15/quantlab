/**
 * Error handling with scopes and user-friendly messages.
 */

/**
 * Error scope for capturing errors.
 */
export class ErrorScope {
  private errors: Error[] = [];
  private onError: ((error: Error) => void) | undefined;

  public constructor(onError?: (error: Error) => void) {
    this.onError = onError;
  }

  /**
   * Execute function in error scope.
   */
  public async execute<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.errors.push(err);
      if (this.onError) {
        this.onError(err);
      } else {
        console.error('Error in scope:', err);
      }
      return null;
    }
  }

  /**
   * Execute synchronous function in error scope.
   */
  public executeSync<T>(fn: () => T): T | null {
    try {
      return fn();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.errors.push(err);
      if (this.onError) {
        this.onError(err);
      } else {
        console.error('Error in scope:', err);
      }
      return null;
    }
  }

  /**
   * Get captured errors.
   */
  public getErrors(): Error[] {
    return [...this.errors];
  }

  /**
   * Clear errors.
   */
  public clear(): void {
    this.errors = [];
  }

  /**
   * Check if any errors occurred.
   */
  public hasErrors(): boolean {
    return this.errors.length > 0;
  }
}

/**
 * Global error handler.
 */
export class GlobalErrorHandler {
  private telemetryEnabled = false;
  private telemetryEndpoint: string | null = null;
  private telemetryConsented = false;  // NEW-CH-008: Explicit consent flag
  private userMessageCallback: ((message: string) => void) | null = null;

  /**
   * Enable telemetry with explicit consent verification.
   * NEW-CH-008: Telemetry requires explicit user consent before activation.
   *
   * @param endpoint - Telemetry endpoint URL
   * @param options - Must include userConsented: true to enable
   */
  public enableTelemetry(endpoint: string, options?: { userConsented: boolean }): void {
    if (!options?.userConsented) {
      console.warn(
        'Telemetry not enabled: explicit user consent required. ' +
        'Call enableTelemetry(endpoint, { userConsented: true }) after obtaining consent.'
      );
      return;
    }

    this.telemetryEnabled = true;
    this.telemetryConsented = true;
    this.telemetryEndpoint = endpoint;
  }

  /**
   * Disable telemetry and clear consent.
   */
  public disableTelemetry(): void {
    this.telemetryEnabled = false;
    this.telemetryConsented = false;
    this.telemetryEndpoint = null;
  }

  /**
   * Set user message callback.
   */
  public setUserMessageCallback(callback: (message: string) => void): void {
    this.userMessageCallback = callback;
  }

  /**
   * Handle error.
   */
  public handleError(error: Error, context?: string): void {
    // Log error
    console.error(`Chart error${context ? ` in ${context}` : ''}:`, error);

    // Send to telemetry if enabled
    if (this.telemetryEnabled && this.telemetryEndpoint) {
      this.sendToTelemetry(error, context);
    }

    // Show user-friendly message
    const userMessage = this.getUserFriendlyMessage(error);
    if (this.userMessageCallback) {
      this.userMessageCallback(userMessage);
    }
  }

  /**
   * Get user-friendly error message.
   */
  private getUserFriendlyMessage(error: Error): string {
    const message = error.message.toLowerCase();

    if (message.includes('webgpu') || message.includes('gpu')) {
      return 'Graphics acceleration is not available. The chart will use a fallback rendering mode.';
    }

    if (message.includes('memory') || message.includes('out of memory')) {
      return 'Insufficient memory. Try reducing the amount of data displayed.';
    }

    if (message.includes('network') || message.includes('fetch')) {
      return 'Network error. Please check your connection and try again.';
    }

    return 'An error occurred. Please try refreshing the page.';
  }

  /**
   * Send error to telemetry.
   * NEW-CH-008: Double-checks consent before sending. Excludes userAgent.
   */
  private async sendToTelemetry(error: Error, context?: string): Promise<void> {
    // NEW-CH-008: Verify consent before sending any data
    if (!this.telemetryEndpoint || !this.telemetryConsented) {
      return;
    }

    try {
      await fetch(this.telemetryEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: error.message,
          // NEW-CH-008: Stack traces included but userAgent removed for privacy
          stack: error.stack,
          context,
          timestamp: Date.now(),
        }),
      });
    } catch (telemetryError) {
      // Silently fail telemetry
      console.warn('Failed to send error to telemetry:', telemetryError);
    }
  }
}

/**
 * Global error handler instance.
 */
export const globalErrorHandler = new GlobalErrorHandler();

