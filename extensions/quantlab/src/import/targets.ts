/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ImportTarget } from './importer';

/** The internal workbench command (src/vs/workbench/contrib/quantlab/browser/importTargets.contribution.ts). */
export const ACTIVE_PROFILE_IMPORT_TARGETS_COMMAND = '_quantlab.activeProfileImportTargets';

/**
 * The only scheme accepted. Desktop builds revive every profile resource with the scheme of
 * `environmentService.userRoamingDataHome` (`vscode-userdata`, src/vs/workbench/electron-browser/desktop.main.ts:266-268),
 * and `FileUserDataProvider.toFileSystemResource` maps such a resource to disk by replacing only the scheme with `file`
 * (src/vs/platform/userData/common/fileUserDataProvider.ts:176-178), so the URI path IS the file path.
 */
const USER_DATA_SCHEME = 'vscode-userdata';

type ExecuteCommand = (command: string) => Thenable<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Revives a UriComponents-shaped value (a `vscode.Uri` or its serialized form) or throws `[import_targets_unreadable]`. */
function toUri(value: unknown, field: string): vscode.Uri {
	if (!isRecord(value) || typeof value.scheme !== 'string' || value.scheme === '' || typeof value.path !== 'string' || value.path === '') {
		throw new Error(`Quantlab: [import_targets_unreadable] ${field} is not a resource (expected scheme and path), got ${JSON.stringify(value)}.`);
	}
	for (const part of ['authority', 'query', 'fragment'] as const) {
		if (value[part] !== undefined && typeof value[part] !== 'string') {
			throw new Error(`Quantlab: [import_targets_unreadable] ${field}.${part} is not a string, got ${JSON.stringify(value[part])}.`);
		}
	}
	return vscode.Uri.from({
		scheme: value.scheme,
		path: value.path,
		authority: value.authority as string | undefined,
		query: value.query as string | undefined,
		fragment: value.fragment as string | undefined,
	});
}

function toLocalPath(uri: vscode.Uri, field: string): string {
	if (uri.scheme !== USER_DATA_SCHEME) {
		throw new Error(`Quantlab: [import_targets_not_local] ${field} ${uri.toString()} has scheme '${uri.scheme}'; only '${USER_DATA_SCHEME}' maps to a local file.`);
	}
	if (uri.authority !== '' || uri.query !== '' || uri.fragment !== '') {
		throw new Error(`Quantlab: [import_targets_not_local] ${field} ${uri.toString()} carries an authority, query or fragment, so it does not name one local file.`);
	}
	return vscode.Uri.from({ scheme: 'file', path: uri.path }).fsPath;
}

/**
 * The files import writes: the ACTIVE profile's own settings.json and keybindings.json, as named by the workbench.
 * Nothing is inferred from global storage (always the default profile's, whatever the active profile is).
 */
export async function importTarget(executeCommand: ExecuteCommand): Promise<ImportTarget> {
	const result = await executeCommand(ACTIVE_PROFILE_IMPORT_TARGETS_COMMAND);
	if (!isRecord(result)) {
		throw new Error(`Quantlab: [import_targets_unreadable] ${ACTIVE_PROFILE_IMPORT_TARGETS_COMMAND} returned ${JSON.stringify(result)}, not an object.`);
	}
	const settings = toUri(result.settingsResource, 'settingsResource');
	const keybindings = toUri(result.keybindingsResource, 'keybindingsResource');
	return { settingsPath: toLocalPath(settings, 'settingsResource'), keybindingsPath: toLocalPath(keybindings, 'keybindingsResource') };
}
