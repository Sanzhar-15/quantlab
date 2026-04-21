/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

interface FIMRequest {
	prompt: string;
	stop?: string[];
}

// Provider-specific FIM markers
const FIM_FORMATS: Record<string, { prefixTag: string; suffixTag: string; middleTag: string; stop: string[] }> = {
	anthropic: {
		prefixTag: '<|fim_prefix|>',
		suffixTag: '<|fim_suffix|>',
		middleTag: '<|fim_middle|>',
		stop: ['<|fim_end|>'],
	},
	openai: {
		prefixTag: '<|fim_prefix|>',
		suffixTag: '<|fim_suffix|>',
		middleTag: '<|fim_middle|>',
		stop: ['<|endoftext|>'],
	},
	ollama: {
		prefixTag: '<PRE>',
		suffixTag: '<SUF>',
		middleTag: '<MID>',
		stop: ['<EOT>'],
	},
	codellama: {
		prefixTag: '<PRE> ',
		suffixTag: ' <SUF>',
		middleTag: ' <MID>',
		stop: ['</s>', '  \n\n'],
	},
	starcoder: {
		prefixTag: '<fim_prefix>',
		suffixTag: '<fim_suffix>',
		middleTag: '<fim_middle>',
		stop: ['<|endoftext|>'],
	},
};

const DEFAULT_FORMAT = FIM_FORMATS.anthropic;

/**
 * FIM (Fill-In-the-Middle) adapter — formats FIM requests for different providers.
 */
export class FIMAdapter {

	formatFIMRequest(prefix: string, suffix: string, providerId: string): FIMRequest {
		const format = FIM_FORMATS[providerId] ?? DEFAULT_FORMAT;

		return {
			prompt: `${format.prefixTag}${prefix}${format.suffixTag}${suffix}${format.middleTag}`,
			stop: format.stop,
		};
	}

	/**
	 * Format as instruction-based prompt when FIM is not supported.
	 */
	formatInstructionRequest(prefix: string, suffix: string, language: string): FIMRequest {
		return {
			prompt: [
				`Complete the following ${language} code. Only provide the completion, nothing else.`,
				'',
				'Code before cursor:',
				'```',
				prefix.slice(-2000),  // Limit prefix to last 2000 chars
				'```',
				'',
				'Code after cursor:',
				'```',
				suffix.slice(0, 500),  // Limit suffix to first 500 chars
				'```',
				'',
				'Completion:',
			].join('\n'),
			stop: ['```', '\n\n\n'],
		};
	}
}
