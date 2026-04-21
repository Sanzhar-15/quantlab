/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToastService } from '../notifications/ToastService';
import { OnboardingManager } from './OnboardingManager';

const VIEW_TIPS: Record<string, { title: string; message: string }> = {
	chart: { title: 'Chart view', message: 'Drop runs or symbols to compare results quickly.' },
	action: { title: 'Action view', message: 'Run backtests and export metrics from here.' },
	trade: { title: 'Trade view', message: 'Complete the checklist before live trading.' },
	editor: { title: 'Editor view', message: 'Edit strategy code and switch views from the header.' }
};

export class TooltipGuide {
	private readonly toastService = new ToastService();

	constructor(private readonly onboarding: OnboardingManager) { }

	showViewTip(view: string): void {
		const tip = VIEW_TIPS[view];
		if (!tip) {
			return;
		}

		const tipId = `tip.view.${view}`;
		if (!this.onboarding.shouldShowTip(tipId)) {
			return;
		}

		void this.toastService.showToast({
			id: tipId,
			kind: 'info',
			title: tip.title,
			message: tip.message,
			durationMs: 5000
		});
		this.onboarding.markTipDismissed(tipId);
	}
}
