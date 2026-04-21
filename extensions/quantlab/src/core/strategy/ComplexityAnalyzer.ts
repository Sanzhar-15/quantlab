/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ComplexityInfo } from '../../types/chart';
import { StrategyValidator } from './StrategyValidator';
import { ParameterExtractionResult } from './ParameterExtractor';

const DYNAMIC_CODE_PATTERN = /\b(eval|exec|importlib|subprocess|os\.system|requests)\b/;

export class ComplexityAnalyzer {
	private static instance: ComplexityAnalyzer | undefined;
	private readonly validator = StrategyValidator.getInstance();

	static getInstance(): ComplexityAnalyzer {
		if (!ComplexityAnalyzer.instance) {
			ComplexityAnalyzer.instance = new ComplexityAnalyzer();
		}
		return ComplexityAnalyzer.instance;
	}

	analyze(doc: vscode.TextDocument, params: ParameterExtractionResult): ComplexityInfo {
		const text = doc.getText();
		const entrypoint = this.validator.detectEntrypointFromText(text);

		if (!entrypoint) {
			return {
				level: 'viewOnly',
				score: 1,
				reasons: ['No strategy entrypoint detected']
			};
		}

		const reasons: string[] = [];
		let level: ComplexityInfo['level'] = 'safe';

		if (DYNAMIC_CODE_PATTERN.test(text)) {
			level = 'viewOnly';
			reasons.push('Dynamic or external code detected');
		} else if (params.hasErrors) {
			level = 'partial';
			reasons.push('Parameter parsing issues detected');
		}

		return {
			level,
			score: level === 'safe' ? 4 : level === 'partial' ? 2 : 1,
			reasons
		};
	}
}
