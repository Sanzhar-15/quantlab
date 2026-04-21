/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export type ReducedMotionMode = 'auto' | 'always' | 'never';

export class ReducedMotion {
	private static instance: ReducedMotion | undefined;

	private mode: ReducedMotionMode;
	private readonly _onDidChange = new vscode.EventEmitter<ReducedMotionMode>();
	readonly onDidChange = this._onDidChange.event;

	private constructor(context: vscode.ExtensionContext) {
		this.mode = this.readSetting();
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('quantlab.accessibility.reducedMotion')) {
					const next = this.readSetting();
					if (next !== this.mode) {
						this.mode = next;
						this._onDidChange.fire(next);
					}
				}
			})
		);
	}

	static initialize(context: vscode.ExtensionContext): ReducedMotion {
		if (!ReducedMotion.instance) {
			ReducedMotion.instance = new ReducedMotion(context);
		}
		return ReducedMotion.instance;
	}

	static getInstance(): ReducedMotion {
		if (!ReducedMotion.instance) {
			throw new Error('ReducedMotion not initialized');
		}
		return ReducedMotion.instance;
	}

	getMode(): ReducedMotionMode {
		return this.mode;
	}

	private readSetting(): ReducedMotionMode {
		const config = vscode.workspace.getConfiguration('quantlab.accessibility');
		const value = config.get<ReducedMotionMode>('reducedMotion', 'auto');
		if (value === 'always' || value === 'never' || value === 'auto') {
			return value;
		}
		return 'auto';
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	static resetInstance(): void {
		if (ReducedMotion.instance) {
			ReducedMotion.instance.dispose();
			ReducedMotion.instance = undefined;
		}
	}
}
