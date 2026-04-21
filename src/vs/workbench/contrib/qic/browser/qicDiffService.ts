/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5: Diff View - Diff Service
 * Prompt 05-02
 *
 * Service for opening and managing QIC diff views in VS Code's native diff editor.
 */

import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IQicStateService } from '../common/state/qicStateService.js';
import { IContextKeyService, IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { QIC_ORIGINAL_SCHEME, QIC_MODIFIED_SCHEME } from './diffDocumentProvider.js';
import type { FileChange } from '../common/changes.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IQicDiffService = createDecorator<IQicDiffService>('qicDiffService');

export interface IQicDiffService {
	readonly _serviceBrand: undefined;

	/**
	 * Show diff for a change by ID.
	 */
	showDiff(changeId: string): Promise<void>;

	/**
	 * Show diff for a change object.
	 */
	showDiffForChange(change: FileChange): Promise<void>;

	/**
	 * Close the currently open diff view.
	 */
	closeDiff(): Promise<void>;

	/**
	 * Get the change ID of the currently open diff, if any.
	 */
	getCurrentDiffChangeId(): string | undefined;
}

/**
 * QIC Diff Service implementation.
 * Opens VS Code's native diff editor with virtual documents for original/modified content.
 */
export class QicDiffService extends Disposable implements IQicDiffService {
	readonly _serviceBrand: undefined;

	private readonly inDiffViewKey: IContextKey<boolean>;
	private currentChangeId: string | undefined;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IQicStateService private readonly stateService: IQicStateService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		// Create context key for tracking when user is in QIC diff view
		this.inDiffViewKey = contextKeyService.createKey('qic.inDiffView', false);

		// Track active editor changes to update context
		this._register(
			this.editorService.onDidActiveEditorChange(() => {
				this.updateDiffContext();
			})
		);
	}

	/**
	 * Show diff for a change by ID.
	 */
	async showDiff(changeId: string): Promise<void> {
		const change = this.findChange(changeId);
		if (!change) {
			throw new Error(`Change not found: ${changeId}`);
		}
		await this.showDiffForChange(change);
	}

	/**
	 * Show diff for a change object.
	 */
	async showDiffForChange(change: FileChange): Promise<void> {
		const originalUri = this.getOriginalUri(change);
		const modifiedUri = this.getModifiedUri(change);

		const title = this.getDiffTitle(change);
		const description = this.getDiffDescription(change);

		this.currentChangeId = change.id;

		// Open diff editor using VS Code's native infrastructure
		await this.editorService.openEditor({
			original: { resource: originalUri },
			modified: { resource: modifiedUri },
			label: title,
			description,
			options: {
				pinned: false,
				preserveFocus: false,
			}
		});

		this.updateDiffContext();
	}

	/**
	 * Close the currently open diff view.
	 */
	async closeDiff(): Promise<void> {
		const activeEditor = this.editorService.activeEditor;
		if (activeEditor && this.isQicDiffEditor(activeEditor)) {
			await this.editorService.closeEditor({ editor: activeEditor, groupId: this.editorService.activeEditorPane?.group?.id ?? 0 });
		}
		this.currentChangeId = undefined;
		this.inDiffViewKey.set(false);
	}

	/**
	 * Get the change ID of the currently open diff.
	 */
	getCurrentDiffChangeId(): string | undefined {
		return this.currentChangeId;
	}

	/**
	 * Build URI for the original (before change) document.
	 */
	private getOriginalUri(change: FileChange): URI {
		if (change.type === 'create') {
			// New file - show empty original
			return URI.from({
				scheme: QIC_ORIGINAL_SCHEME,
				path: `/${change.id}`,
				query: 'empty=true'
			});
		}

		return URI.from({
			scheme: QIC_ORIGINAL_SCHEME,
			path: `/${change.id}`
		});
	}

	/**
	 * Build URI for the modified (after change) document.
	 */
	private getModifiedUri(change: FileChange): URI {
		if (change.type === 'delete') {
			// Deleted file - show empty modified
			return URI.from({
				scheme: QIC_MODIFIED_SCHEME,
				path: `/${change.id}`,
				query: 'empty=true'
			});
		}

		return URI.from({
			scheme: QIC_MODIFIED_SCHEME,
			path: `/${change.id}`
		});
	}

	/**
	 * Get the title for the diff editor tab.
	 */
	private getDiffTitle(change: FileChange): string {
		const filename = change.path.split('/').pop() || change.path;

		switch (change.type) {
			case 'create':
				return `${filename} (New File)`;
			case 'delete':
				return `${filename} (Delete)`;
			case 'rename':
				const newFilename = change.newPath?.split('/').pop() || change.newPath;
				return `${filename} → ${newFilename}`;
			default:
				return filename;
		}
	}

	/**
	 * Get the description for the diff editor (shows in tab tooltip).
	 */
	private getDiffDescription(change: FileChange): string {
		return `QIC: +${change.additions || 0} -${change.deletions || 0}`;
	}

	/**
	 * Find a change by ID across all change sets.
	 */
	private findChange(changeId: string): FileChange | undefined {
		const state = this.stateService.state as any;

		// Check conversation.pendingChanges
		const pendingChanges = state.conversation?.pendingChanges?.changes;
		if (pendingChanges && Array.isArray(pendingChanges)) {
			const found = pendingChanges.find((c: FileChange) => c.id === changeId);
			if (found) return found;
		}

		// Check changeSets array if it exists
		const changeSets = state.changeSets;
		if (changeSets && Array.isArray(changeSets)) {
			for (const changeSet of changeSets) {
				const change = changeSet.changes?.find((c: FileChange) => c.id === changeId);
				if (change) return change;
			}
		}

		return undefined;
	}

	/**
	 * Check if an editor is a QIC diff editor.
	 */
	private isQicDiffEditor(editor: any): boolean {
		// Check if the editor input has our custom schemes
		const modifiedResource = editor?.modified?.resource || editor?.resource;
		if (modifiedResource) {
			return modifiedResource.scheme === QIC_MODIFIED_SCHEME ||
				modifiedResource.scheme === QIC_ORIGINAL_SCHEME;
		}
		return false;
	}

	/**
	 * Update the qic.inDiffView context key based on active editor.
	 */
	private updateDiffContext(): void {
		const activeEditor = this.editorService.activeEditor;
		const isInQicDiff = activeEditor ? this.isQicDiffEditor(activeEditor) : false;
		this.inDiffViewKey.set(isInQicDiff);

		// Update current change ID if we're in a diff view
		if (isInQicDiff && activeEditor) {
			const modifiedResource = (activeEditor as any)?.modified?.resource;
			if (modifiedResource?.scheme === QIC_MODIFIED_SCHEME) {
				this.currentChangeId = modifiedResource.path.substring(1);
			}
		}
	}
}

/**
 * Generate a unified diff string from a FileChange.
 * Used for inline preview in the chat panel.
 */
export function generateUnifiedDiff(change: FileChange): string {
	if (!change.hunks || change.hunks.length === 0) {
		// No hunks - generate simple diff header
		if (change.type === 'create') {
			return `--- /dev/null\n+++ b/${change.path}\n@@ -0,0 +1 @@\n+[New file]`;
		}
		if (change.type === 'delete') {
			return `--- a/${change.path}\n+++ /dev/null\n@@ -1 +0,0 @@\n-[File deleted]`;
		}
		return '';
	}

	const header = `--- a/${change.path}\n+++ b/${change.newPath || change.path}\n`;
	const hunks = change.hunks.map(hunk => {
		const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
		return hunkHeader + hunk.content;
	}).join('\n');

	return header + hunks;
}
