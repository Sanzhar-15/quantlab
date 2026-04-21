/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IQuickInputService, IQuickPickItem, IQuickInputButton, QuickPickInput } from '../../../../../platform/quickinput/common/quickInput.js';
import { IQicStateService } from '../../common/state/qicStateService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { localize } from '../../../../../nls.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';

/**
 * Checkpoint data structure
 */
export interface Checkpoint {
	id: string;
	timestamp: string;
	description?: string;
	files: string[];
	changeSetId?: string;
}

/**
 * Quick Pick item for checkpoints
 */
interface CheckpointQuickPickItem extends IQuickPickItem {
	checkpoint: Checkpoint;
}

/**
 * Checkpoints Quick Pick - shows available checkpoints for restore
 * Phase 3 - Prompt 03-03
 */
export class CheckpointQuickPick extends Disposable {
	constructor(
		private readonly quickInputService: IQuickInputService,
		private readonly stateService: IQicStateService,
		private readonly dialogService: IDialogService,
		private readonly notificationService: INotificationService,
		private readonly deleteCheckpoint?: (id: string) => Promise<void>,
	) {
		super();
	}

	async show(): Promise<{ action: 'restore' | 'delete'; checkpointId: string } | undefined> {
		const checkpoints = this.stateService.state.checkpoints || [];

		if (checkpoints.length === 0) {
			this.notificationService.info(
				localize('qic.checkpoints.empty', 'No checkpoints available. Checkpoints are created automatically when QIC makes changes.')
			);
			return undefined;
		}

		return new Promise((resolve) => {
			const picker = this.quickInputService.createQuickPick<CheckpointQuickPickItem>();

			picker.title = localize('qic.checkpoints.title', 'Checkpoints');
			picker.placeholder = localize('qic.checkpoints.placeholder', 'Select a checkpoint to restore...');
			picker.items = this.buildQuickPickItems(checkpoints);
			picker.sortByLabel = false;

			// Action buttons
			picker.onDidTriggerItemButton(async (e) => {
				const item = e.item as CheckpointQuickPickItem;
				const isDeleteButton = this.isDeleteButton(e.button);

				if (isDeleteButton) {
					await this.confirmDelete(item.checkpoint);
					// Refresh list
					const updatedCheckpoints = this.stateService.state.checkpoints || [];
					if (updatedCheckpoints.length === 0) {
						picker.dispose();
						resolve(undefined);
					} else {
						picker.items = this.buildQuickPickItems(updatedCheckpoints);
					}
				} else {
					// Preview button - show affected files
					await this.showCheckpointDetails(item.checkpoint);
				}
			});

			picker.onDidAccept(async () => {
				const selected = picker.selectedItems[0] as CheckpointQuickPickItem;
				if (selected?.checkpoint) {
					const confirmed = await this.confirmRestore(selected.checkpoint);
					if (confirmed) {
						resolve({ action: 'restore', checkpointId: selected.checkpoint.id });
					} else {
						resolve(undefined);
					}
				} else {
					resolve(undefined);
				}
				picker.dispose();
			});

			picker.onDidHide(() => {
				resolve(undefined);
				picker.dispose();
			});

			picker.show();
		});
	}

	private isDeleteButton(button: IQuickInputButton): boolean {
		return button.tooltip?.includes('Delete') ?? false;
	}

	private buildQuickPickItems(checkpoints: Checkpoint[]): CheckpointQuickPickItem[] {
		// Sort by timestamp descending (newest first)
		const sorted = [...checkpoints].sort(
			(a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
		);

		return sorted.map((checkpoint, index) => ({
			checkpoint,
			label: this.getCheckpointLabel(checkpoint, index),
			description: this.formatRelativeTime(new Date(checkpoint.timestamp)),
			detail: this.getCheckpointDetail(checkpoint),
			iconClass: ThemeIcon.asClassName(Codicon.history),
			buttons: [
				{
					iconClass: ThemeIcon.asClassName(Codicon.eye),
					tooltip: localize('qic.checkpoints.preview', 'Preview files'),
				},
				{
					iconClass: ThemeIcon.asClassName(Codicon.trash),
					tooltip: localize('qic.checkpoints.delete', 'Delete checkpoint'),
				},
			],
		}));
	}

	private getCheckpointLabel(checkpoint: Checkpoint, index: number): string {
		if (checkpoint.description) {
			return checkpoint.description;
		}
		if (checkpoint.changeSetId) {
			return localize('qic.checkpoints.beforeChange', 'Before change #{0}', checkpoint.changeSetId.substring(0, 8));
		}
		return localize('qic.checkpoints.checkpoint', 'Checkpoint #{0}', index + 1);
	}

	private getCheckpointDetail(checkpoint: Checkpoint): string {
		const fileCount = checkpoint.files.length;
		const fileWord = fileCount === 1 ? 'file' : 'files';

		if (fileCount === 0) {
			return 'No files';
		} else if (fileCount <= 3) {
			return `${fileCount} ${fileWord}: ${checkpoint.files.join(', ')}`;
		} else {
			const shown = checkpoint.files.slice(0, 2).join(', ');
			return `${fileCount} ${fileWord}: ${shown}, +${fileCount - 2} more`;
		}
	}

	private formatRelativeTime(date: Date): string {
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / (1000 * 60));
		const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

		if (diffMins < 1) {
			return localize('qic.time.justNow', 'Just now');
		} else if (diffMins < 60) {
			return localize('qic.time.minsAgo', '{0}m ago', diffMins);
		} else if (diffHours < 24) {
			return localize('qic.time.hoursAgo', '{0}h ago', diffHours);
		} else {
			return date.toLocaleString();
		}
	}

	private async showCheckpointDetails(checkpoint: Checkpoint): Promise<void> {
		const items: QuickPickInput[] = [
			{ type: 'separator', label: localize('qic.checkpoints.filesIncluded', 'Files in this checkpoint') },
			...checkpoint.files.map(file => ({
				label: file,
				iconClass: ThemeIcon.asClassName(Codicon.file),
			})),
		];

		if (items.length === 1) {
			// Only separator, no files
			items.push({
				label: localize('qic.checkpoints.noFiles', 'No files in this checkpoint'),
			});
		}

		const picker = this.quickInputService.createQuickPick();
		picker.title = checkpoint.description || localize('qic.checkpoints.details', 'Checkpoint Details');
		picker.placeholder = localize('qic.checkpoints.detailsPlaceholder', 'Files that will be restored');
		picker.items = items as any;
		picker.canSelectMany = false;

		picker.onDidAccept(() => {
			picker.dispose();
		});

		picker.onDidHide(() => {
			picker.dispose();
		});

		picker.show();
	}

	private async confirmRestore(checkpoint: Checkpoint): Promise<boolean> {
		const filesDisplay = checkpoint.files.slice(0, 5).join('\n') +
			(checkpoint.files.length > 5 ? `\n...and ${checkpoint.files.length - 5} more` : '');

		const result = await this.dialogService.confirm({
			message: localize('qic.checkpoints.confirmRestore', 'Restore checkpoint?'),
			detail: localize(
				'qic.checkpoints.confirmRestoreDetail',
				'This will restore {0} file(s) to their state from {1}. Current changes will be overwritten.\n\nFiles:\n{2}',
				checkpoint.files.length,
				new Date(checkpoint.timestamp).toLocaleString(),
				filesDisplay
			),
			primaryButton: localize('qic.checkpoints.restoreBtn', 'Restore'),
			type: 'warning',
		});

		return result.confirmed;
	}

	private async confirmDelete(checkpoint: Checkpoint): Promise<void> {
		const result = await this.dialogService.confirm({
			message: localize('qic.checkpoints.confirmDelete', 'Delete checkpoint?'),
			detail: localize(
				'qic.checkpoints.confirmDeleteDetail',
				'This checkpoint contains {0} file(s). This action cannot be undone.',
				checkpoint.files.length
			),
			primaryButton: localize('qic.checkpoints.deleteBtn', 'Delete'),
			type: 'warning',
		});

		if (result.confirmed) {
			try {
				this.stateService.removeCheckpoint(checkpoint.id);
				if (this.deleteCheckpoint) {
					await this.deleteCheckpoint(checkpoint.id);
				}
				this.notificationService.info(localize('qic.checkpoints.deleted', 'Checkpoint deleted.'));
			} catch {
				this.notificationService.error(localize('qic.checkpoints.deleteError', 'Failed to delete checkpoint.'));
			}
		}
	}
}

/**
 * Factory function for showing checkpoint Quick Pick
 */
export function showCheckpointQuickPick(
	quickInputService: IQuickInputService,
	stateService: IQicStateService,
	dialogService: IDialogService,
	notificationService: INotificationService,
	deleteCheckpoint?: (id: string) => Promise<void>,
): Promise<{ action: 'restore' | 'delete'; checkpointId: string } | undefined> {
	const picker = new CheckpointQuickPick(
		quickInputService,
		stateService,
		dialogService,
		notificationService,
		deleteCheckpoint
	);
	return picker.show();
}
