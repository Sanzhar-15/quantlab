/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The packaged quantlab manifest declares the Quantbook notebook type only where the product authorises
// Quantbook (product.json `quantlab.quantbookEnabled`). A notebook contribution has no `when` clause: left
// in a product whose key is false, `*.qnb` resolves to a notebook editor whose serializer never registers,
// and opening one shows the workbench's error page. With the type gone, `*.qnb` opens as text.

/** The notebook types the quantlab extension registers only when Quantbook is authorised. */
export const quantbookNotebookTypes: readonly string[] = Object.freeze(['quantlab-reactive-notebook']);

/** product.json's authorisation key, read strictly: anything but a boolean is refused by name. */
export function quantbookAuthorised(product: Record<string, unknown>): boolean {
	const key = product['quantlab.quantbookEnabled'];
	if (typeof key !== 'boolean') {
		throw new Error(`[quantbook-manifest] product.json 'quantlab.quantbookEnabled' must be true or false (got ${JSON.stringify(key)})`);
	}
	return key;
}

interface INotebookContribution { type?: unknown }
interface IQuantlabManifest {
	activationEvents?: unknown;
	contributes?: { notebooks?: unknown;[id: string]: unknown };
	[key: string]: unknown;
}

/**
 * The quantlab manifest as packaged: unchanged when Quantbook is authorised; otherwise without the Quantbook
 * notebook contributions and their `onNotebook:` activation events. Each Quantbook type must be present in
 * both places, so a renamed or moved type is refused by name instead of shipping unchanged.
 */
export function gateQuantbookManifest(manifest: IQuantlabManifest, authorised: boolean): IQuantlabManifest {
	if (authorised) {
		return manifest;
	}
	const notebooks = manifest.contributes?.notebooks;
	const activationEvents = manifest.activationEvents;
	if (!Array.isArray(notebooks) || !Array.isArray(activationEvents)) {
		throw new Error(`[quantbook-manifest] the quantlab manifest has no 'contributes.notebooks' or 'activationEvents' array; the Quantbook notebook types ${JSON.stringify(quantbookNotebookTypes)} cannot be removed`);
	}
	for (const type of quantbookNotebookTypes) {
		if (!notebooks.some((n: INotebookContribution) => n.type === type)) {
			throw new Error(`[quantbook-manifest] the quantlab manifest declares no notebook of type '${type}' in 'contributes.notebooks'`);
		}
		if (!activationEvents.includes(`onNotebook:${type}`)) {
			throw new Error(`[quantbook-manifest] the quantlab manifest has no activation event 'onNotebook:${type}'`);
		}
	}
	const keptNotebooks = notebooks.filter((n: INotebookContribution) => !quantbookNotebookTypes.includes(n.type as string));
	const contributes = { ...manifest.contributes };
	if (keptNotebooks.length === 0) {
		delete contributes.notebooks;
	} else {
		contributes.notebooks = keptNotebooks;
	}
	return {
		...manifest,
		activationEvents: activationEvents.filter(e => !quantbookNotebookTypes.some(type => e === `onNotebook:${type}`)),
		contributes,
	};
}
