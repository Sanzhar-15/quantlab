/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import es from 'event-stream';
import filter from 'gulp-filter';
import buffer from 'gulp-buffer';
import { Stream } from 'stream';
import File from 'vinyl';

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

/**
 * Gates quantlab's package.json in its packaging stream, BEFORE the stream is renamed under `extensions/quantlab/`:
 * gulp-filter matches the path relative to the file's cwd, so `extensions/quantlab/package.json` names the manifest
 * only while each file still sits at its source path. A stream that ends without the manifest passing the gate
 * fails by name, so a pattern that stops matching cannot ship the ungated manifest silently.
 */
export function gateQuantlabPackageJsonStream(input: Stream, authorised: boolean): Stream {
	const manifestFilter = filter('extensions/quantlab/package.json', { restore: true });
	let gated = 0;
	return input
		.pipe(manifestFilter)
		.pipe(buffer())
		.pipe(es.mapSync((f: File) => {
			gated++;
			f.contents = Buffer.from(JSON.stringify(gateQuantbookManifest(JSON.parse(f.contents!.toString('utf8')), authorised)));
			return f;
		}))
		.pipe(manifestFilter.restore)
		.pipe(es.through(function (this: es.ThroughStream, file: File) {
			this.emit('data', file);
		}, function (this: es.ThroughStream) {
			if (gated !== 1) {
				this.emit('error', new Error(`[quantbook-manifest] extensions/quantlab/package.json passed the manifest gate ${gated} time(s) in the quantlab packaging stream; expected exactly once`));
				return;
			}
			this.emit('end');
		}));
}
