/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type StrategyEntrypoint =
	| { type: 'vectorized'; functionName: 'strategy' }
	| { type: 'eventDriven'; functionName: 'on_bar' }
	| { type: 'classBased'; className: string };

export type ComplexityLevel = 'safe' | 'partial' | 'viewOnly';

export interface ParameterDefinition {
	id: string;
	default: unknown;
	min?: number;
	max?: number;
	step?: number;
	choices?: unknown[];
	name?: string;
	group?: string;
	description?: string;
	format?: 'percent' | 'currency' | 'number';
}

export interface StrategyValidationResult {
	isValid: boolean;
	entrypoint: StrategyEntrypoint | null;
	complexity: ComplexityLevel;
	parameters: ParameterDefinition[];
	hasVisualizationCode: boolean;
	errors: ValidationError[];
	warnings: ValidationWarning[];
}

export interface ValidationError {
	line: number;
	message: string;
	code: string;
}

export interface ValidationWarning {
	line: number;
	message: string;
	code: string;
}

/**
 * Request body for server-side strategy validation endpoint.
 * POST /v1/strategies/validate
 */
export interface StrategyValidationRequest {
	code: string;
	filename?: string;
}

/**
 * Response from server-side strategy validation endpoint.
 * Mirrors client-side StrategyValidationResult for consistency.
 */
export interface StrategyValidationResponse {
	isValid: boolean;
	entrypoint: StrategyEntrypoint | null;
	complexity: ComplexityLevel;
	errors: Array<{
		line: number;
		code: string;
		message: string;
		suggestion?: string;
	}>;
	warnings: Array<{
		line: number;
		code: string;
		message: string;
	}>;
}

/**
 * Strategy template category.
 */
export type StrategyCategory =
	| 'trend-following'
	| 'mean-reversion'
	| 'momentum'
	| 'breakout'
	| 'multi-indicator'
	| 'portfolio';

/**
 * Strategy template difficulty level.
 */
export type StrategyDifficulty = 'beginner' | 'intermediate' | 'advanced';

/**
 * Strategy template parameter definition.
 */
export interface TemplateParameter {
	id: string;
	description: string;
	defaultValue: number;
	range: [number, number];
}

/**
 * Strategy template.
 */
export interface StrategyTemplate {
	id: string;
	name: string;
	description: string;
	category: StrategyCategory;
	difficulty: StrategyDifficulty;
	entrypoint: 'vectorized' | 'eventDriven' | 'classBased';
	code: string;
	parameters: TemplateParameter[];
}

/**
 * Response from GET /v1/strategies/templates endpoint.
 */
export interface StrategyTemplatesResponse {
	version: string;
	templates: StrategyTemplate[];
}
