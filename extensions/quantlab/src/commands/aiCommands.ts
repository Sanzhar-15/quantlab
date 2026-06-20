/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI commands (R15)
 *  Set / clear the Anthropic API key in the OS secret store, and load it into the provider
 *  at activation. The key lives ONLY in SecureStorage (context.secrets) -- never in plaintext
 *  VS Code settings. Mirrors the broker-credential input-box idiom (SessionManager).
 *---------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { SecureStorage } from '../utils/secureStorage';
import { ClaudeProvider } from '../ai/provider';
import { AIAuditLogger } from '../ai/audit';
import { resolveModel } from '../ai/modelConfig';

/** Secret-store key for the Anthropic API key. */
export const AI_API_KEY_SECRET = 'quantlab.ai.apiKey';

/**
 * The activation-time key load. Set/Clear handlers await this before mutating so a fast user
 * action can never be overwritten by an in-flight load reconfiguring the provider with the
 * old key (the load always settles first; the user action then wins).
 */
let initialLoad: Promise<void> = Promise.resolve();

/** Read the configured model id (corrected to a live default by resolveModel). */
function configuredModel(): string {
	return resolveModel(vscode.workspace.getConfiguration('quantlab.ai').get<string>('model'));
}

/**
 * Register the Set / Clear Anthropic API key commands. Idempotent per activation
 * (all registrations pushed to context.subscriptions).
 */
export function registerAICommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.setAnthropicApiKey', async () => {
			// Let the activation load settle first so this Set always wins (no race).
			await initialLoad;
			const key = await vscode.window.showInputBox({
				title: 'Set Anthropic API Key',
				prompt: 'Stored in the OS secret store -- never in plaintext settings.',
				placeHolder: 'sk-ant-...',
				password: true,
				ignoreFocusOut: true,
				validateInput: (value) => {
					const v = (value || '').trim();
					if (v.length === 0) {
						return 'API key cannot be empty';
					}
					if (!v.startsWith('sk-ant-')) {
						return 'Anthropic API keys start with "sk-ant-"';
					}
					return null;
				},
			});
			if (key === undefined) {
				// User cancelled -- leave any existing key untouched.
				return;
			}
			const trimmed = key.trim();
			await SecureStorage.getInstance().store(AI_API_KEY_SECRET, trimmed);
			ClaudeProvider.getInstance().configure({ apiKey: trimmed, model: configuredModel() });
			void vscode.window.showInformationMessage(
				'Quantbook: Anthropic API key saved to the OS secret store.'
			);
		}),
		vscode.commands.registerCommand('quantlab.clearAnthropicApiKey', async () => {
			// Let the activation load settle first so this Clear always wins (no race).
			await initialLoad;
			const choice = await vscode.window.showWarningMessage(
				'Remove the stored Anthropic API key? AI features stop working until you set a new key.',
				{ modal: true },
				'Remove Key'
			);
			if (choice !== 'Remove Key') {
				return;
			}
			await SecureStorage.getInstance().delete(AI_API_KEY_SECRET);
			// Clear the in-memory key too (empty key -> 'unconfigured'); keep the chosen model.
			ClaudeProvider.getInstance().configure({ apiKey: '', model: configuredModel() });
			void vscode.window.showInformationMessage('Quantbook: Anthropic API key removed.');
		})
	);
}

/**
 * At activation: initialize the local audit log, migrate any legacy plaintext key, and
 * load the stored key into the provider so AI features work without re-entering the key.
 * Must run AFTER SecureStorage.initialize(context).
 */
export function loadAnthropicKeyIntoProvider(context: vscode.ExtensionContext): Promise<void> {
	// The awaited barrier must always SETTLE so a load failure cannot brick Set/Clear for the
	// session. The failure is still surfaced loud (console.error) -- it is logged, not hidden.
	initialLoad = doLoadAnthropicKey(context).catch((error) => {
		console.error('Failed to load the Anthropic API key into the AI provider:', error);
	});
	return initialLoad;
}

async function doLoadAnthropicKey(context: vscode.ExtensionContext): Promise<void> {
	// Without this the audit log silently no-ops (the logger throws "not initialized").
	AIAuditLogger.initialize(context.globalStorageUri.fsPath);

	const secrets = SecureStorage.getInstance();
	await migrateLegacyPlaintextKey(secrets);

	const key = await secrets.get(AI_API_KEY_SECRET);
	if (key) {
		ClaudeProvider.getInstance().configure({ apiKey: key, model: configuredModel() });
	}
}

/** One config scope that may hold a plaintext `apiKey`, with its RAW (non-effective) value. */
interface KeyScope {
	readonly target: vscode.ConfigurationTarget;
	readonly config: vscode.WorkspaceConfiguration;
	/** The raw value set AT this scope (trimmed), or undefined if unset/blank. */
	readonly raw: string | undefined;
}

function asNonEmpty(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Every config scope's RAW `apiKey` value. Uses `inspect()` (NOT effective `get()`, which a
 * higher-priority empty value can mask) and a resource-scoped configuration per workspace folder
 * (folder-scoped values are invisible to the unscoped configuration).
 */
function rawApiKeyScopes(): KeyScope[] {
	const root = vscode.workspace.getConfiguration('quantlab.ai');
	const ri = root.inspect<string>('apiKey');
	const scopes: KeyScope[] = [
		{ target: vscode.ConfigurationTarget.Global, config: root, raw: asNonEmpty(ri?.globalValue) },
		{ target: vscode.ConfigurationTarget.Workspace, config: root, raw: asNonEmpty(ri?.workspaceValue) },
	];
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const fcfg = vscode.workspace.getConfiguration('quantlab.ai', folder.uri);
		const fi = fcfg.inspect<string>('apiKey');
		scopes.push({ target: vscode.ConfigurationTarget.WorkspaceFolder, config: fcfg, raw: asNonEmpty(fi?.workspaceFolderValue) });
	}
	return scopes;
}

/**
 * One-time migration of a legacy plaintext `quantlab.ai.apiKey` setting into SecureStorage.
 * Copies the key into the secret store, ATTEMPTS to remove the plaintext copy from every scope
 * that holds it, then re-inspects ALL scopes. If any plaintext value survives (or the secret-store
 * write failed), surface a LOUD error -- the key must never be left in plaintext silently
 * (No-Fallbacks).
 */
async function migrateLegacyPlaintextKey(secrets: SecureStorage): Promise<void> {
	const present = rawApiKeyScopes().filter(scope => scope.raw !== undefined);
	if (present.length === 0) {
		return;
	}

	// Copy into the secret store (if not already there). A store failure is security-relevant.
	let storeFailed = false;
	try {
		const existing = await secrets.get(AI_API_KEY_SECRET);
		if (!existing) {
			await secrets.store(AI_API_KEY_SECRET, present[0].raw as string);
		}
	} catch (error) {
		storeFailed = true;
		console.error('Failed to store the migrated Anthropic API key in the secret store:', error);
	}

	// Remove the plaintext copy from each holding scope (resource-scoped for folder targets).
	for (const scope of present) {
		try {
			await scope.config.update('apiKey', undefined, scope.target);
		} catch (error) {
			console.error('Failed to remove plaintext quantlab.ai.apiKey from settings:', error);
		}
	}

	// Re-inspect every scope; any surviving plaintext (or a failed store) is still exposed -> loud.
	const stillExposed = rawApiKeyScopes().some(scope => scope.raw !== undefined);
	if (storeFailed || stillExposed) {
		void vscode.window.showErrorMessage(
			'Quantbook found your Anthropic API key in plaintext settings and could NOT fully secure it. '
			+ 'Delete the "quantlab.ai.apiKey" entry from your settings.json now -- it is exposed in plaintext.'
		);
	} else {
		void vscode.window.showInformationMessage(
			'Quantbook moved your Anthropic API key from plaintext settings into the OS secret store.'
		);
	}
}
