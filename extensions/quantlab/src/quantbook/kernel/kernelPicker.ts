/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConsentStore, grantConsent } from './consent';
import { ComputeRecord, KernelKind, KernelOption, kernelOptions } from './kernelOptions';

/**
 * The kernel picker's decision logic (QL-KERNEL), free of `vscode` so it is testable. The picker
 * offers exactly `kernelOptions(compute)`; choosing the cloud kernel records the workspace's consent
 * first, and a declined consent leaves the stored choice untouched.
 */

export interface KernelPickerUi {
	/** Shows the options; resolves to the picked kind, or `undefined` when the picker is dismissed. */
	pick(options: readonly KernelOption[], stored: string | undefined): Promise<KernelKind | undefined>;
	/** Asks the user to consent to sending strategy code from `workspace` to the cloud kernel. */
	confirmCloudConsent(workspace: string): Promise<boolean>;
}

export interface SelectKernelDeps {
	readonly compute: ComputeRecord | undefined;
	readonly stored: string | undefined;
	/** The open workspace's identity; `undefined` when no folder or workspace is open. */
	readonly workspace: string | undefined;
	readonly ui: KernelPickerUi;
	readonly consentStore: ConsentStore;
	writeChoice(kind: KernelKind): Promise<void>;
	now(): Date;
}

/** The stored choice behind the `quantlab.quantbook.kernel` setting: `default` means no stored choice. */
export function storedKernelChoice(setting: unknown): string | undefined {
	if (typeof setting !== 'string') {
		throw new Error(`[kernel_choice_invalid] setting quantlab.quantbook.kernel must be a string (got ${typeof setting})`);
	}
	return setting === 'default' ? undefined : setting;
}

/** Runs the picker. Resolves to the kind written, or `undefined` when nothing was changed. */
export async function selectKernel(deps: SelectKernelDeps): Promise<KernelKind | undefined> {
	const options = kernelOptions(deps.compute);
	const picked = await deps.ui.pick(options, deps.stored);
	if (picked === undefined) {
		return undefined;
	}
	if (!options.some(option => option.kind === picked)) {
		throw new Error(`[kernel_choice_invalid] the picker returned '${picked}', which was not offered`);
	}
	if (picked === 'cloud') {
		if (deps.workspace === undefined) {
			throw new Error('[kernel_consent_no_workspace] the cloud kernel needs an open folder or workspace: consent to send strategy code is recorded per workspace');
		}
		if (deps.consentStore.get(deps.workspace) === undefined) {
			if (!(await deps.ui.confirmCloudConsent(deps.workspace))) {
				return undefined;
			}
			await grantConsent(deps.workspace, deps.consentStore, deps.now());
		}
	}
	await deps.writeChoice(picked);
	return picked;
}
