/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type QuantlabNotificationKind = 'info' | 'success' | 'warning' | 'error';

export interface QuantlabNotificationAction {
	id: string;
	label: string;
	command?: string;
	args?: unknown[];
	primary?: boolean;
}

export interface QuantlabNotification {
	id: string;
	kind: QuantlabNotificationKind;
	title: string;
	message?: string;
	actions?: QuantlabNotificationAction[];
	source?: string;
	createdAt: number;
	persistent?: boolean;
}

export interface QuantlabToastPayload {
	id: string;
	kind: QuantlabNotificationKind;
	title: string;
	message?: string;
	actions?: QuantlabNotificationAction[];
	durationMs?: number;
}
