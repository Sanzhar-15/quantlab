/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function installErrorBoundary(onError: (message: string) => void): void {
	window.addEventListener('error', event => {
		if (event.message) {
			onError(event.message);
		}
	});

	window.addEventListener('unhandledrejection', event => {
		if (event.reason instanceof Error) {
			onError(event.reason.message);
		} else if (typeof event.reason === 'string') {
			onError(event.reason);
		}
	});
}
