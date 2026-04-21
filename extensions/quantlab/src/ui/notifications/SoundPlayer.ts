/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export type QuantlabSoundType = 'fill' | 'alert' | 'complete';

export class SoundPlayer {
	constructor(_context: vscode.ExtensionContext) {
		void _context;
	}

	async play(type: QuantlabSoundType): Promise<void> {
		void type;
		// Webview-based audio playback is wired in the workbench/webview layer.
		// Keep this as a no-op fallback to avoid blocking notifications.
	}
}
