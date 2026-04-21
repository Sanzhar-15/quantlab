/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DegradationLevel } from '../common/resilience/degradationManager.js';
import type { ConnectionMode } from '../common/constants.js';

export type QicState = 'ready' | 'processing' | 'degraded' | 'error';

interface StatusBarInfo {
	state: QicState;
	connectionMode: ConnectionMode;
	modelName: string;
	tokenUsage: number;
	degradationLevel: DegradationLevel;
}

/**
 * QIC status bar contribution (Prompt 13).
 * Shows QIC state, connection mode, current model, and degradation level.
 * Click opens the QIC panel.
 */
export class QicStatusBarContribution {

	private _state: QicState = 'ready';
	private _connectionMode: ConnectionMode = 'cloud';
	private _modelName = 'claude-latest';
	private _tokenUsage = 0;
	private _degradationLevel: DegradationLevel = 0;
	private _onDidChange: ((info: StatusBarInfo) => void) | null = null;

	get state(): QicState { return this._state; }
	get connectionMode(): ConnectionMode { return this._connectionMode; }
	get modelName(): string { return this._modelName; }
	get tokenUsage(): number { return this._tokenUsage; }
	get degradationLevel(): DegradationLevel { return this._degradationLevel; }

	onDidChange(listener: (info: StatusBarInfo) => void): void {
		this._onDidChange = listener;
	}

	setState(state: QicState): void {
		this._state = state;
		this.notify();
	}

	setConnectionMode(mode: ConnectionMode): void {
		this._connectionMode = mode;
		this.notify();
	}

	setModelName(name: string): void {
		this._modelName = name;
		this.notify();
	}

	setTokenUsage(tokens: number): void {
		this._tokenUsage = tokens;
		this.notify();
	}

	updateFromDegradation(level: DegradationLevel): void {
		this._degradationLevel = level;
		// DegradationLevel: 0=Normal, 1=ReducedQuality, 2=NoCompletions, 3=LocalOnly, 4=Emergency
		if (level >= 3) {
			this._state = 'error';
		} else if (level >= 1) {
			this._state = 'degraded';
		} else {
			this._state = 'ready';
		}
		this.notify();
	}

	getDisplayText(): string {
		const modeIcon = this.getModeIcon();
		const stateText = this.getStateText();
		return `$(sparkle) Orion ${modeIcon} ${stateText}`;
	}

	getTooltipText(): string {
		const degradationText = this._degradationLevel > 0
			? `\nDegradation: Level ${this._degradationLevel}`
			: '';
		return `Orion: ${this.getStateText()}\nMode: ${this.getModeName()}\nModel: ${this._modelName}\nTokens: ${this._tokenUsage.toLocaleString()}${degradationText}`;
	}

	private getModeIcon(): string {
		switch (this._connectionMode) {
			case 'server': return '$(remote)';
			case 'cloud': return '$(cloud)';
			case 'byok': return '$(key)';
			case 'local': return '$(server)';
		}
	}

	private getModeName(): string {
		switch (this._connectionMode) {
			case 'server': return 'Delta Plus Server';
			case 'cloud': return 'Quantlab Cloud';
			case 'byok': return 'Bring Your Own Key';
			case 'local': return 'Local (Ollama)';
		}
	}

	private getStateText(): string {
		switch (this._state) {
			case 'ready': return 'Ready';
			case 'processing': return 'Processing...';
			case 'degraded': return 'Degraded';
			case 'error': return 'Error';
		}
	}

	private notify(): void {
		this._onDidChange?.({
			state: this._state,
			connectionMode: this._connectionMode,
			modelName: this._modelName,
			tokenUsage: this._tokenUsage,
			degradationLevel: this._degradationLevel,
		});
	}
}
