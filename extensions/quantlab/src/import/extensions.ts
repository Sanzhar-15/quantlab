/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * QL-IMPORT: installing the source editor's extensions through the extension gallery.
 */

export interface GalleryPort {
	isInstalled(id: string): boolean;
	/** Rejects when the gallery has no such extension or the install fails. */
	install(id: string): Promise<void>;
}

export interface ExtensionsOutcome {
	alreadyInstalled: string[];
	installed: string[];
	unresolved: { id: string; reason: string }[];
}

/**
 * Sequential. An id the gallery cannot supply (or whose install fails) is a recorded outcome in
 * `unresolved`, with the reason, not a swallowed error.
 */
export async function importExtensions(ids: string[], gallery: GalleryPort): Promise<ExtensionsOutcome> {
	const outcome: ExtensionsOutcome = { alreadyInstalled: [], installed: [], unresolved: [] };
	for (const id of ids) {
		if (gallery.isInstalled(id)) {
			outcome.alreadyInstalled.push(id);
			continue;
		}
		try {
			await gallery.install(id);
			outcome.installed.push(id);
		} catch (err: unknown) {
			outcome.unresolved.push({ id, reason: err instanceof Error ? err.message : String(err) });
		}
	}
	return outcome;
}
