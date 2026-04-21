/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sha256Hex } from '../qicCrypto.js';
import type { ConsentStore } from '../security/consentStore.js';
import type { EgressBoundaryEnforcer } from '../security/egressEnforcer.js';
import type { DataTier } from '../constants.js';

export type TelemetryCategory = 'performance' | 'errors' | 'usage' | 'quality';

export interface TelemetryEvent {
	name: string;
	properties?: Record<string, string | number | boolean>;
	measurements?: Record<string, number>;
	containsCodeContent?: boolean;
}

// Sampling rates per category
const SAMPLING_RATES: Record<TelemetryCategory, number> = {
	performance: 0.1,  // 10%
	errors: 1.0,       // 100%
	usage: 0.01,       // 1%
	quality: 0.1,      // 10%
};

/**
 * Privacy-respecting opt-in telemetry service.
 *
 * Privacy requirements:
 * - No user identifiers
 * - No file contents
 * - No file paths (hash only)
 * - No secrets
 * - All data goes through EgressBoundaryEnforcer (INV-T3)
 */
export class TelemetryService {

	private readonly buffer: Array<{ category: TelemetryCategory; event: TelemetryEvent; timestamp: string }> = [];
	private readonly MAX_BUFFER_SIZE = 50;
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private _dataTier: DataTier = 'private';

	// Cloud transport (set after cloud adapter is ready)
	private _cloudBaseUrl: string | null = null;
	private _getAccessToken: (() => string) | null = null;

	constructor(
		private readonly consentStore: ConsentStore,
		private readonly egressEnforcer: EgressBoundaryEnforcer,
	) {}

	/**
	 * Set cloud transport for uploading telemetry to the server.
	 * Call after cloud adapter is constructed.
	 */
	setCloudTransport(baseUrl: string, getAccessToken: () => string): void {
		this._cloudBaseUrl = baseUrl;
		this._getAccessToken = getAccessToken;
	}

	/**
	 * Update the data tier. Called when the user changes qic.dataTier setting.
	 * Also handles backwards compatibility: if legacy TELEMETRY_ENABLED is true
	 * and dataTier is not explicitly set, treat as 'anonymous-metrics'.
	 */
	setDataTier(tier: DataTier): void {
		this._dataTier = tier;
	}

	get dataTier(): DataTier {
		return this._dataTier;
	}

	/**
	 * Log a telemetry event (only if DataTier permits).
	 */
	async logEvent(category: TelemetryCategory, event: TelemetryEvent): Promise<void> {
		// DataTier-based filtering (replaces boolean TELEMETRY_ENABLED)
		if (this._dataTier === 'private') {
			return;
		}
		if (this._dataTier === 'anonymous-metrics' && event.containsCodeContent) {
			return; // Metadata only — no code content
		}
		// 'data-contributor': send everything

		// Check consent (redundant with DataTier sync, but defense-in-depth)
		const hasConsent = await this.consentStore.hasConsent('telemetry');
		if (!hasConsent) {
			return;
		}

		// Apply sampling
		if (Math.random() > SAMPLING_RATES[category]) {
			return;
		}

		// Sanitize event — strip any PII
		const sanitized = this.sanitizeEvent(event);

		this.buffer.push({
			category,
			event: sanitized,
			timestamp: new Date().toISOString(),
		});

		// Auto-flush when buffer is full
		if (this.buffer.length >= this.MAX_BUFFER_SIZE) {
			await this.flush();
		}
	}

	/**
	 * Flush buffered telemetry events through egress enforcer and cloud transport.
	 */
	async flush(): Promise<void> {
		if (this.buffer.length === 0) {
			return;
		}

		const events = this.buffer.splice(0, this.buffer.length);
		const payload = JSON.stringify(events);

		await this.egressEnforcer.checkAndSanitize('telemetry', payload, {
			sessionId: 'telemetry',
			purpose: 'telemetry_flush',
		});

		// Upload to cloud if transport is configured
		if (this._cloudBaseUrl && this._getAccessToken) {
			try {
				const specEvents = events.map(e => ({
					type: e.event.name,
					timestamp: e.timestamp,
					data: {
						category: e.category,
						...e.event.properties,
						...e.event.measurements,
					},
				}));
				await fetch(`${this._cloudBaseUrl}/v1/telemetry/interaction`, {
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${this._getAccessToken()}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ events: specEvents }),
					signal: AbortSignal.timeout(10_000),
				});
			} catch {
				// Fire-and-forget: re-buffer events on failure (up to max)
				const toRestore = events.slice(0, this.MAX_BUFFER_SIZE - this.buffer.length);
				this.buffer.unshift(...toRestore);
			}
		}
	}

	/**
	 * Start periodic flushing.
	 */
	startPeriodicFlush(intervalMs: number = 30_000): void {
		this.stopPeriodicFlush();
		this.flushTimer = setInterval(() => {
			void this.flush();
		}, intervalMs);
	}

	/**
	 * Stop periodic flushing.
	 */
	stopPeriodicFlush(): void {
		if (this.flushTimer !== null) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
	}

	/**
	 * Hash a file path for telemetry (no raw paths).
	 */
	static hashPath(filePath: string): string {
		return sha256Hex(filePath).slice(0, 16);
	}

	/**
	 * Sanitize event properties — remove anything that looks like PII or secrets.
	 */
	private sanitizeEvent(event: TelemetryEvent): TelemetryEvent {
		const sanitizedProps: Record<string, string | number | boolean> = {};

		if (event.properties) {
			for (const [key, value] of Object.entries(event.properties)) {
				if (typeof value === 'string') {
					// Hash anything that looks like a file path
					if (value.includes('/') || value.includes('\\')) {
						sanitizedProps[key] = TelemetryService.hashPath(value);
					} else if (value.length > 200) {
						// Truncate long strings
						sanitizedProps[key] = value.slice(0, 200);
					} else {
						sanitizedProps[key] = value;
					}
				} else {
					sanitizedProps[key] = value;
				}
			}
		}

		return {
			name: event.name,
			properties: Object.keys(sanitizedProps).length > 0 ? sanitizedProps : undefined,
			measurements: event.measurements,
		};
	}
}
