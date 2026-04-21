/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { OnboardingState } from '../../types/onboarding';
import { WelcomeAction, WelcomeModal } from './WelcomeModal';

const STORAGE_KEY = 'quantlab.onboarding';

const DEFAULT_STATE: OnboardingState = {
	hasSeenWelcome: false,
	skippedTour: false,
	dismissedTips: []
};

export class OnboardingManager {
	private static instance: OnboardingManager | undefined;

	private disposed = false;
	private state: OnboardingState;

	private constructor(private readonly context: vscode.ExtensionContext) {
		this.state = this.restoreState();
		if (!this.state.hasSeenWelcome) {
			void this.showWelcome();
		}
	}

	static initialize(context: vscode.ExtensionContext): OnboardingManager {
		if (!OnboardingManager.instance) {
			OnboardingManager.instance = new OnboardingManager(context);
		}
		return OnboardingManager.instance;
	}

	static getInstance(): OnboardingManager {
		if (!OnboardingManager.instance) {
			throw new Error('OnboardingManager not initialized');
		}
		return OnboardingManager.instance;
	}

	static resetInstance(): void {
		if (OnboardingManager.instance) {
			OnboardingManager.instance.disposed = true;
			OnboardingManager.instance = undefined;
		}
	}

	getState(): OnboardingState {
		return { ...this.state, dismissedTips: [...this.state.dismissedTips] };
	}

	shouldShowTip(id: string): boolean {
		if (this.state.skippedTour) {
			return false;
		}
		return !this.state.dismissedTips.includes(id);
	}

	markTipDismissed(id: string): void {
		if (this.state.dismissedTips.includes(id)) {
			return;
		}
		this.state = {
			...this.state,
			dismissedTips: [...this.state.dismissedTips, id]
		};
		this.persistState();
	}

	private async showWelcome(): Promise<void> {
		const action = await WelcomeModal.show(this.context);
		if (this.disposed) { return; }
		this.state = {
			...this.state,
			hasSeenWelcome: true,
			skippedTour: action === 'skip' || this.state.skippedTour,
			lastStep: 'welcome'
		};
		this.persistState();

		if (!action) {
			return;
		}

		await this.handleAction(action);
	}

	private async handleAction(action: WelcomeAction): Promise<void> {
		if (action === 'template') {
			await vscode.commands.executeCommand('quantlab.newFromTemplate');
			return;
		}

		if (action === 'open') {
			await vscode.commands.executeCommand('workbench.action.files.openFile');
		}
	}

	private restoreState(): OnboardingState {
		const stored = this.context.globalState.get<OnboardingState>(STORAGE_KEY);
		if (!stored) {
			return { ...DEFAULT_STATE };
		}

		return {
			hasSeenWelcome: Boolean(stored.hasSeenWelcome),
			skippedTour: Boolean(stored.skippedTour),
			dismissedTips: Array.isArray(stored.dismissedTips) ? stored.dismissedTips.slice() : [],
			lastStep: stored.lastStep
		};
	}

	private persistState(): void {
		if (this.disposed) { return; }
		void this.context.globalState.update(STORAGE_KEY, this.state);
	}
}
