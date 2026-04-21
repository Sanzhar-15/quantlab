/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function debounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
	let handle: NodeJS.Timeout | undefined;

	const wrapped = ((...args: unknown[]) => {
		if (handle) {
			clearTimeout(handle);
		}
		handle = setTimeout(() => {
			handle = undefined;
			fn(...args);
		}, delay);
	}) as T;

	return wrapped;
}
