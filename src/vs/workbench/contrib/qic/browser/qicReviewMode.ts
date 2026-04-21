/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5: Review Mode
 * Prompt 05-05
 *
 * Provides a structured review flow for navigating through multiple proposed changes.
 * Integrates with the diff service to show changes one at a time with navigation.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IQicStateService } from '../common/state/qicStateService.js';
import { IQicDiffService } from './qicDiffService.js';
import { IContextKeyService, IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { FileChange, ChangeSet } from '../common/changes.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IQicReviewService = createDecorator<IQicReviewService>('qicReviewService');

export interface ReviewProgress {
	currentIndex: number;
	totalCount: number;
	appliedCount: number;
	rejectedCount: number;
	pendingCount: number;
	currentChange: FileChange | undefined;
}

export interface IQicReviewService {
	readonly _serviceBrand: undefined;

	/**
	 * Whether review mode is currently active.
	 */
	readonly isActive: boolean;

	/**
	 * Event fired when review mode state changes.
	 */
	readonly onDidChange: Event<void>;

	/**
	 * Start review mode for a change set.
	 */
	startReview(changeSetId: string): Promise<void>;

	/**
	 * Exit review mode.
	 */
	exitReview(): void;

	/**
	 * Navigate to the next change.
	 */
	nextChange(): Promise<void>;

	/**
	 * Navigate to the previous change.
	 */
	previousChange(): Promise<void>;

	/**
	 * Accept the current change and move to next.
	 */
	acceptAndNext(): Promise<void>;

	/**
	 * Reject the current change and move to next.
	 */
	rejectAndNext(): Promise<void>;

	/**
	 * Get current review progress.
	 */
	getProgress(): ReviewProgress | undefined;

	/**
	 * Get all changes in the current review.
	 */
	getChanges(): FileChange[];
}

/**
 * QIC Review Mode Service implementation.
 * Manages a structured review flow through a change set.
 */
export class QicReviewService extends Disposable implements IQicReviewService {
	readonly _serviceBrand: undefined;

	private _isActive = false;
	private _changes: FileChange[] = [];
	private _currentIndex = 0;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly inReviewModeKey: IContextKey<boolean>;

	constructor(
		@IQicStateService private readonly stateService: IQicStateService,
		@IQicDiffService private readonly diffService: IQicDiffService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		// Create context key for tracking review mode
		this.inReviewModeKey = contextKeyService.createKey('qic.inReviewMode', false);
	}

	get isActive(): boolean {
		return this._isActive;
	}

	/**
	 * Start review mode for a change set.
	 */
	async startReview(changeSetId: string): Promise<void> {
		const changeSet = this.findChangeSet(changeSetId);
		if (!changeSet) {
			throw new Error(`Change set not found: ${changeSetId}`);
		}

		if (!changeSet.changes || changeSet.changes.length === 0) {
			throw new Error('Change set has no changes to review');
		}

		this._changes = [...changeSet.changes];
		this._currentIndex = 0;
		this._isActive = true;
		this.inReviewModeKey.set(true);

		// Show the first change
		await this.showCurrentChange();

		this._onDidChange.fire();
	}

	/**
	 * Exit review mode.
	 */
	exitReview(): void {
		this._isActive = false;
		this._changes = [];
		this._currentIndex = 0;
		this.inReviewModeKey.set(false);

		// Close any open diff
		this.diffService.closeDiff();

		this._onDidChange.fire();
	}

	/**
	 * Navigate to the next change.
	 */
	async nextChange(): Promise<void> {
		if (!this._isActive || this._changes.length === 0) return;

		// Find next pending change
		let nextIndex = this._currentIndex + 1;
		while (nextIndex < this._changes.length && this._changes[nextIndex].status !== 'pending') {
			nextIndex++;
		}

		if (nextIndex < this._changes.length) {
			this._currentIndex = nextIndex;
			await this.showCurrentChange();
		} else {
			// Check if there are any pending changes left
			const pendingCount = this._changes.filter(c => c.status === 'pending').length;
			if (pendingCount === 0) {
				// All changes reviewed - exit
				this.exitReview();
				return;
			}
			// Wrap around to first pending
			for (let i = 0; i < this._changes.length; i++) {
				if (this._changes[i].status === 'pending') {
					this._currentIndex = i;
					await this.showCurrentChange();
					break;
				}
			}
		}

		this._onDidChange.fire();
	}

	/**
	 * Navigate to the previous change.
	 */
	async previousChange(): Promise<void> {
		if (!this._isActive || this._changes.length === 0) return;

		// Find previous pending change
		let prevIndex = this._currentIndex - 1;
		while (prevIndex >= 0 && this._changes[prevIndex].status !== 'pending') {
			prevIndex--;
		}

		if (prevIndex >= 0) {
			this._currentIndex = prevIndex;
			await this.showCurrentChange();
		} else {
			// Wrap around to last pending
			for (let i = this._changes.length - 1; i >= 0; i--) {
				if (this._changes[i].status === 'pending') {
					this._currentIndex = i;
					await this.showCurrentChange();
					break;
				}
			}
		}

		this._onDidChange.fire();
	}

	/**
	 * Accept the current change and move to next.
	 */
	async acceptAndNext(): Promise<void> {
		if (!this._isActive || !this.currentChange) return;

		const change = this.currentChange;

		// Apply the change via state service
		this.stateService.applyChange?.(change.id);

		// Update local state
		change.status = 'applied';

		// Move to next
		await this.nextChange();
	}

	/**
	 * Reject the current change and move to next.
	 */
	async rejectAndNext(): Promise<void> {
		if (!this._isActive || !this.currentChange) return;

		const change = this.currentChange;

		// Reject the change via state service
		this.stateService.rejectChange?.(change.id);

		// Update local state
		change.status = 'rejected';

		// Move to next
		await this.nextChange();
	}

	/**
	 * Get current review progress.
	 */
	getProgress(): ReviewProgress | undefined {
		if (!this._isActive) return undefined;

		const appliedCount = this._changes.filter(c => c.status === 'applied').length;
		const rejectedCount = this._changes.filter(c => c.status === 'rejected').length;
		const pendingCount = this._changes.filter(c => c.status === 'pending').length;

		return {
			currentIndex: this._currentIndex,
			totalCount: this._changes.length,
			appliedCount,
			rejectedCount,
			pendingCount,
			currentChange: this.currentChange,
		};
	}

	/**
	 * Get all changes in the current review.
	 */
	getChanges(): FileChange[] {
		return [...this._changes];
	}

	/**
	 * Get the current change.
	 */
	private get currentChange(): FileChange | undefined {
		if (!this._isActive || this._currentIndex >= this._changes.length) return undefined;
		return this._changes[this._currentIndex];
	}

	/**
	 * Show the current change in the diff view.
	 */
	private async showCurrentChange(): Promise<void> {
		const change = this.currentChange;
		if (!change) return;

		await this.diffService.showDiffForChange(change);
	}

	/**
	 * Find a change set by ID.
	 */
	private findChangeSet(changeSetId: string): ChangeSet | undefined {
		const state = this.stateService.state as any;

		// Check conversation.pendingChanges
		const pendingChanges = state.conversation?.pendingChanges;
		if (pendingChanges?.id === changeSetId) {
			return pendingChanges;
		}

		// Check changeSets array
		const changeSets = state.changeSets;
		if (changeSets && Array.isArray(changeSets)) {
			return changeSets.find((cs: ChangeSet) => cs.id === changeSetId);
		}

		return undefined;
	}
}
