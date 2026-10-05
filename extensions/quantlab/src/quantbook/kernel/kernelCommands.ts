/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { workspaceConsentStore } from './consentStore';
import { ComputeRecord, KernelKind, KernelOption, resolveKernelChoice } from './kernelOptions';
import { selectKernel, storedKernelChoice } from './kernelPicker';

// QL-KERNEL -- the VS Code side of the kernel choice: the `quantlab.quantbook.kernel` setting and
// the "Select Kernel" picker. Registered from registerReactiveKernelCommands, so it exists only
// inside registerQuantbookRuntime (Quantbook authorised and enabled).

const KERNEL_SETTING = 'quantbook.kernel';
const CONSENT_ACTION = 'Send to Cloud Kernel';

/**
 * What the compute service publishes about itself. No compute service exists yet, so there is no
 * record: the picker offers the local kernel only and a stored `cloud` choice is refused by name.
 */
export function readComputeRecord(): ComputeRecord | undefined {
	return undefined;
}

function readKernelSetting(): string | undefined {
	return storedKernelChoice(vscode.workspace.getConfiguration('quantlab').get<unknown>(KERNEL_SETTING));
}

export interface ConfiguredKernel {
	readonly kind: KernelKind;
	/** False when the setting is `default`: the user made no choice and `kind` is the default option. */
	readonly chosen: boolean;
}

/**
 * The kernel the next start uses, and whether the user chose it. Throws by name on an invalid or
 * unavailable stored choice. The caller states an unchosen kernel in its log, never silently.
 */
export function resolveConfiguredKernel(): ConfiguredKernel {
	const stored = readKernelSetting();
	return { kind: resolveKernelChoice(stored, readComputeRecord()), chosen: stored !== undefined };
}

function workspaceIdentity(): string | undefined {
	if (vscode.workspace.workspaceFile !== undefined) {
		return vscode.workspace.workspaceFile.toString();
	}
	const folders = vscode.workspace.workspaceFolders;
	if (folders === undefined || folders.length === 0) {
		return undefined;
	}
	return folders[0].uri.toString();
}

interface KernelPickItem extends vscode.QuickPickItem {
	readonly kernel: KernelKind;
}

function toPickItem(option: KernelOption, stored: string | undefined): KernelPickItem {
	const marks: string[] = [];
	if (option.isDefault) {
		marks.push('default');
	}
	if (option.kind === stored) {
		marks.push('selected');
	}
	return { kernel: option.kind, label: option.label, detail: option.detail, description: marks.join(', ') };
}

export function registerKernelCommands(context: vscode.ExtensionContext): void {
	const consentStore = workspaceConsentStore(context.workspaceState);
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookSelectKernel', async () => {
			const workspace = workspaceIdentity();
			const target = workspace === undefined ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
			const picked = await selectKernel({
				compute: readComputeRecord(),
				stored: readKernelSetting(),
				workspace,
				consentStore,
				now: () => new Date(),
				writeChoice: async kind => {
					await vscode.workspace.getConfiguration('quantlab').update(KERNEL_SETTING, kind, target);
				},
				ui: {
					pick: async (options, stored) => {
						const item = await vscode.window.showQuickPick(
							options.map(option => toPickItem(option, stored)),
							{ title: 'Quantbook: Select Kernel', placeHolder: 'The kernel Quantbook runs Python on' },
						);
						return item === undefined ? undefined : item.kernel;
					},
					confirmCloudConsent: async consentWorkspace => {
						const answer = await vscode.window.showWarningMessage(
							'Send strategy code to the cloud kernel?',
							{
								modal: true,
								detail: `The cloud kernel runs your strategy code on Delta Plus compute, so the code leaves this machine. This consent is recorded for ${consentWorkspace}.`,
							},
							CONSENT_ACTION,
						);
						return answer === CONSENT_ACTION;
					},
				},
			});
			if (picked !== undefined) {
				void vscode.window.showInformationMessage(`Quantbook: the ${picked} kernel is selected. It applies from the next kernel start.`);
			}
		}),
	);
}
