/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { StatePersistenceManager } from '../storage/statePersistence.js';

export type TaskState = 'pending' | 'planning' | 'executing' | 'verifying' | 'completed' | 'failed';

const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
	'pending': ['planning', 'failed'],
	'planning': ['executing', 'failed'],
	'executing': ['verifying', 'failed'],
	'verifying': ['completed', 'executing', 'failed'],
	'completed': [],
	'failed': ['pending'],
};

export class PersistentTaskStateMachine {
	private state: TaskState = 'pending';
	private readonly _taskId: string;
	private readonly _sessionId: string;
	private readonly db: StatePersistenceManager;

	completedSteps: string[] = [];
	failedSteps: string[] = [];

	constructor(db: StatePersistenceManager, sessionId: string, taskId: string) {
		this.db = db;
		this._sessionId = sessionId;
		this._taskId = taskId;
	}

	get taskId(): string {
		return this._taskId;
	}

	get sessionId(): string {
		return this._sessionId;
	}

	getState(): TaskState {
		return this.state;
	}

	async transition(to: TaskState): Promise<void> {
		const validTargets = VALID_TRANSITIONS[this.state];
		if (!validTargets || !validTargets.includes(to)) {
			throw new Error(`Invalid task state transition: ${this.state} -> ${to}`);
		}
		this.state = to;
		await this.persist();
	}

	addCompletedStep(stepId: string): void {
		this.completedSteps.push(stepId);
	}

	addFailedStep(stepId: string): void {
		this.failedSteps.push(stepId);
	}

	private async persist(): Promise<void> {
		this.db.saveTaskState({
			taskId: this._taskId,
			sessionId: this._sessionId,
			state: this.state,
			currentStep: this.completedSteps.length,
			completedSteps: this.completedSteps,
			failedSteps: this.failedSteps,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
	}

	/**
	 * Recover task state from crash. Returns null if no snapshot exists.
	 * Restores failedSteps from failed_steps_json (Audit S-5 / IV-AO9).
	 */
	static async recover(
		db: StatePersistenceManager,
		taskId: string,
	): Promise<{ machine: PersistentTaskStateMachine; recoveredFrom: TaskState } | null> {
		const snapshot = db.loadTaskState(taskId);
		if (!snapshot) {
			return null;
		}

		const machine = new PersistentTaskStateMachine(db, snapshot.sessionId, taskId);
		const recoveredFrom = snapshot.state as TaskState;
		machine.state = recoveredFrom;
		machine.completedSteps = snapshot.completedSteps ?? [];
		machine.failedSteps = snapshot.failedSteps ?? [];

		return { machine, recoveredFrom };
	}
}
