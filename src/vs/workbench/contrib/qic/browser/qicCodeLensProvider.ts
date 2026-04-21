/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5: CodeLens Integration
 * Prompt 05-04
 *
 * Provides inline approve/reject actions in the diff editor when viewing QIC changes.
 * Also adds navigation hints for multi-file change sets.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { CodeLensProvider, CodeLens, CodeLensList } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IQicStateService } from '../common/state/qicStateService.js';
import { QIC_MODIFIED_SCHEME, QIC_ORIGINAL_SCHEME } from './diffDocumentProvider.js';
import type { FileChange, ChangeSet } from '../common/changes.js';

/**
 * QIC CodeLens Provider
 * Shows approve/reject actions at the top of QIC diff views.
 */
export class QicCodeLensProvider extends Disposable implements CodeLensProvider {

	private _onDidChange = this._register(new Emitter<this>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IQicStateService private readonly stateService: IQicStateService,
	) {
		super();

		// Register for both QIC schemes
		this._register(
			languageFeaturesService.codeLensProvider.register(
				{ scheme: QIC_MODIFIED_SCHEME },
				this
			)
		);

		this._register(
			languageFeaturesService.codeLensProvider.register(
				{ scheme: QIC_ORIGINAL_SCHEME },
				this
			)
		);

		// Refresh CodeLenses when state changes
		this._register(
			this.stateService.onDidChangeState(() => {
				this._onDidChange.fire(this);
			})
		);
	}

	/**
	 * Provide CodeLens items for the diff view.
	 */
	provideCodeLenses(model: ITextModel, _token: CancellationToken): CodeLensList | undefined {
		const uri = model.uri;

		// Only provide for QIC schemes
		if (uri.scheme !== QIC_MODIFIED_SCHEME && uri.scheme !== QIC_ORIGINAL_SCHEME) {
			return undefined;
		}

		// Extract change ID from URI path (format: /{changeId})
		const changeId = uri.path.substring(1);
		if (!changeId) {
			return undefined;
		}

		// Find the change in state
		const { change, changeSet } = this.findChange(changeId);
		if (!change) {
			return undefined;
		}

		const codeLenses: CodeLens[] = [];

		// Only show actions on the modified side
		if (uri.scheme === QIC_MODIFIED_SCHEME) {
			// Add approve/reject actions at line 1
			codeLenses.push(...this.createActionLenses(change, changeSet));

			// Add navigation lenses if there are multiple changes
			if (changeSet && changeSet.changes.length > 1) {
				codeLenses.push(...this.createNavigationLenses(change, changeSet));
			}

			// Add change info lens
			codeLenses.push(this.createInfoLens(change));
		}

		return { lenses: codeLenses };
	}

	/**
	 * Resolve a CodeLens (add command if needed).
	 */
	resolveCodeLens(_model: ITextModel, codeLens: CodeLens, _token: CancellationToken): CodeLens | undefined {
		// CodeLenses are fully resolved in provideCodeLenses
		return codeLens;
	}

	/**
	 * Create approve/reject action lenses.
	 */
	private createActionLenses(change: FileChange, changeSet?: ChangeSet): CodeLens[] {
		const lenses: CodeLens[] = [];
		const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };

		// Skip if already applied or rejected
		if (change.status !== 'pending') {
			return lenses;
		}

		// Approve lens
		lenses.push({
			range,
			command: {
				id: 'qic.applyFromDiff',
				title: '$(check) Accept Change',
				arguments: [change.id]
			}
		});

		// Reject lens
		lenses.push({
			range,
			command: {
				id: 'qic.rejectFromDiff',
				title: '$(close) Reject Change',
				arguments: [change.id]
			}
		});

		// If part of a change set with multiple changes, add bulk actions
		if (changeSet && changeSet.changes.length > 1) {
			const pendingCount = changeSet.changes.filter(c => c.status === 'pending').length;
			if (pendingCount > 1) {
				lenses.push({
					range,
					command: {
						id: 'qic.acceptAllChanges',
						title: `$(check-all) Accept All (${pendingCount})`,
						arguments: [changeSet.id]
					}
				});

				lenses.push({
					range,
					command: {
						id: 'qic.rejectAllChanges',
						title: `$(close-all) Reject All (${pendingCount})`,
						arguments: [changeSet.id]
					}
				});
			}
		}

		return lenses;
	}

	/**
	 * Create navigation lenses for multi-file change sets.
	 */
	private createNavigationLenses(change: FileChange, changeSet: ChangeSet): CodeLens[] {
		const lenses: CodeLens[] = [];
		const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };

		const changes = changeSet.changes;
		const currentIndex = changes.findIndex(c => c.id === change.id);

		if (currentIndex === -1) {
			return lenses;
		}

		// Position indicator
		lenses.push({
			range,
			command: {
				id: '',
				title: `Change ${currentIndex + 1} of ${changes.length}`,
			}
		});

		// Previous change
		if (currentIndex > 0) {
			const prevChange = changes[currentIndex - 1];
			lenses.push({
				range,
				command: {
					id: 'qic.showDiff',
					title: '$(arrow-left) Previous',
					arguments: [prevChange.id]
				}
			});
		}

		// Next change
		if (currentIndex < changes.length - 1) {
			const nextChange = changes[currentIndex + 1];
			lenses.push({
				range,
				command: {
					id: 'qic.showDiff',
					title: 'Next $(arrow-right)',
					arguments: [nextChange.id]
				}
			});
		}

		return lenses;
	}

	/**
	 * Create informational lens showing change details.
	 */
	private createInfoLens(change: FileChange): CodeLens {
		const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };

		// Build info string
		const parts: string[] = [];

		// Change type
		const typeIcons: Record<string, string> = {
			'create': '$(new-file)',
			'modify': '$(edit)',
			'delete': '$(trash)',
			'rename': '$(arrow-right)'
		};
		parts.push(typeIcons[change.type] || '$(file)');
		parts.push(change.type.charAt(0).toUpperCase() + change.type.slice(1));

		// Stats
		if (change.additions || change.deletions) {
			parts.push(`(+${change.additions || 0} -${change.deletions || 0})`);
		}

		// Status
		if (change.status !== 'pending') {
			const statusLabels: Record<string, string> = {
				'applied': '$(check) Applied',
				'rejected': '$(x) Rejected',
				'conflict': '$(warning) Conflict'
			};
			parts.push(statusLabels[change.status] || change.status);
		}

		return {
			range,
			command: {
				id: '',
				title: parts.join(' '),
			}
		};
	}

	/**
	 * Find a change by ID in the state.
	 */
	private findChange(changeId: string): { change?: FileChange; changeSet?: ChangeSet } {
		const state = this.stateService.state as any;

		// Check conversation.pendingChanges
		const pendingChanges = state.conversation?.pendingChanges;
		if (pendingChanges?.changes && Array.isArray(pendingChanges.changes)) {
			const change = pendingChanges.changes.find((c: FileChange) => c.id === changeId);
			if (change) {
				return { change, changeSet: pendingChanges };
			}
		}

		// Check changeSets array
		const changeSets = state.changeSets;
		if (changeSets && Array.isArray(changeSets)) {
			for (const changeSet of changeSets) {
				const change = changeSet.changes?.find((c: FileChange) => c.id === changeId);
				if (change) {
					return { change, changeSet };
				}
			}
		}

		return {};
	}
}
