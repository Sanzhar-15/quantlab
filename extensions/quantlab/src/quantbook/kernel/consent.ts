/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KernelKind } from './kernelOptions';

/**
 * The consent gate (QL-KERNEL, row CK-2): strategy code stays on this machine unless the user has
 * consented to send it. Every path that hands strategy source to a non-local kernel goes through
 * `assertStrategyMayLeave`; there is no other way to obtain a `ConsentedStrategy`.
 */

export interface ConsentRecord {
	/** The workspace the consent was given for. */
	readonly workspace: string;
	/** ISO time the user consented. */
	readonly grantedAt: string;
}

export interface ConsentStore {
	get(workspace: string): ConsentRecord | undefined;
	set(record: ConsentRecord): Promise<void>;
	clear(workspace: string): Promise<void>;
}

/** Strategy source that the gate has released for a non-local kernel. */
export interface ConsentedStrategy {
	readonly source: string;
	readonly consent: ConsentRecord;
}

export class ConsentRequiredError extends Error {
	readonly code = 'kernel_consent_required';
	constructor(readonly workspace: string) {
		super(`[kernel_consent_required] strategy code stays on this machine: no consent to send it to the cloud kernel is recorded for ${workspace}`);
	}
}

/**
 * Releases `source` for `kernel`. The local kernel needs no consent and gets no `ConsentedStrategy`
 * (nothing leaves the machine); the cloud kernel needs a recorded consent for this workspace.
 */
export function assertStrategyMayLeave(kernel: KernelKind, workspace: string, source: string, store: ConsentStore): ConsentedStrategy {
	if (kernel === 'local') {
		throw new Error('[kernel_consent_misuse] the local kernel receives strategy code directly; the consent gate releases code only for a non-local kernel');
	}
	const consent = store.get(workspace);
	if (consent === undefined) {
		throw new ConsentRequiredError(workspace);
	}
	if (consent.workspace !== workspace) {
		throw new Error(`[kernel_consent_mismatch] the consent record is for ${consent.workspace}, not ${workspace}`);
	}
	return { source, consent };
}

export async function grantConsent(workspace: string, store: ConsentStore, now: Date): Promise<ConsentRecord> {
	const record: ConsentRecord = { workspace, grantedAt: now.toISOString() };
	await store.set(record);
	return record;
}
