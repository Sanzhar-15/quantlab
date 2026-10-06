/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (U7, CH-2): the chrome keys cannot be changed by the user. The four chrome settings (`QL_CHROME_SETTINGS`, the U6
// seed's keys and values) carry `policy` metadata on their registrations, and their values are held by a policy source the user
// cannot write: a JSON file inside the app bundle (`ql-chrome-policy.json`, next to this file in `src`, copied to `out` by the
// compile and listed as a packaged resource in `build/gulpfile.vscode.ts`), found at run time with `FileAccess.asFileUri` like the
// terminal view's files (`app.ts` `qlTerminalPaths`). A policy value overrides every other configuration source (the user's
// settings.json included) in the configuration model, and a write of a policy-held setting is refused by the configuration service.
//
// The source is ADDED to the platform's: `CombinedPolicyService` puts the bundled values first and passes every other policy through
// from whatever `main.ts` picked (native on Windows / macOS, `/etc/vscode/policy.json` on Linux, the `--__enable-file-policy` file,
// or none). The native service is never replaced, so OS / enterprise policy for every other setting is untouched.
//
// The U6 seed (`chromeSeed.ts`) stays: it writes the same four values into a fresh profile's `settings.json`, so the file the user
// sees (and the settings a profile syncs or copies) agrees with what is in force, and it is the single list of keys and values this
// file is checked against.

import { app, dialog } from 'electron';
import { readFileSync } from 'fs';
import { FileAccess } from '../../../base/common/network.js';
import { PolicyName } from '../../../base/common/policy.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { CombinedPolicyService } from '../../../platform/policy/common/combinedPolicyService.js';
import { IPolicyService, PolicyValue } from '../../../platform/policy/common/policy.js';
import { QL_CHROME_POLICIES, QL_POLICY_ONLY_SETTINGS, QL_POLICY_TITLE_BAR_STYLE } from '../../../platform/policy/common/qlChromePolicy.js';
import { StaticPolicyService } from '../../../platform/policy/common/staticPolicyService.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { localize } from '../../../nls.js';
import { QL_CHROME_SETTINGS } from './chromeSeed.js';

/** Where the bundled policy file is, relative to `out` (dev and packaged). */
export const QL_CHROME_POLICY_FILE = 'vs/code/electron-main/qlHost/ql-chrome-policy.json';

/**
 * The main process decides the window frame from `window.titleBarStyle`, but its configuration registry does not load the
 * workbench contributions that register the setting, so without this the policy would hold the setting in the renderer and not in
 * the frame. Registers that one setting (the schema of `desktop.contribution.ts`'s registration, with the same policy object).
 * Called once, before the configuration service initializes.
 */
export function registerQlChromePolicyConfiguration(): void {
	Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
		id: 'window',
		order: 8,
		title: localize('qlChromePolicyWindowConfigurationTitle', "Window"),
		type: 'object',
		properties: {
			'window.titleBarStyle': {
				type: 'string',
				enum: ['native', 'custom'],
				default: 'custom',
				scope: ConfigurationScope.APPLICATION,
				description: localize('qlChromePolicyTitleBarStyleDescription', "Adjust the appearance of the window title bar to be native by the OS or custom. Changes require a full restart to apply."),
				policy: QL_POLICY_TITLE_BAR_STYLE
			}
		}
	});
}

/**
 * Reads the bundled policy file. Throws, naming the file and the problem, when it is missing, does not parse, is not an object
 * with exactly the four chrome policies and the policy-only ones (`QL_POLICY_ONLY_SETTINGS`, c1 M5), or holds a value that is not
 * the seed's (or, for a policy-only key, the list's) value for that setting. Nothing is defaulted.
 */
export function readQlChromePolicy(): ReadonlyMap<PolicyName, PolicyValue> {
	const file = FileAccess.asFileUri(QL_CHROME_POLICY_FILE).fsPath;

	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch (error) {
		throw new Error(`QuantLab host (U7): the bundled chrome policy file ${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new Error(`QuantLab host (U7): the bundled chrome policy file ${file} does not parse: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error(`QuantLab host (U7): the bundled chrome policy file ${file} is not a JSON object`);
	}

	const content = raw as Record<string, unknown>;
	const expectedNames = new Set([...QL_CHROME_POLICIES, ...QL_POLICY_ONLY_SETTINGS].map(entry => entry.policyName));
	const problems: string[] = [];
	for (const name of Object.keys(content)) {
		if (!expectedNames.has(name)) {
			problems.push(`${name} is not a chrome policy`);
		}
	}

	const values = new Map<PolicyName, PolicyValue>();
	for (const { settingKey, policyName } of QL_CHROME_POLICIES) {
		const seeded = QL_CHROME_SETTINGS.find(([key]) => key === settingKey);
		if (seeded === undefined) {
			problems.push(`${settingKey} has no value in the chrome seed`);
		} else if (!Object.prototype.hasOwnProperty.call(content, policyName)) {
			problems.push(`${policyName} is missing (expected ${JSON.stringify(seeded[1])})`);
		} else if (content[policyName] !== seeded[1]) {
			problems.push(`${policyName} is ${JSON.stringify(content[policyName])} (expected ${JSON.stringify(seeded[1])}, the chrome seed's value of ${settingKey})`);
		} else {
			values.set(policyName, seeded[1]);
		}
	}
	for (const { settingKey, policyName, value } of QL_POLICY_ONLY_SETTINGS) {
		if (!Object.prototype.hasOwnProperty.call(content, policyName)) {
			problems.push(`${policyName} is missing (expected ${JSON.stringify(value)})`);
		} else if (content[policyName] !== value) {
			problems.push(`${policyName} is ${JSON.stringify(content[policyName])} (expected ${JSON.stringify(value)}, the policy-only value of ${settingKey})`);
		} else {
			values.set(policyName, value);
		}
	}

	if (problems.length > 0) {
		throw new Error(`QuantLab host (U7): the bundled chrome policy file ${file}: ${problems.join('; ')}`);
	}

	return values;
}

/**
 * The policy service `main.ts` hands to the configuration service: the bundled chrome policy first, `platformPolicyService` (what
 * `main.ts` chose) behind it. A bundled file that is missing or wrong fails the launch: this runs in `createServices`, before
 * `startup`'s own error path exists (its promise is not awaited, so a throw there would be an unhandled rejection and the app
 * could stay up with no window), so it reports the error, shows it, exits with 1 and rethrows.
 */
export function createQlCombinedPolicyService(platformPolicyService: IPolicyService, logService: ILogService): CombinedPolicyService {
	let bundled: ReadonlyMap<PolicyName, PolicyValue>;
	try {
		bundled = readQlChromePolicy();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		dialog.showErrorBox('QuantLab', message);
		app.exit(1);
		throw error;
	}

	return new CombinedPolicyService([new StaticPolicyService(bundled), platformPolicyService], logService);
}
