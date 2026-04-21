/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { AgentOrchestrator } from './runtime/agentOrchestrator.js';
import type { DegradationManager } from './resilience/degradationManager.js';
import type { TransactionSafeCheckpointManager } from './crashSafe/checkpointManager.js';
import type { Gateway } from './gateway/gateway.js';
import type { UIService } from './canonical/interfaces.js';
import type { QualitySignalService } from './telemetry/qualitySignalService.js';
import type { ConsentStore } from './security/consentStore.js';
import type { HashChainedAuditLogger } from './security/auditLogger.js';
import type { ReplayModeSupport } from './telemetry/replayMode.js';
import type { DataFrameSafety } from './quant/dataframeSafety.js';
import type { HostToWebviewMessage, WebviewToHostMessage } from './ui/messageProtocol.js';

/**
 * OAuth URI handler interface for sign-in flow.
 * Registered globally at activation and accessed via IQicService.
 */
export interface IQicAuthUriHandler {
	onAuthCode(callback: (code: string, state: string) => void): void;
	onError(callback: (error: string) => void): void;
	dispose(): void;
}

export const IQicService = createDecorator<IQicService>('qicService');

export type QicState = 'initializing' | 'ready' | 'degraded' | 'error';

/**
 * Extended UIService interface that includes webview bridge methods.
 * Used by the QicRuntime to allow the ViewPane to wire up message passing.
 */
export interface QicUIBridge extends UIService {
	setPostMessage(fn: (msg: HostToWebviewMessage) => void): void;
	handleWebviewMessage(msg: WebviewToHostMessage): void;
	rejectAllPendingDialogs(): void;
	updateQuota(tokensUsed: number, tokenLimit: number, costUsed: number, costLimit: number, resetAt: string): void;
	updateDegradation(level: number, description: string): void;
	updateStatus(lane: string, model: string, provider: string, region?: string): void;
	sendCheckpointList(checkpoints: Array<{ id: string; createdAt: string; fileCount: number }>): void;
	showFirstRun(): void;
	sendAuditLog(entries: Array<{ timestamp: string; type: string; tool?: string; status?: string; reason?: string }>, chainValid: boolean): void;
	sendMetrics(metrics: { errorRate: number; avgLatencyMs: number; memoryPressure: 'normal' | 'high' | 'critical'; providersAvailable: number; totalProviders: number }): void;
	sendReplayStatus(active: boolean, mode: 'off' | 'strict' | 'best-effort' | 'fallback', recordingCount: number): void;
	sendDataFramePreview(data: { filePath: string; shape: [number, number]; columns: string[]; rows: Array<Record<string, unknown>>; truncated: boolean; format: 'csv' | 'parquet' | 'feather' }): void;
	handlePermissionResponse?(response: Record<string, unknown>): void;
}

export interface QicRuntime {
	orchestrator: AgentOrchestrator;
	uiService: QicUIBridge;
	degradationManager: DegradationManager;
	checkpointManager: TransactionSafeCheckpointManager;
	consentStore: ConsentStore;
	gateway: Gateway;
	qualitySignalService?: QualitySignalService;
	auditLogger?: HashChainedAuditLogger;
	replayMode?: ReplayModeSupport;
	dataframeSafety?: DataFrameSafety;
	providerManager?: { getProviderStatus(provider: string): Promise<{ available: boolean; degraded: boolean; error?: string; needsSetup?: boolean; latencyMs?: number }> };
	changeManager?: { applyChange(changeId: string): Promise<void>; rejectChange(changeId: string): Promise<void>; retryChanges(changeSetId: string): Promise<void>; applyAll(changeSetId: string): Promise<void>; rejectAll(changeSetId: string): Promise<void>; getChange?(changeId: string): unknown; applyChangeWithHash?(changeSetId: string, changeId: string, editScriptHash: string): Promise<void> };
	connectionManager?: { retry(): Promise<void>; reconnect?(): Promise<void> };
}

export interface IQicService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<QicState>;

	isReady(): boolean;
	getState(): QicState;
	getCompletedSteps(): string[];
	getDegradedFeatures(): string[];
	setState(state: QicState): void;
	addCompletedStep(step: string): void;
	addDegradedFeature(feature: string): void;
	setRuntime(runtime: QicRuntime): void;
	getRuntime(): QicRuntime | null;

	/** Set the global OAuth URI handler (registered at activation) */
	setAuthUriHandler(handler: IQicAuthUriHandler): void;
	/** Get the global OAuth URI handler for sign-in flow */
	getAuthUriHandler(): IQicAuthUriHandler | null;
}

/**
 * Core QIC service — manages lifecycle state and feature availability.
 *
 * AUDIT FIX I-4: Supports degraded mode (partial activation).
 * AUDIT FIX XII-AR4: Implements IDisposable via Disposable base class.
 */
export class QicService extends Disposable implements IQicService {
	declare readonly _serviceBrand: undefined;

	private _state: QicState = 'initializing';
	private readonly _completedSteps: string[] = [];
	private readonly _degradedFeatures: string[] = [];
	private _runtime: QicRuntime | null = null;
	private _authUriHandler: IQicAuthUriHandler | null = null;

	private readonly _onDidChangeState = this._register(new Emitter<QicState>());
	readonly onDidChangeState: Event<QicState> = this._onDidChangeState.event;

	isReady(): boolean {
		return this._state === 'ready';
	}

	getState(): QicState {
		return this._state;
	}

	getCompletedSteps(): string[] {
		return [...this._completedSteps];
	}

	getDegradedFeatures(): string[] {
		return [...this._degradedFeatures];
	}

	setState(state: QicState): void {
		if (this._state !== state) {
			this._state = state;
			this._onDidChangeState.fire(state);
		}
	}

	addCompletedStep(step: string): void {
		this._completedSteps.push(step);
	}

	addDegradedFeature(feature: string): void {
		this._degradedFeatures.push(feature);
	}

	setRuntime(runtime: QicRuntime): void {
		this._runtime = runtime;
	}

	getRuntime(): QicRuntime | null {
		return this._runtime;
	}

	setAuthUriHandler(handler: IQicAuthUriHandler): void {
		this._authUriHandler = handler;
	}

	getAuthUriHandler(): IQicAuthUriHandler | null {
		return this._authUriHandler;
	}
}
