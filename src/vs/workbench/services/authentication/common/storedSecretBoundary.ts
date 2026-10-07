/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runs an operation at a start-up or event boundary, where nobody awaits the result. A stored-secret read that cannot
 * decrypt or parse rejects (F-SECRETS-1); a rejection there would be an unhandled one. The failure is handed to
 * `onFailure`, which must log it (and notify where the caller already notifies): it is never swallowed, and no result
 * is substituted for the failed one.
 *
 * The returned promise never rejects, so a queue or listener that runs this stays usable for the next event.
 * @returns true when the operation succeeded, false when it failed and was reported.
 */
export async function runAtBoundary(operation: () => Promise<unknown>, onFailure: (error: unknown) => void): Promise<boolean> {
	try {
		await operation();
	} catch (error) {
		onFailure(error);
		return false;
	}
	return true;
}
