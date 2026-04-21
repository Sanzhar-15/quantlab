/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type TimeoutDomain = 'llm_request' | 'tool_execution' | 'file_io' | 'network' | 'user_interaction';

const DEFAULT_TIMEOUTS: Record<TimeoutDomain, number> = {
	'llm_request': 120_000,
	'tool_execution': 60_000,
	'file_io': 30_000,
	'network': 30_000,
	'user_interaction': Infinity, // INV-A4: No timeout for user interactions
};

export class TimeoutError extends Error {
	public readonly domain: TimeoutDomain;
	public readonly timeoutMs: number;

	constructor(domain: TimeoutDomain, timeoutMs: number) {
		super(`Timeout in domain '${domain}' after ${timeoutMs}ms`);
		this.domain = domain;
		this.timeoutMs = timeoutMs;
		Object.setPrototypeOf(this, TimeoutError.prototype);
	}
}

export class TimeoutManager {
	private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>();

	getDefaultTimeout(domain: TimeoutDomain): number {
		return DEFAULT_TIMEOUTS[domain];
	}

	async withTimeout<T>(
		domain: TimeoutDomain,
		operation: (signal: AbortSignal) => Promise<T>,
		overrideMs?: number,
	): Promise<T> {
		const timeoutMs = overrideMs ?? DEFAULT_TIMEOUTS[domain];

		if (timeoutMs === Infinity) {
			const controller = new AbortController();
			return operation(controller.signal);
		}

		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;

		return Promise.race([
			operation(controller.signal).finally(() => clearTimeout(timer)),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					const err = new TimeoutError(domain, timeoutMs);
					controller.abort(err);
					reject(err);
				}, timeoutMs);
			}),
		]);
	}

	schedule(key: string, timeoutMs: number, callback: () => void): void {
		this.cancel(key);
		if (timeoutMs === Infinity) {
			return;
		}
		const timer = setTimeout(() => {
			this.scheduled.delete(key);
			callback();
		}, timeoutMs);
		this.scheduled.set(key, timer);
	}

	cancel(key: string): void {
		const timer = this.scheduled.get(key);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.scheduled.delete(key);
		}
	}

	cancelAll(): void {
		for (const timer of this.scheduled.values()) {
			clearTimeout(timer);
		}
		this.scheduled.clear();
	}

	dispose(): void {
		this.cancelAll();
	}
}
