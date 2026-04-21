/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type QuantlabErrorSource = 'chart' | 'action' | 'trade' | 'engine' | 'global';
export type QuantlabErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface QuantlabRecoveryAction {
	id: string;
	label: string;
	command?: string;
	args?: unknown[];
	primary?: boolean;
}

export interface QuantlabError {
	id: string;
	source: QuantlabErrorSource;
	code: string;
	message: string;
	detail?: string;
	severity: QuantlabErrorSeverity;
	context?: Record<string, unknown>;
	createdAt: number;
	actions?: QuantlabRecoveryAction[];
}
