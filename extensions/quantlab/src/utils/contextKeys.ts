/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StrategyValidationResult } from '../types/strategy';
import { ViewType } from '../types/views';

export function updateContextKeys(view: ViewType, validation?: StrategyValidationResult | null): void {
	const isStrategy = Boolean(validation?.entrypoint);
	const hasValidationErrors = isStrategy && Boolean(validation?.errors?.length);

	void vscode.commands.executeCommand('setContext', 'quantlab.currentView', view);
	void vscode.commands.executeCommand('setContext', 'quantlab.isStrategy', isStrategy);
	void vscode.commands.executeCommand('setContext', 'quantlab.hasValidationErrors', hasValidationErrors);
}
