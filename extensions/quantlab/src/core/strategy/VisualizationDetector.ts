/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface VisualizationDetectionResult {
	hasVisualization: boolean;
	line?: number;
}

export class VisualizationDetector {
	private static instance: VisualizationDetector | undefined;
	private readonly pattern = /def\s+visualize\s*\(/;

	static getInstance(): VisualizationDetector {
		if (!VisualizationDetector.instance) {
			VisualizationDetector.instance = new VisualizationDetector();
		}
		return VisualizationDetector.instance;
	}

	detect(doc: vscode.TextDocument): VisualizationDetectionResult {
		return this.detectFromText(doc.getText());
	}

	detectFromText(text: string): VisualizationDetectionResult {
		const match = this.pattern.exec(text);
		if (!match || match.index === undefined) {
			return { hasVisualization: false };
		}

		const line = text.slice(0, match.index).split(/\r\n|\r|\n/).length;
		return { hasVisualization: true, line };
	}
}
