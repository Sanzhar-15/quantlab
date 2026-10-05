/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** A Chart editor's first non-empty render, as reported by its webview (bar count, plot size in CSS pixels). */
export interface ChartDrawnEvent {
	uri: string;
	bars: number;
	width: number;
	height: number;
}

const emitter = new vscode.EventEmitter<ChartDrawnEvent>();

/**
 * Fires once per Chart webview, on the first frame that painted bars. In-process only: no command, setting or
 * contribution. Its one listener is the desktop guest probe, which waits on it before the chart is captured.
 */
export const onChartDrawn: vscode.Event<ChartDrawnEvent> = emitter.event;

export function fireChartDrawn(event: ChartDrawnEvent): void {
	emitter.fire(event);
}
