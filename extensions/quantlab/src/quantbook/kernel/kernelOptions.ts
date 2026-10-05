/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Kernel choice for Quantbook (QL-KERNEL). The local kernel is always available. The cloud kernel
 * exists only while a compute record names BOTH its endpoint and its interface artefact; until
 * then the picker offers no cloud option at all.
 */

export type KernelKind = 'local' | 'cloud';

/** What the compute service publishes about itself. Absent while no compute service exists. */
export interface ComputeRecord {
	readonly endpoint?: string;
	readonly interfaceArtefact?: string;
}

export interface KernelOption {
	readonly kind: KernelKind;
	readonly label: string;
	readonly detail: string;
	readonly isDefault: boolean;
}

export function isCloudKernelAvailable(compute: ComputeRecord | undefined): compute is Required<ComputeRecord> {
	return compute !== undefined
		&& typeof compute.endpoint === 'string' && compute.endpoint !== ''
		&& typeof compute.interfaceArtefact === 'string' && compute.interfaceArtefact !== '';
}

/**
 * The picker's options, default first. With a complete compute record the cloud kernel is the
 * default and the local kernel is one switch away; otherwise the local kernel is the only option.
 */
export function kernelOptions(compute: ComputeRecord | undefined): KernelOption[] {
	const local = (isDefault: boolean): KernelOption => ({
		kind: 'local',
		label: 'Local kernel',
		detail: 'Runs on this machine with your Python interpreter. Your code and data stay on this machine.',
		isDefault,
	});
	if (!isCloudKernelAvailable(compute)) {
		return [local(true)];
	}
	return [
		{
			kind: 'cloud',
			label: 'Cloud kernel',
			detail: `Runs on Delta Plus compute (${compute.endpoint}). Your strategy code is sent there only with your consent.`,
			isDefault: true,
		},
		local(false),
	];
}

/**
 * The kernel a stored choice resolves to. No stored choice means the default option. A stored
 * `cloud` choice without an available cloud kernel is refused by name, never replaced by local.
 */
export function resolveKernelChoice(stored: string | undefined, compute: ComputeRecord | undefined): KernelKind {
	const options = kernelOptions(compute);
	if (stored === undefined) {
		return options[0].kind;
	}
	if (stored !== 'local' && stored !== 'cloud') {
		throw new Error(`[kernel_choice_invalid] unknown kernel choice '${stored}' (expected 'local' or 'cloud')`);
	}
	if (!options.some(option => option.kind === stored)) {
		throw new Error(`[kernel_cloud_unavailable] the cloud kernel was chosen but no compute service is available; choose the local kernel`);
	}
	return stored;
}
