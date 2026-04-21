/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitOpenError extends Error {
	constructor(message?: string) {
		super(message ?? 'Circuit breaker is open');
		Object.setPrototypeOf(this, CircuitOpenError.prototype);
	}
}

export interface CircuitBreakerConfig {
	failureThreshold: number;
	resetTimeoutMs: number;
	halfOpenMaxAttempts: number;
	slowCallThreshold: number;
	slowCallRateThreshold: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
	failureThreshold: 5,
	resetTimeoutMs: 60_000,
	halfOpenMaxAttempts: 1,
	slowCallThreshold: 5_000,
	slowCallRateThreshold: 0.5,
};

/**
 * Per-provider circuit breaker with slow-call tracking (Audit VII-DS10).
 */
export class CircuitBreaker {
	private state: CircuitState = 'closed';
	private failureCount = 0;
	private lastFailureTime = 0;
	private halfOpenAttempts = 0;
	private readonly slowCalls: number[] = [];
	private readonly allCalls: number[] = [];
	private readonly config: CircuitBreakerConfig;
	private readonly stateChangeListeners: Array<(state: CircuitState) => void> = [];

	constructor(config?: Partial<CircuitBreakerConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Register a listener for circuit state changes.
	 */
	onStateChange(listener: (state: CircuitState) => void): { dispose(): void } {
		this.stateChangeListeners.push(listener);
		return {
			dispose: () => {
				const idx = this.stateChangeListeners.indexOf(listener);
				if (idx >= 0) { this.stateChangeListeners.splice(idx, 1); }
			},
		};
	}

	private emitStateChange(newState: CircuitState): void {
		for (const listener of this.stateChangeListeners) {
			listener(newState);
		}
	}

	async execute<T>(operation: () => Promise<T>): Promise<T> {
		if (this.state === 'open') {
			if (Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs) {
				this.state = 'half-open';
				this.halfOpenAttempts = 0;
				this.emitStateChange('half-open');
			} else {
				throw new CircuitOpenError();
			}
		}

		if (this.state === 'half-open' && this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
			throw new CircuitOpenError('Half-open max attempts reached');
		}

		// Prune old entries outside the window to prevent memory leak
		this.pruneOldEntries();

		const startTime = Date.now();
		this.allCalls.push(startTime);

		try {
			const result = await operation();
			const duration = Date.now() - startTime;

			// Track slow calls (Audit VII-DS10)
			if (duration > this.config.slowCallThreshold) {
				this.slowCalls.push(Date.now());
			}

			this.onSuccess();
			return result;
		} catch (error) {
			const duration = Date.now() - startTime;

			if (duration > this.config.slowCallThreshold) {
				this.slowCalls.push(Date.now());
			}

			this.onFailure();
			throw error;
		}
	}

	getState(): CircuitState {
		return this.state;
	}

	getFailureCount(): number {
		return this.failureCount;
	}

	/**
	 * Pre-check circuit state for callers that manage execution externally (e.g., streaming).
	 * Mirrors the guard in execute(): transitions open→half-open if timeout elapsed,
	 * throws CircuitOpenError if circuit is open or half-open max attempts reached.
	 */
	checkCanExecute(): void {
		if (this.state === 'open') {
			if (Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs) {
				this.state = 'half-open';
				this.halfOpenAttempts = 0;
				this.emitStateChange('half-open');
			} else {
				throw new CircuitOpenError();
			}
		}

		if (this.state === 'half-open' && this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
			throw new CircuitOpenError('Half-open max attempts reached');
		}

		this.pruneOldEntries();
	}

	/**
	 * Record a successful outcome for callers managing execution externally
	 * (e.g., streaming where chunks are yielded incrementally).
	 */
	recordSuccess(): void {
		this.onSuccess();
	}

	/**
	 * Record a failed outcome for callers managing execution externally.
	 */
	recordFailure(): void {
		this.onFailure();
	}

	reset(): void {
		const wasOpen = this.state !== 'closed';
		this.state = 'closed';
		this.failureCount = 0;
		this.lastFailureTime = 0;
		this.halfOpenAttempts = 0;
		this.slowCalls.length = 0;
		this.allCalls.length = 0;
		if (wasOpen) {
			this.emitStateChange('closed');
		}
	}

	private onSuccess(): void {
		if (this.state === 'half-open') {
			this.state = 'closed';
			this.failureCount = 0;
			this.halfOpenAttempts = 0;
			this.emitStateChange('closed');
		} else if (this.state === 'closed') {
			this.failureCount = Math.max(0, this.failureCount - 1);
		}
	}

	private onFailure(): void {
		this.failureCount++;
		this.lastFailureTime = Date.now();

		if (this.state === 'half-open') {
			this.halfOpenAttempts++;
			this.state = 'open';
			this.emitStateChange('open');
			return;
		}

		if (this.shouldOpen()) {
			this.state = 'open';
			this.emitStateChange('open');
		}
	}

	private shouldOpen(): boolean {
		if (this.failureCount >= this.config.failureThreshold) {
			return true;
		}

		// Check slow call rate
		const slowRate = this.getRecentSlowCallRate();
		if (slowRate > this.config.slowCallRateThreshold) {
			return true;
		}

		return false;
	}

	private getRecentSlowCallRate(): number {
		const windowMs = this.config.resetTimeoutMs;
		const now = Date.now();
		const recentSlow = this.slowCalls.filter(t => now - t < windowMs).length;
		const recentAll = this.allCalls.filter(t => now - t < windowMs).length;

		if (recentAll === 0) { return 0; }
		return recentSlow / recentAll;
	}

	/**
	 * Prune entries older than the tracking window to prevent unbounded memory growth.
	 */
	private pruneOldEntries(): void {
		const cutoff = Date.now() - this.config.resetTimeoutMs;
		while (this.slowCalls.length > 0 && this.slowCalls[0] < cutoff) {
			this.slowCalls.shift();
		}
		while (this.allCalls.length > 0 && this.allCalls[0] < cutoff) {
			this.allCalls.shift();
		}
	}
}
