/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (U6, CH-1h): the chrome seed. The workbench window is the host's, so its chrome is the host's: a native title
// bar, no custom title bar, the activity bar on top, the side bar on the left. These four are ordinary user settings of the
// default profile (`window.*` are application-scoped, read from the default profile's `User/settings.json`), so the seed is a
// file written ONCE, on a fresh profile, before any workbench window can open (`app.ts` `startQlTerminalHost`).
//
//  - the file does not exist: it is created with exactly these four keys (`flag: 'wx'`: an exclusive create, never an overwrite);
//  - the file exists and holds all four keys with these values: `chrome seed present`;
//  - the file exists and does not: an ERROR naming each missing or different key. The file is never merged into and never
//    overwritten (a user's own settings are not the host's to rewrite). CH-2 ("the user cannot change the keys") is therefore
//    NOT met by this file: a setting a user may edit can only be reported on, not held. See the U6 report for what holding it
//    takes (`policy` metadata on the four registrations plus a policy source, none of which is in this unit's write set).
//
// Plain `fs` and not `IFileService`: `IFileService.createFile` is a stat followed by a write (not exclusive), and the seed's
// guarantee is the exclusive create. `app.ts` reads and writes `argv.json` through `IFileService`; this file is read once and
// created once before the file service has any watcher or cache to keep consistent.

import { promises } from 'fs';
import { parse, ParseError } from '../../../base/common/json.js';
import { getParseErrorMessage } from '../../../base/common/jsonErrorMessages.js';
import { Schemas } from '../../../base/common/network.js';
import { dirname } from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { ILogService } from '../../../platform/log/common/log.js';

/** The four chrome keys and their values, in the order the seed file lists them. */
export const QL_CHROME_SETTINGS: ReadonlyArray<readonly [key: string, value: string]> = [
	['window.titleBarStyle', 'native'],
	['window.customTitleBarVisibility', 'never'],
	['workbench.activityBar.location', 'top'],
	['workbench.sideBar.location', 'left']
];

export type QlChromeSeedOutcome = 'wrote' | 'present' | 'differs';

function seedText(): string {
	const body: Record<string, string> = {};
	for (const [key, value] of QL_CHROME_SETTINGS) {
		body[key] = value;
	}

	return `${JSON.stringify(body, undefined, '\t')}\n`;
}

/**
 * Seeds (or checks) the chrome keys in `settingsResource` (the default profile's `settingsResource`). Resolves with what it did:
 * `wrote`, `present`, or `differs` (the error was logged). Rejects when the file cannot be created or read for any reason other
 * than "it already exists": nothing is defaulted and nothing is retried.
 */
export async function seedQlChromeSettings(settingsResource: URI, logService: ILogService): Promise<QlChromeSeedOutcome> {
	// The default profile's `settingsResource` is a `vscode-userdata:` URI (main.ts registers FileUserDataProvider over the disk
	// provider with the SAME path, scheme swapped), so it is read as that file. Any other scheme is an error, not a default
	// (package 5b, folds/HOST/U5-LAUNCH-2.md: the `file:`-only check killed every launch before a window).
	let fileResource: URI;
	if (settingsResource.scheme === Schemas.file) {
		fileResource = settingsResource;
	} else if (settingsResource.scheme === Schemas.vscodeUserData) {
		fileResource = settingsResource.with({ scheme: Schemas.file });
	} else {
		throw new Error(`QuantLab host (U6): chrome seed: the default profile's settings resource ${settingsResource.toString()} is neither a file: nor a vscode-userdata: resource`);
	}

	const file = fileResource.fsPath;
	await promises.mkdir(dirname(file), { recursive: true });

	try {
		await promises.writeFile(file, seedText(), { flag: 'wx' });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw error;
		}

		return checkSeeded(file, logService);
	}

	logService.info(`QuantLab host: chrome seed wrote ${file}`);

	return 'wrote';
}

async function checkSeeded(file: string, logService: ILogService): Promise<QlChromeSeedOutcome> {
	const text = await promises.readFile(file, 'utf8');
	const errors: ParseError[] = [];
	const parsed: unknown = parse(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
	if (errors.length > 0) {
		logService.error(`QuantLab host: chrome seed: ${file} does not parse (${errors.map(error => `${getParseErrorMessage(error.error)} at offset ${error.offset}`).join('; ')}); it is not touched`);

		return 'differs';
	}

	const settings: Record<string, unknown> = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	const problems: string[] = [];
	for (const [key, value] of QL_CHROME_SETTINGS) {
		if (!Object.prototype.hasOwnProperty.call(settings, key)) {
			problems.push(`${key} is missing (expected ${JSON.stringify(value)})`);
		} else if (settings[key] !== value) {
			problems.push(`${key} is ${JSON.stringify(settings[key])} (expected ${JSON.stringify(value)})`);
		}
	}

	if (problems.length > 0) {
		logService.error(`QuantLab host: chrome seed: ${file}: ${problems.join('; ')}; the file is not merged into and not overwritten`);

		return 'differs';
	}

	logService.info('QuantLab host: chrome seed present');

	return 'present';
}
