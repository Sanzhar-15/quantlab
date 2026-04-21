/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { StatePersistenceManager } from '../storage/statePersistence.js';
import type { TimeoutManager } from '../timeout/timeoutManager.js';

export type AgentState = 'idle' | 'processing' | 'waiting_approval' | 'error' | 'suspended';

const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
	'idle': ['processing', 'suspended'],
	'processing': ['waiting_approval', 'idle', 'error', 'suspended'],
	'waiting_approval': ['processing', 'idle', 'error'],
	'error': ['idle', 'suspended'],
	'suspended': ['idle'],
};

// Audit VII-DS2: State-transition timeouts
const STATE_TIMEOUTS: Record<string, number> = {
	'idle->processing': 120_000,
	'processing->waiting_approval': 300_000,
	'waiting_approval->processing': Infinity, // INV-A4: No timeout for user approval
	'processing->idle': 600_000,
};

export class PersistentAgentStateMachine {
	private state: AgentState = 'idle';
	private readonly _sessionId: string;
	private readonly db: StatePersistenceManager;

	constructor(db: StatePersistenceManager, sessionId: string) {
		this.db = db;
		this._sessionId = sessionId;
	}

	get sessionId(): string {
		return this._sessionId;
	}

	getState(): AgentState {
		return this.state;
	}

	async transition(to: AgentState, timeoutManager?: TimeoutManager): Promise<void> {
		const validTargets = VALID_TRANSITIONS[this.state];
		if (!validTargets || !validTargets.includes(to)) {
			throw new Error(`Invalid agent state transition: ${this.state} -> ${to}`);
		}

		const key = `${this.state}->${to}`;
		const timeout = STATE_TIMEOUTS[key];

		if (timeoutManager && timeout !== undefined && timeout !== Infinity) {
			timeoutManager.schedule(`state-${key}`, timeout, () => {
				this.transition('error').catch(() => { /* best effort */ });
			});
		}

		this.state = to;
		await this.persist();
	}

	private async persist(): Promise<void> {
		this.db.saveAgentState({
			sessionId: this._sessionId,
			state: this.state,
		});
	}

	/**
	 * Recover from crash. Returns null if no snapshot exists.
	 * Does NOT reference UI — caller handles notification (Audit S-4 / IV-AO8).
	 */
	static async recover(
		db: StatePersistenceManager,
		sessionId: string,
	): Promise<{ machine: PersistentAgentStateMachine; recoveredFrom: AgentState } | null> {
		const snapshot = db.loadAgentState(sessionId);
		if (!snapshot) {
			return null;
		}

		const machine = new PersistentAgentStateMachine(db, sessionId);
		const recoveredFrom = snapshot.state as AgentState;

		// If crashed during processing, reset to idle
		if (recoveredFrom === 'processing') {
			machine.state = 'idle';
		} else {
			machine.state = recoveredFrom;
		}

		await machine.persist();
		return { machine, recoveredFrom };
	}
}
