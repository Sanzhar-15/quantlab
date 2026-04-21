/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type VisualizationCommand =
	| { type: 'addPane'; id: string; height?: number }
	| { type: 'addIndicator'; indicator: string; params: Record<string, unknown> }
	| { type: 'removeIndicator'; id: string }
	| { type: 'plotSeries'; series: 'line' | 'histogram' | 'area'; data: Array<{ t: number; v: number }>; options?: Record<string, unknown> }
	| { type: 'markEntries'; entries: Array<{ t: number; label?: string; price?: number }> }
	| { type: 'markExits'; exits: Array<{ t: number; label?: string; price?: number }> }
	| { type: 'setEquityCurve'; equity: Array<{ t: number; v: number }> }
	| { type: 'clear'; target: 'signals' | 'equity' | 'indicators' | 'all' };

export interface VisualizationResult {
	commands: VisualizationCommand[];
	errors: string[];
}
