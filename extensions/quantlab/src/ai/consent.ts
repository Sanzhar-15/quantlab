/*---------------------------------------------------------------------------------------------
 *  Consent Tracking
 *  Manages user consent for data sharing with AI providers
 *---------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConsentCategory, ConsentRecord } from './types';

/**
 * Consent manager for tracking user data sharing preferences.
 * Per Decision G37, explicit consent is required for certain data types.
 */
export class ConsentManager {
	private static instance: ConsentManager | undefined;

	private readonly storageKey = 'quantlab.ai.consent';
	private readonly sessionConsent: Map<string, Map<ConsentCategory, ConsentRecord>> = new Map();
	private globalState: vscode.Memento | undefined;

	private constructor() {}

	static getInstance(): ConsentManager {
		if (!ConsentManager.instance) {
			ConsentManager.instance = new ConsentManager();
		}
		return ConsentManager.instance;
	}

	/**
	 * Initialize with VS Code global state for persistence.
	 */
	initialize(globalState: vscode.Memento): void {
		this.globalState = globalState;
		this.loadPersistedConsent();
	}

	/**
	 * Check if user has consented to a data category.
	 */
	hasConsent(sessionId: string, category: ConsentCategory): boolean {
		// Check session-specific consent first
		const sessionConsents = this.sessionConsent.get(sessionId);
		if (sessionConsents?.has(category)) {
			return sessionConsents.get(category)!.granted;
		}

		// Fall back to global consent for implicit categories
		if (this.isImplicitCategory(category)) {
			return true;
		}

		return false;
	}

	/**
	 * Record user consent for a data category.
	 */
	async grantConsent(
		sessionId: string,
		category: ConsentCategory,
		persist: boolean = false
	): Promise<void> {
		const record: ConsentRecord = {
			category,
			granted: true,
			timestamp: new Date(),
			sessionId,
		};

		// Store in session
		if (!this.sessionConsent.has(sessionId)) {
			this.sessionConsent.set(sessionId, new Map());
		}
		this.sessionConsent.get(sessionId)!.set(category, record);

		// Optionally persist
		if (persist && this.globalState) {
			const persisted = this.getPersistedConsent();
			persisted[category] = true;
			await this.globalState.update(this.storageKey, persisted);
		}
	}

	/**
	 * Revoke consent for a data category.
	 */
	async revokeConsent(sessionId: string, category: ConsentCategory): Promise<void> {
		const sessionConsents = this.sessionConsent.get(sessionId);
		if (sessionConsents) {
			sessionConsents.delete(category);
		}

		// Also remove from persisted if exists
		if (this.globalState) {
			const persisted = this.getPersistedConsent();
			delete persisted[category];
			await this.globalState.update(this.storageKey, persisted);
		}
	}

	/**
	 * Prompt user for consent to share a data category.
	 */
	async promptForConsent(
		sessionId: string,
		category: ConsentCategory
	): Promise<boolean> {
		const message = this.getConsentMessage(category);
		const remember = vscode.l10n.t('Allow & Remember');
		const allowOnce = vscode.l10n.t('Allow Once');
		const deny = vscode.l10n.t('Deny');

		const selection = await vscode.window.showInformationMessage(
			message,
			{ modal: true },
			remember,
			allowOnce,
			deny
		);

		if (selection === remember) {
			await this.grantConsent(sessionId, category, true);
			return true;
		} else if (selection === allowOnce) {
			await this.grantConsent(sessionId, category, false);
			return true;
		}

		return false;
	}

	/**
	 * Clear all session consent.
	 */
	clearSessionConsent(sessionId: string): void {
		this.sessionConsent.delete(sessionId);
	}

	/**
	 * Get all consent records for a session.
	 */
	getSessionConsents(sessionId: string): ConsentRecord[] {
		const sessionConsents = this.sessionConsent.get(sessionId);
		if (!sessionConsents) {
			return [];
		}
		return Array.from(sessionConsents.values());
	}

	/**
	 * Categories that have implicit consent (user asks = consent).
	 */
	private isImplicitCategory(category: ConsentCategory): boolean {
		return category === 'strategy_code' || category === 'error_messages';
	}

	/**
	 * Get user-friendly consent message.
	 */
	private getConsentMessage(category: ConsentCategory): string {
		switch (category) {
			case 'strategy_code':
				return vscode.l10n.t(
					'Quantlab AI would like to include your strategy code in this request. Allow?'
				);
			case 'error_messages':
				return vscode.l10n.t(
					'Quantlab AI would like to include error messages in this request. Allow?'
				);
			case 'data_samples':
				return vscode.l10n.t(
					'Quantlab AI would like to include sample data from your dataset. This may include prices and dates. Allow?'
				);
			case 'performance_metrics':
				return vscode.l10n.t(
					'Quantlab AI would like to include performance metrics (returns, Sharpe ratio, etc.). Allow?'
				);
			default:
				return vscode.l10n.t('Quantlab AI requests access to additional data. Allow?');
		}
	}

	/**
	 * Load persisted consent preferences.
	 */
	private loadPersistedConsent(): void {
		// Persisted consent is loaded on-demand via getPersistedConsent()
	}

	/**
	 * Get persisted consent preferences.
	 */
	private getPersistedConsent(): Record<string, boolean> {
		if (!this.globalState) {
			return {};
		}
		return this.globalState.get<Record<string, boolean>>(this.storageKey, {});
	}
}

/**
 * Data categories that should NEVER be sent, regardless of consent.
 */
export const BLOCKED_CATEGORIES = [
	'broker_credentials',
	'trading_history',
	'personal_data',
	'api_keys',
] as const;

/**
 * Check if a category is blocked (never send).
 */
export function isBlockedCategory(category: string): boolean {
	return BLOCKED_CATEGORIES.includes(category as typeof BLOCKED_CATEGORIES[number]);
}
