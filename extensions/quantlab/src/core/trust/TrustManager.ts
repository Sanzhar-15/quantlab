/*---------------------------------------------------------------------------------------------
 *  Trust Manager.
 *
 *  Manages workspace and strategy trust for live trading safety.
 *
 *  Spec Reference: Technical Spec §12.3 (Safety Layer)
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { EventEmitter } from 'events';
import type TypedEmitter from 'typed-emitter';
import type {
	TrustLevel,
	WorkspaceTrust,
	StrategyTrust,
	TrustVerificationResult,
	TrustPromptOptions,
	TrustPromptResult,
	TrustStoreEntry,
	TrustManagerEvents,
} from './types';

/**
 * Trust schema version. Bump on structural changes to trigger
 * strategy trust re-verification (NEW-SEC-004).
 */
const TRUST_SCHEMA_VERSION = 1;

/**
 * Get per-workspace trust store key (NEW-SEC-003).
 *
 * Each workspace gets its own trust store to prevent a malicious
 * workspace from inheriting trust granted to a legitimate one.
 */
function getTrustStoreKey(): string {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		const workspaceId = crypto.createHash('sha256')
			.update(workspaceFolders[0].uri.toString())
			.digest('hex')
			.substring(0, 16);
		return `quantlab.trustStore.${workspaceId}`;
	}
	return 'quantlab.trustStore.global';
}

/**
 * Manages trust for workspaces and strategies.
 *
 * Key safety features:
 * - Workspaces must be explicitly trusted before live trading
 * - Strategies are hashed to detect modifications
 * - Trust can be revoked at any time
 * - Verification required before each live session
 */
export class TrustManager extends (EventEmitter as new () => TypedEmitter<TrustManagerEvents>) {
	private static instance: TrustManager | undefined;

	private readonly workspaceTrust: Map<string, WorkspaceTrust> = new Map();
	private readonly strategyTrust: Map<string, StrategyTrust> = new Map();
	private context: vscode.ExtensionContext | undefined;

	private constructor() {
		super();
	}

	/**
	 * Get singleton instance.
	 */
	static getInstance(): TrustManager {
		if (!TrustManager.instance) {
			TrustManager.instance = new TrustManager();
		}
		return TrustManager.instance;
	}

	/**
	 * Initialize trust manager with extension context.
	 */
	async initialize(context: vscode.ExtensionContext): Promise<void> {
		this.context = context;
		await this.loadTrustStore();

		// Watch for file changes to detect strategy modifications
		const watcher = vscode.workspace.createFileSystemWatcher('**/*.py');
		watcher.onDidChange(uri => this.onStrategyFileChanged(uri));
		watcher.onDidDelete(uri => this.onStrategyFileDeleted(uri));

		context.subscriptions.push(watcher);
	}

	// ============================================================
	// Workspace Trust
	// ============================================================

	/**
	 * Check if a workspace is trusted.
	 */
	isWorkspaceTrusted(workspaceUri: string): boolean {
		const normalizedUri = this.normalizeUri(workspaceUri);
		const trust = this.workspaceTrust.get(normalizedUri);
		return trust?.trusted ?? false;
	}

	/**
	 * Trust a workspace.
	 */
	async trustWorkspace(workspaceUri: string): Promise<void> {
		const normalizedUri = this.normalizeUri(workspaceUri);
		const previousTrust = this.workspaceTrust.get(normalizedUri);

		const trust: WorkspaceTrust = {
			workspaceUri: normalizedUri,
			trusted: true,
			trustedAt: Date.now(),
			trustedBy: 'user',
		};

		this.workspaceTrust.set(normalizedUri, trust);
		await this.saveTrustStore();

		this.emit('trust.changed', {
			type: 'workspace',
			uri: normalizedUri,
			previousTrust: previousTrust?.trusted ? 'trusted' : 'untrusted',
			newTrust: 'trusted',
			timestamp: Date.now(),
		});
	}

	/**
	 * Revoke workspace trust.
	 */
	async revokeWorkspaceTrust(workspaceUri: string): Promise<void> {
		const normalizedUri = this.normalizeUri(workspaceUri);
		this.workspaceTrust.delete(normalizedUri);

		// Also revoke all strategy trust in this workspace
		for (const [key, strategy] of this.strategyTrust) {
			if (strategy.workspaceUri === normalizedUri) {
				this.strategyTrust.delete(key);
			}
		}

		await this.saveTrustStore();
		this.emit('trust.revoked', normalizedUri);
	}

	/**
	 * Prompt user to trust a workspace.
	 */
	async promptWorkspaceTrust(workspaceUri: string): Promise<boolean> {
		const workspaceName = path.basename(workspaceUri);

		const result = await vscode.window.showWarningMessage(
			vscode.l10n.t(
				'Do you trust the authors of this workspace ({0})? Live trading requires workspace trust.',
				workspaceName
			),
			{ modal: true },
			vscode.l10n.t('Trust Workspace'),
			vscode.l10n.t('Cancel')
		);

		if (result === vscode.l10n.t('Trust Workspace')) {
			await this.trustWorkspace(workspaceUri);
			return true;
		}

		return false;
	}

	// ============================================================
	// Strategy Trust
	// ============================================================

	/**
	 * Check if a strategy is trusted.
	 */
	isStrategyTrusted(strategyPath: string): boolean {
		const normalizedPath = this.normalizePath(strategyPath);
		const trust = this.strategyTrust.get(normalizedPath);
		return trust?.trustLevel === 'trusted' || trust?.trustLevel === 'verified';
	}

	/**
	 * Get strategy trust level.
	 */
	getStrategyTrustLevel(strategyPath: string): TrustLevel {
		const normalizedPath = this.normalizePath(strategyPath);
		return this.strategyTrust.get(normalizedPath)?.trustLevel ?? 'untrusted';
	}

	/**
	 * Trust a strategy.
	 */
	async trustStrategy(strategyPath: string, workspaceUri: string): Promise<void> {
		const normalizedPath = this.normalizePath(strategyPath);
		const normalizedWorkspace = this.normalizeUri(workspaceUri);

		// Workspace must be trusted first
		if (!this.isWorkspaceTrusted(normalizedWorkspace)) {
			throw new Error('Workspace must be trusted before trusting strategies');
		}

		// Calculate file hash
		const hash = await this.calculateFileHash(strategyPath);

		const previousTrust = this.strategyTrust.get(normalizedPath);

		const trust: StrategyTrust = {
			strategyPath: normalizedPath,
			workspaceUri: normalizedWorkspace,
			trustLevel: 'trusted',
			trustedAt: Date.now(),
			hash,
			lastVerifiedAt: Date.now(),
			lastVerifiedHash: hash,
		};

		this.strategyTrust.set(normalizedPath, trust);
		await this.saveTrustStore();

		this.emit('trust.changed', {
			type: 'strategy',
			uri: normalizedPath,
			previousTrust: previousTrust?.trustLevel ?? 'untrusted',
			newTrust: 'trusted',
			timestamp: Date.now(),
		});
	}

	/**
	 * Revoke strategy trust.
	 */
	async revokeStrategyTrust(strategyPath: string): Promise<void> {
		const normalizedPath = this.normalizePath(strategyPath);
		this.strategyTrust.delete(normalizedPath);
		await this.saveTrustStore();
		this.emit('trust.revoked', normalizedPath);
	}

	/**
	 * Verify a strategy's integrity.
	 */
	async verifyStrategy(strategyPath: string): Promise<TrustVerificationResult> {
		const normalizedPath = this.normalizePath(strategyPath);
		const trust = this.strategyTrust.get(normalizedPath);

		// Check if strategy is trusted
		if (!trust || trust.trustLevel === 'untrusted') {
			return {
				isValid: false,
				reason: 'Strategy is not trusted',
			};
		}

		// Check if workspace is still trusted
		if (!this.isWorkspaceTrusted(trust.workspaceUri)) {
			return {
				isValid: false,
				reason: 'Workspace trust has been revoked',
				workspaceUntrusted: true,
			};
		}

		// Verify file hash
		const currentHash = await this.calculateFileHash(strategyPath);
		if (currentHash !== trust.hash) {
			return {
				isValid: false,
				reason: 'Strategy file has been modified since it was trusted',
				hashMismatch: true,
			};
		}

		// Update last verified timestamp
		trust.lastVerifiedAt = Date.now();
		trust.lastVerifiedHash = currentHash;
		await this.saveTrustStore();

		return { isValid: true };
	}

	/**
	 * Prompt user to trust a strategy.
	 */
	async promptStrategyTrust(options: TrustPromptOptions): Promise<TrustPromptResult> {
		const strategyName = path.basename(options.strategyPath);

		// First check workspace trust
		if (!this.isWorkspaceTrusted(options.workspaceUri)) {
			const workspaceTrusted = await this.promptWorkspaceTrust(options.workspaceUri);
			if (!workspaceTrusted) {
				return { trusted: false, remember: false, cancelled: true };
			}
		}

		const choices = [
			vscode.l10n.t('Trust & Enable Live Trading'),
			vscode.l10n.t('View Strategy Code'),
			vscode.l10n.t('Cancel'),
		];

		const result = await vscode.window.showWarningMessage(
			vscode.l10n.t(
				'Do you trust this strategy ({0}) for live trading? This will allow it to execute real trades.',
				strategyName
			),
			{ modal: true },
			...choices
		);

		if (result === choices[0]) {
			await this.trustStrategy(options.strategyPath, options.workspaceUri);
			return { trusted: true, remember: true, cancelled: false };
		}

		if (result === choices[1]) {
			// Open strategy file for review
			const doc = await vscode.workspace.openTextDocument(options.strategyPath);
			await vscode.window.showTextDocument(doc);
			return { trusted: false, remember: false, cancelled: false };
		}

		return { trusted: false, remember: false, cancelled: true };
	}

	// ============================================================
	// Pre-Trade Verification
	// ============================================================

	/**
	 * Perform full pre-trade verification.
	 *
	 * This must be called before starting any live trading session.
	 */
	async verifyForLiveTrading(
		strategyPath: string,
		workspaceUri: string
	): Promise<TrustVerificationResult> {
		// Check workspace trust
		if (!this.isWorkspaceTrusted(workspaceUri)) {
			return {
				isValid: false,
				reason: 'Workspace is not trusted',
				workspaceUntrusted: true,
			};
		}

		// Check VS Code workspace trust
		if (!vscode.workspace.isTrusted) {
			return {
				isValid: false,
				reason: 'VS Code workspace trust is required for live trading',
			};
		}

		// Verify strategy
		const strategyVerification = await this.verifyStrategy(strategyPath);
		if (!strategyVerification.isValid) {
			return strategyVerification;
		}

		return { isValid: true };
	}

	/**
	 * Full pre-trade verification with prompts.
	 */
	async verifyForLiveTradingWithPrompts(
		strategyPath: string,
		workspaceUri: string
	): Promise<TrustVerificationResult> {
		// First try automatic verification
		let result = await this.verifyForLiveTrading(strategyPath, workspaceUri);

		if (result.isValid) {
			return result;
		}

		// Handle workspace trust
		if (result.workspaceUntrusted) {
			const trusted = await this.promptWorkspaceTrust(workspaceUri);
			if (!trusted) {
				return result;
			}
			result = await this.verifyForLiveTrading(strategyPath, workspaceUri);
		}

		// Handle strategy trust or modification
		if (!result.isValid && (result.hashMismatch || !this.isStrategyTrusted(strategyPath))) {
			const message = result.hashMismatch
				? vscode.l10n.t(
						'The strategy file has been modified. Do you want to trust the updated version?'
				  )
				: vscode.l10n.t('This strategy is not trusted. Trust it for live trading?');

			const choice = await vscode.window.showWarningMessage(
				message,
				{ modal: true },
				vscode.l10n.t('Trust Strategy'),
				vscode.l10n.t('Cancel')
			);

			if (choice === vscode.l10n.t('Trust Strategy')) {
				await this.trustStrategy(strategyPath, workspaceUri);
				result = await this.verifyForLiveTrading(strategyPath, workspaceUri);
			}
		}

		return result;
	}

	// ============================================================
	// File Watching
	// ============================================================

	/**
	 * Handle strategy file changes.
	 */
	private async onStrategyFileChanged(uri: vscode.Uri): Promise<void> {
		const normalizedPath = this.normalizePath(uri.fsPath);
		const trust = this.strategyTrust.get(normalizedPath);

		if (trust && trust.trustLevel !== 'untrusted') {
			// Mark as needing re-verification
			const newHash = await this.calculateFileHash(uri.fsPath);
			if (newHash !== trust.hash) {
				// Hash changed - mark as potentially compromised
				trust.trustLevel = 'untrusted';
				await this.saveTrustStore();

				vscode.window.showWarningMessage(
					vscode.l10n.t(
						'Strategy {0} has been modified. Trust verification required before live trading.',
						path.basename(uri.fsPath)
					)
				);

				this.emit('trust.changed', {
					type: 'strategy',
					uri: normalizedPath,
					previousTrust: 'trusted',
					newTrust: 'untrusted',
					timestamp: Date.now(),
				});

				// NEW-UI-002: Hot-reload flow — check if a live session uses this strategy
				this.showHotReloadDialogIfNeeded(uri.fsPath);
			}
		}
	}

	/**
	 * Show hot-reload dialog if a live session is using the changed strategy (NEW-UI-002).
	 */
	private async showHotReloadDialogIfNeeded(strategyPath: string): Promise<void> {
		// Guard: deactivation may have reset the instance between the file-watch event firing and this async resumption
		if (!TrustManager.instance) {
			return;
		}
		const { SessionManager } = await import('../trading/SessionManager');
		// Re-check after the dynamic import await — deactivation could have run during the import
		if (!TrustManager.instance) {
			return;
		}
		let sessionManager: ReturnType<typeof SessionManager.getInstance>;
		try {
			sessionManager = SessionManager.getInstance();
		} catch {
			return; // SessionManager was reset during deactivation
		}
		const affectedSession = sessionManager.getSessionForStrategy?.(strategyPath);

		if (!affectedSession || affectedSession.type !== 'live') {
			return;
		}

		const action = await vscode.window.showWarningMessage(
			`Strategy file changed while live session "${affectedSession.id}" is running. ` +
			'The strategy trust has been revoked.',
			'Pause Session', 'Stop Session', 'Dismiss'
		);

		if (action === 'Pause Session') {
			try {
				await sessionManager.pauseSession(affectedSession.id);
				void vscode.window.showInformationMessage(
					`Session ${affectedSession.id} paused. Review changes and resume when ready.`
				);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				void vscode.window.showErrorMessage(`Failed to pause session: ${msg}`);
			}
		} else if (action === 'Stop Session') {
			try {
				await sessionManager.stopSession(affectedSession.id);
			} catch { /* best effort */ }
		}
	}

	/**
	 * Handle strategy file deletion.
	 */
	private onStrategyFileDeleted(uri: vscode.Uri): void {
		const normalizedPath = this.normalizePath(uri.fsPath);
		if (this.strategyTrust.has(normalizedPath)) {
			this.strategyTrust.delete(normalizedPath);
			this.saveTrustStore();
			this.emit('trust.revoked', normalizedPath);
		}
	}

	// ============================================================
	// Persistence
	// ============================================================

	/**
	 * Load trust store from global state (NEW-SEC-003: per-workspace).
	 */
	private async loadTrustStore(): Promise<void> {
		if (!this.context) {
			return;
		}

		const key = getTrustStoreKey();
		const stored = this.context.globalState.get<{ schemaVersion?: number; entries: TrustStoreEntry[] }>(key);

		if (!stored) {
			return;
		}

		// NEW-SEC-004: Check schema version on extension update
		if (stored.schemaVersion !== TRUST_SCHEMA_VERSION) {
			console.log(
				`Trust store schema version changed (${stored.schemaVersion} -> ${TRUST_SCHEMA_VERSION}), ` +
				'strategy trust re-verification required'
			);
			// Load workspace trust but clear strategy trust to force re-verification
			for (const entry of stored.entries) {
				if (entry.type === 'workspace') {
					this.workspaceTrust.set(entry.uri, {
						workspaceUri: entry.uri,
						trusted: entry.trustLevel !== 'untrusted',
						trustedAt: entry.trustedAt,
						hash: entry.hash,
					});
				}
			}
			// Save with new schema version and cleared strategies
			await this.saveTrustStore();
			return;
		}

		for (const entry of stored.entries) {
			if (entry.type === 'workspace') {
				this.workspaceTrust.set(entry.uri, {
					workspaceUri: entry.uri,
					trusted: entry.trustLevel !== 'untrusted',
					trustedAt: entry.trustedAt,
					hash: entry.hash,
				});
			} else if (entry.type === 'strategy') {
				this.strategyTrust.set(entry.uri, {
					strategyPath: entry.uri,
					workspaceUri: '',
					trustLevel: entry.trustLevel,
					trustedAt: entry.trustedAt,
					hash: entry.hash ?? '',
				});
			}
		}
	}

	/**
	 * Save trust store to global state (NEW-SEC-003: per-workspace, NEW-SEC-004: versioned).
	 */
	private async saveTrustStore(): Promise<void> {
		if (!this.context) {
			return;
		}

		const entries: TrustStoreEntry[] = [];

		for (const [uri, trust] of this.workspaceTrust) {
			entries.push({
				type: 'workspace',
				uri,
				trustLevel: trust.trusted ? 'trusted' : 'untrusted',
				trustedAt: trust.trustedAt ?? Date.now(),
			});
		}

		for (const [uri, trust] of this.strategyTrust) {
			entries.push({
				type: 'strategy',
				uri,
				trustLevel: trust.trustLevel,
				hash: trust.hash,
				trustedAt: trust.trustedAt ?? Date.now(),
			});
		}

		const key = getTrustStoreKey();
		await this.context.globalState.update(key, {
			schemaVersion: TRUST_SCHEMA_VERSION,
			entries,
		});
	}

	// ============================================================
	// Utilities
	// ============================================================

	/**
	 * Calculate SHA-256 hash of a file.
	 */
	private async calculateFileHash(filePath: string): Promise<string> {
		const uri = vscode.Uri.file(filePath);
		const content = await vscode.workspace.fs.readFile(uri);
		return crypto.createHash('sha256').update(content).digest('hex');
	}

	/**
	 * Normalize URI for consistent storage.
	 */
	private normalizeUri(uri: string): string {
		return vscode.Uri.parse(uri).toString();
	}

	/**
	 * Normalize file path.
	 */
	private normalizePath(filePath: string): string {
		const normalized = path.normalize(filePath);
		// Only lowercase on Windows (case-insensitive FS); Linux paths are case-sensitive
		return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
	}

	/**
	 * Get all trusted workspaces.
	 */
	getTrustedWorkspaces(): WorkspaceTrust[] {
		return Array.from(this.workspaceTrust.values()).filter(w => w.trusted);
	}

	/**
	 * Get all trusted strategies.
	 */
	getTrustedStrategies(): StrategyTrust[] {
		return Array.from(this.strategyTrust.values()).filter(
			s => s.trustLevel === 'trusted' || s.trustLevel === 'verified'
		);
	}

	/**
	 * Clear all trust (for testing).
	 */
	async clearAllTrust(): Promise<void> {
		this.workspaceTrust.clear();
		this.strategyTrust.clear();
		await this.saveTrustStore();
	}

	dispose(): void {
		this.workspaceTrust.clear();
		this.strategyTrust.clear();
		this.removeAllListeners();
	}

	static resetInstance(): void {
		if (TrustManager.instance) {
			TrustManager.instance.dispose();
			TrustManager.instance = undefined;
		}
	}
}

/**
 * Register trust commands.
 */
export function registerTrustCommands(context: vscode.ExtensionContext): void {
	const trustManager = TrustManager.getInstance();

	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.trust.workspace', async () => {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (workspaceFolder) {
				await trustManager.promptWorkspaceTrust(workspaceFolder.uri.toString());
			}
		}),

		vscode.commands.registerCommand('quantlab.trust.revokeWorkspace', async () => {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (workspaceFolder) {
				await trustManager.revokeWorkspaceTrust(workspaceFolder.uri.toString());
				vscode.window.showInformationMessage(
					vscode.l10n.t('Workspace trust revoked')
				);
			}
		}),

		vscode.commands.registerCommand('quantlab.trust.strategy', async (uri?: vscode.Uri) => {
			const strategyUri = uri ?? vscode.window.activeTextEditor?.document.uri;
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

			if (strategyUri && workspaceFolder) {
				await trustManager.promptStrategyTrust({
					strategyPath: strategyUri.fsPath,
					workspaceUri: workspaceFolder.uri.toString(),
				});
			}
		}),

		vscode.commands.registerCommand('quantlab.trust.revokeStrategy', async (uri?: vscode.Uri) => {
			const strategyUri = uri ?? vscode.window.activeTextEditor?.document.uri;

			if (strategyUri) {
				await trustManager.revokeStrategyTrust(strategyUri.fsPath);
				vscode.window.showInformationMessage(
					vscode.l10n.t('Strategy trust revoked')
				);
			}
		}),

		vscode.commands.registerCommand('quantlab.trust.showTrusted', async () => {
			const workspaces = trustManager.getTrustedWorkspaces();
			const strategies = trustManager.getTrustedStrategies();

			const items: vscode.QuickPickItem[] = [
				{ label: 'Trusted Workspaces', kind: vscode.QuickPickItemKind.Separator },
				...workspaces.map(w => ({
					label: path.basename(w.workspaceUri),
					description: w.workspaceUri,
				})),
				{ label: 'Trusted Strategies', kind: vscode.QuickPickItemKind.Separator },
				...strategies.map(s => ({
					label: path.basename(s.strategyPath),
					description: s.strategyPath,
				})),
			];

			await vscode.window.showQuickPick(items, {
				title: vscode.l10n.t('Trusted Items'),
				placeHolder: vscode.l10n.t('Select to manage trust'),
			});
		})
	);
}
