/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IQuickInputService, IQuickPickItem, QuickPickInput, IQuickPick, IQuickInputButton, IPickOptions } from '../../../../../platform/quickinput/common/quickInput.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IQicStateService } from '../../common/state/qicStateService.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';

/**
 * Extended Quick Pick item with QIC-specific properties
 */
export interface QicQuickPickItem extends IQuickPickItem {
	id?: string;
	action?: string;
	data?: unknown;
}

/**
 * Base Quick Pick handler for QIC
 * Provides common utilities for all QIC Quick Picks
 */
export class QicQuickPickHandler extends Disposable {
	constructor(
		private readonly quickInputService: IQuickInputService,
		private readonly stateService: IQicStateService,
	) {
		super();
	}

	/**
	 * Show a quick pick with QIC styling
	 */
	async showQuickPick<T extends QicQuickPickItem>(
		items: T[] | Promise<T[]>,
		options: {
			title: string;
			placeholder?: string;
			canPickMany?: boolean;
			matchOnDescription?: boolean;
			matchOnDetail?: boolean;
		}
	): Promise<T | undefined> {
		const pickOptions: IPickOptions<T> = {
			title: options.title,
			placeHolder: options.placeholder,
			canPickMany: options.canPickMany ?? false,
			matchOnDescription: options.matchOnDescription ?? true,
			matchOnDetail: options.matchOnDetail ?? true,
		} as any;
		return this.quickInputService.pick(items, pickOptions) as Promise<T | undefined>;
	}

	/**
	 * Show a quick pick with sections (using separators)
	 */
	async showQuickPickWithSections<T extends QicQuickPickItem>(
		sections: Array<{
			label: string;
			items: T[];
		}>,
		options: {
			title: string;
			placeholder?: string;
		}
	): Promise<T | undefined> {
		const items: QuickPickInput<T>[] = [];

		for (const section of sections) {
			if (section.items.length > 0) {
				// Add separator
				items.push({ type: 'separator', label: section.label });
				// Add items
				items.push(...section.items);
			}
		}

		if (items.length === 0) {
			return undefined;
		}

		return this.quickInputService.pick(items, {
			title: options.title,
			placeHolder: options.placeholder,
		}) as Promise<T | undefined>;
	}

	/**
	 * Create a quick pick with custom configuration
	 */
	createQuickPick<T extends IQuickPickItem>(): IQuickPick<T> {
		return this.quickInputService.createQuickPick<T>();
	}

	/**
	 * Format relative time for display
	 */
	formatRelativeTime(timestamp: string | number | Date): string {
		const date = new Date(timestamp);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) {
			return localize('qic.time.justNow', 'Just now');
		}
		if (diffMins < 60) {
			return localize('qic.time.minsAgo', '{0}m ago', diffMins);
		}
		if (diffHours < 24) {
			return localize('qic.time.hoursAgo', '{0}h ago', diffHours);
		}
		if (diffDays < 7) {
			return localize('qic.time.daysAgo', '{0}d ago', diffDays);
		}
		return date.toLocaleDateString();
	}

	/**
	 * Create a "no items" placeholder
	 */
	createEmptyItem(message: string): QicQuickPickItem {
		return {
			label: `$(info) ${message}`,
			description: '',
			alwaysShow: true,
		};
	}

	/**
	 * Create a standard delete button for Quick Pick items
	 */
	createDeleteButton(): IQuickInputButton {
		return {
			iconClass: ThemeIcon.asClassName(Codicon.trash),
			tooltip: localize('qic.quickPick.delete', 'Delete'),
		};
	}

	/**
	 * Create a standard export button for Quick Pick items
	 */
	createExportButton(): IQuickInputButton {
		return {
			iconClass: ThemeIcon.asClassName(Codicon.export),
			tooltip: localize('qic.quickPick.export', 'Export'),
		};
	}

	/**
	 * Create a standard restore button for Quick Pick items
	 */
	createRestoreButton(): IQuickInputButton {
		return {
			iconClass: ThemeIcon.asClassName(Codicon.discard),
			tooltip: localize('qic.quickPick.restore', 'Restore'),
		};
	}

	/**
	 * Get the state service for derived classes
	 */
	protected getStateService(): IQicStateService {
		return this.stateService;
	}
}
