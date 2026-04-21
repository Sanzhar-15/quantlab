/*---------------------------------------------------------------------------------------------
 *  Master Key Prompt.
 *
 *  Secure prompt for master key to unlock encrypted credentials.
 *
 *  Spec Reference: Technical Spec §12.3 (Safety Layer)
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'crypto';

/**
 * Master key state.
 */
export interface MasterKeyState {
	isUnlocked: boolean;
	unlockedAt?: Date;
	expiresAt?: Date;
	keyHash?: string;
}

/**
 * Master key configuration.
 */
export interface MasterKeyConfig {
	requireForLiveTrading: boolean;
	sessionTimeoutMinutes: number;
	requireConfirmation: boolean;
	allowBiometric: boolean;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: MasterKeyConfig = {
	requireForLiveTrading: true,
	sessionTimeoutMinutes: 30,
	requireConfirmation: true,
	allowBiometric: false,
};

/**
 * Master key prompt result.
 */
export interface MasterKeyResult {
	success: boolean;
	key?: string;
	cancelled: boolean;
	error?: string;
}

/**
 * Manages master key for secure credential access.
 *
 * The master key is used to:
 * - Decrypt stored API credentials
 * - Authorize live trading sessions
 * - Protect against unauthorized access
 */
export class MasterKeyPrompt {
	private static instance: MasterKeyPrompt | undefined;

	private config: MasterKeyConfig;
	private state: MasterKeyState;
	private cachedKey: string | undefined;
	private timeoutId: NodeJS.Timeout | undefined;

	private constructor(config?: Partial<MasterKeyConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.state = { isUnlocked: false };
	}

	/**
	 * Get singleton instance.
	 */
	static getInstance(config?: Partial<MasterKeyConfig>): MasterKeyPrompt {
		if (!MasterKeyPrompt.instance) {
			MasterKeyPrompt.instance = new MasterKeyPrompt(config);
		}
		return MasterKeyPrompt.instance;
	}

	/**
	 * Check if master key is required.
	 */
	get isRequired(): boolean {
		return this.config.requireForLiveTrading;
	}

	/**
	 * Check if currently unlocked.
	 */
	get isUnlocked(): boolean {
		if (!this.state.isUnlocked) {
			return false;
		}

		// Check expiration
		if (this.state.expiresAt && new Date() > this.state.expiresAt) {
			this.lock();
			return false;
		}

		return true;
	}

	/**
	 * Get current state.
	 */
	getState(): MasterKeyState {
		return { ...this.state };
	}

	/**
	 * Prompt for master key.
	 */
	async prompt(reason?: string): Promise<MasterKeyResult> {
		// If already unlocked, return success
		if (this.isUnlocked && this.cachedKey) {
			return {
				success: true,
				key: this.cachedKey,
				cancelled: false,
			};
		}

		const promptMessage = reason
			? vscode.l10n.t('Enter master key to {0}', reason)
			: vscode.l10n.t('Enter master key to access secure credentials');

		const key = await vscode.window.showInputBox({
			prompt: promptMessage,
			password: true,
			placeHolder: vscode.l10n.t('Master key'),
			ignoreFocusOut: true,
			validateInput: (value) => {
				if (!value || value.length < 8) {
					return vscode.l10n.t('Key must be at least 8 characters');
				}
				return undefined;
			},
		});

		if (!key) {
			return {
				success: false,
				cancelled: true,
			};
		}

		// Verify key if we have a stored hash
		if (this.state.keyHash) {
			const inputHash = this.hashKey(key);
			if (inputHash !== this.state.keyHash) {
				vscode.window.showErrorMessage(
					vscode.l10n.t('Incorrect master key')
				);
				return {
					success: false,
					cancelled: false,
					error: 'Incorrect key',
				};
			}
		}

		// Key accepted - unlock
		this.unlock(key);

		return {
			success: true,
			key,
			cancelled: false,
		};
	}

	/**
	 * Prompt to set up master key for first time.
	 */
	async promptSetup(): Promise<MasterKeyResult> {
		// Show explanation
		const proceed = await vscode.window.showInformationMessage(
			vscode.l10n.t(
				'Quantlab requires a master key to securely store your API credentials.\n\n' +
				'This key will be used to encrypt sensitive data like API keys.\n' +
				'You will need to enter it each time you start a live trading session.'
			),
			{ modal: true },
			vscode.l10n.t('Set Up Master Key'),
			vscode.l10n.t('Skip')
		);

		if (proceed !== vscode.l10n.t('Set Up Master Key')) {
			return {
				success: false,
				cancelled: true,
			};
		}

		// Get new key
		const key = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Create a master key (min 8 characters)'),
			password: true,
			placeHolder: vscode.l10n.t('Enter new master key'),
			ignoreFocusOut: true,
			validateInput: (value) => {
				if (!value || value.length < 8) {
					return vscode.l10n.t('Key must be at least 8 characters');
				}
				return undefined;
			},
		});

		if (!key) {
			return {
				success: false,
				cancelled: true,
			};
		}

		// Confirm key
		const confirm = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Confirm master key'),
			password: true,
			placeHolder: vscode.l10n.t('Re-enter master key'),
			ignoreFocusOut: true,
		});

		if (confirm !== key) {
			vscode.window.showErrorMessage(
				vscode.l10n.t('Keys do not match')
			);
			return {
				success: false,
				cancelled: false,
				error: 'Keys do not match',
			};
		}

		// Store hash and unlock
		this.state.keyHash = this.hashKey(key);
		this.unlock(key);

		vscode.window.showInformationMessage(
			vscode.l10n.t('Master key set successfully')
		);

		return {
			success: true,
			key,
			cancelled: false,
		};
	}

	/**
	 * Prompt for confirmation before live trading.
	 */
	async confirmLiveTrading(sessionInfo: {
		strategyName: string;
		symbol: string;
		broker: string;
	}): Promise<boolean> {
		if (!this.config.requireConfirmation) {
			return true;
		}

		// First ensure unlocked
		if (!this.isUnlocked) {
			const result = await this.prompt('authorize live trading');
			if (!result.success) {
				return false;
			}
		}

		// Show confirmation
		const confirmed = await vscode.window.showWarningMessage(
			vscode.l10n.t(
				'You are about to start LIVE TRADING:\n\n' +
				'Strategy: {0}\n' +
				'Symbol: {1}\n' +
				'Broker: {2}\n\n' +
				'Real money will be at risk. Continue?',
				sessionInfo.strategyName,
				sessionInfo.symbol,
				sessionInfo.broker
			),
			{ modal: true },
			vscode.l10n.t('Start Live Trading'),
			vscode.l10n.t('Cancel')
		);

		return confirmed === vscode.l10n.t('Start Live Trading');
	}

	/**
	 * Lock the master key.
	 */
	lock(): void {
		this.cachedKey = undefined;
		this.state.isUnlocked = false;
		this.state.unlockedAt = undefined;
		this.state.expiresAt = undefined;

		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
			this.timeoutId = undefined;
		}
	}

	/**
	 * Unlock with the provided key.
	 */
	private unlock(key: string): void {
		this.cachedKey = key;
		this.state.isUnlocked = true;
		this.state.unlockedAt = new Date();

		// Set expiration
		const expiresAt = new Date();
		expiresAt.setMinutes(expiresAt.getMinutes() + this.config.sessionTimeoutMinutes);
		this.state.expiresAt = expiresAt;

		// Set auto-lock timer
		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
		}
		this.timeoutId = setTimeout(() => {
			this.lock();
			vscode.window.showInformationMessage(
				vscode.l10n.t('Master key session expired')
			);
		}, this.config.sessionTimeoutMinutes * 60 * 1000);
	}

	/**
	 * Extend the session timeout.
	 */
	extendSession(): void {
		if (this.isUnlocked && this.cachedKey) {
			this.unlock(this.cachedKey);
		}
	}

	/**
	 * Hash a key for storage.
	 */
	private hashKey(key: string): string {
		return crypto
			.createHash('sha256')
			.update(key)
			.update('quantlab-master-key-salt')
			.digest('hex');
	}

	/**
	 * Derive encryption key from master key.
	 */
	deriveEncryptionKey(purpose: string): Buffer {
		if (!this.cachedKey) {
			throw new Error('Master key not unlocked');
		}

		return crypto.pbkdf2Sync(
			this.cachedKey,
			`quantlab-${purpose}`,
			100000,
			32,
			'sha256'
		);
	}

	/**
	 * Update configuration.
	 */
	updateConfig(config: Partial<MasterKeyConfig>): void {
		this.config = { ...this.config, ...config };
	}

	/**
	 * Check if master key has been set up.
	 */
	get isSetUp(): boolean {
		return !!this.state.keyHash;
	}

	/**
	 * Clear stored key hash (reset master key).
	 */
	reset(): void {
		this.lock();
		this.state.keyHash = undefined;
	}
}

/**
 * Register master key commands.
 */
export function registerMasterKeyCommands(context: vscode.ExtensionContext): void {
	const prompt = MasterKeyPrompt.getInstance();

	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.masterKey.setup', async () => {
			await prompt.promptSetup();
		}),

		vscode.commands.registerCommand('quantlab.masterKey.unlock', async () => {
			const result = await prompt.prompt();
			if (result.success) {
				vscode.window.showInformationMessage(
					vscode.l10n.t('Master key unlocked')
				);
			}
		}),

		vscode.commands.registerCommand('quantlab.masterKey.lock', () => {
			prompt.lock();
			vscode.window.showInformationMessage(
				vscode.l10n.t('Master key locked')
			);
		}),

		vscode.commands.registerCommand('quantlab.masterKey.extend', () => {
			if (prompt.isUnlocked) {
				prompt.extendSession();
				vscode.window.showInformationMessage(
					vscode.l10n.t('Master key session extended')
				);
			} else {
				vscode.window.showWarningMessage(
					vscode.l10n.t('Master key is not unlocked')
				);
			}
		}),

		vscode.commands.registerCommand('quantlab.masterKey.status', () => {
			const state = prompt.getState();
			if (state.isUnlocked) {
				const expires = state.expiresAt
					? state.expiresAt.toLocaleTimeString()
					: 'unknown';
				vscode.window.showInformationMessage(
					vscode.l10n.t('Master key is unlocked (expires at {0})', expires)
				);
			} else {
				vscode.window.showInformationMessage(
					vscode.l10n.t('Master key is locked')
				);
			}
		})
	);
}
