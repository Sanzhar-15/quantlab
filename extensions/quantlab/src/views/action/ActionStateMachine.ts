/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ActionConfigurationState, ActionPromptState, ActionResultsState, ActionRunningState, ActionSelectionState, ActionState, ActionValidationResult } from '../../types/action';

export class ActionStateMachine {
	private readonly states = new Map<string, ActionState>();
	private readonly _onDidChangeState = new vscode.EventEmitter<{ tabId: string; state: ActionState }>();
	readonly onDidChangeState = this._onDidChangeState.event;

	getState(tabId: string): ActionState | undefined {
		return this.states.get(tabId);
	}

	setState(tabId: string, state: ActionState): void {
		const previous = this.states.get(tabId);
		if (previous && JSON.stringify(previous) === JSON.stringify(state)) {
			return;
		}
		this.states.set(tabId, state);
		this._onDidChangeState.fire({ tabId, state });
	}

	toPrompt(tabId: string, state: ActionPromptState): void {
		this.setState(tabId, state);
	}

	toSelection(tabId: string, state: ActionSelectionState): void {
		this.setState(tabId, state);
	}

	toConfiguration(tabId: string, state: ActionConfigurationState): void {
		this.setState(tabId, state);
	}

	toRunning(tabId: string, state: ActionRunningState): void {
		this.setState(tabId, state);
	}

	toResults(tabId: string, state: ActionResultsState): void {
		this.setState(tabId, state);
	}

	validateConfig(values: Record<string, unknown>, required: string[], numberRanges: Record<string, { min?: number; max?: number }>): ActionValidationResult {
		const errors: Record<string, string> = {};
		for (const field of required) {
			if (values[field] === undefined || values[field] === '' || values[field] === null) {
				errors[field] = 'Required';
			}
		}

		for (const [field, range] of Object.entries(numberRanges)) {
			const raw = values[field];
			if (raw === undefined || raw === null || raw === '') {
				continue;
			}
			const numeric = Number(raw);
			if (Number.isNaN(numeric)) {
				errors[field] = 'Must be a number';
				continue;
			}

			const hasMin = range.min !== undefined;
			const hasMax = range.max !== undefined;
			const belowMin = hasMin && numeric < range.min!;
			const aboveMax = hasMax && numeric > range.max!;

			if (belowMin && aboveMax) {
				// Both violations (shouldn't happen but handle it)
				errors[field] = `Must be between ${range.min} and ${range.max}`;
			} else if (belowMin) {
				errors[field] = hasMax ? `Must be between ${range.min} and ${range.max}` : `Must be at least ${range.min}`;
			} else if (aboveMax) {
				errors[field] = hasMin ? `Must be between ${range.min} and ${range.max}` : `Must be at most ${range.max}`;
			}
		}

		return { isValid: Object.keys(errors).length === 0, errors };
	}
}
