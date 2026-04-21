/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Schema Adapter for IPC message conversion (FIX-CGP-003).
 *
 * The Python daemon uses snake_case for JSON keys (Python convention).
 * The TypeScript extension uses camelCase (TypeScript convention).
 * This adapter converts between the two at the IPC boundary.
 *
 * Canonical wire format: snake_case (Python authoritative).
 * Internal TypeScript format: camelCase.
 */

/**
 * Convert a snake_case string to camelCase.
 */
export function snakeToCamel(str: string): string {
	return str.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
}

/**
 * Convert a camelCase string to snake_case.
 */
export function camelToSnake(str: string): string {
	return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

/**
 * Recursively convert all keys in an object from snake_case to camelCase.
 *
 * Used when receiving data from the Python daemon.
 */
export function fromDaemon<T = unknown>(data: unknown): T {
	return convertKeys(data, snakeToCamel) as T;
}

/**
 * Recursively convert all keys in an object from camelCase to snake_case.
 *
 * Used when sending data to the Python daemon.
 */
export function toDaemon<T = unknown>(data: unknown): T {
	return convertKeys(data, camelToSnake) as T;
}

/**
 * Keys that should NOT be converted (protocol-level keys).
 */
const PRESERVE_KEYS = new Set([
	'jsonrpc',
	'id',
	'method',
	'params',
	'result',
	'error',
	'_meta',
	'_auth',
]);

/**
 * Recursively convert object keys using a transform function.
 */
function convertKeys(data: unknown, transform: (key: string) => string): unknown {
	if (data === null || data === undefined) {
		return data;
	}

	if (Array.isArray(data)) {
		return data.map(item => convertKeys(item, transform));
	}

	if (typeof data === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
			const newKey = PRESERVE_KEYS.has(key) ? key : transform(key);
			result[newKey] = convertKeys(value, transform);
		}
		return result;
	}

	return data;
}

/**
 * Schema adapter that wraps IPC communication with automatic conversion.
 */
export class SchemaAdapter {
	/**
	 * Convert daemon response params to TypeScript format (snake_case → camelCase).
	 */
	static fromDaemon<T = unknown>(data: unknown): T {
		return fromDaemon<T>(data);
	}

	/**
	 * Convert TypeScript params to daemon format (camelCase → snake_case).
	 */
	static toDaemon<T = unknown>(data: unknown): T {
		return toDaemon<T>(data);
	}

	/**
	 * Convert a notification's params from daemon format.
	 */
	static convertNotificationParams(_method: string, params: unknown): unknown {
		return fromDaemon(params);
	}

	/**
	 * Convert request params to daemon format before sending.
	 */
	static convertRequestParams(_method: string, params: unknown): unknown {
		return toDaemon(params);
	}
}
