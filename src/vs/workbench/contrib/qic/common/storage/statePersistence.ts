/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { QicDatabase } from './database.js';

// ---------------------------------------------------------------------------
// Snapshot Types
// ---------------------------------------------------------------------------

export interface AgentStateSnapshot {
	sessionId: string;
	state: string;
	currentTaskId?: string;
	conversationJson?: string;
	metadata?: Record<string, unknown>;
}

export interface TaskStateSnapshot {
	taskId: string;
	sessionId: string;
	state: string;
	planJson?: string;
	currentStep: number;
	completedSteps: string[];
	failedSteps: string[];
	createdAt: string;
	updatedAt: string;
}

export interface ConversationSnapshot {
	conversationId: string;
	sessionId: string;
	messagesJson: string;
	lane?: string;
	tokenCount: number;
}

// ---------------------------------------------------------------------------
// StatePersistenceManager
// ---------------------------------------------------------------------------

/**
 * CRUD operations for QIC state persistence in SQLite.
 */
export class StatePersistenceManager {

	constructor(private readonly db: QicDatabase) {}

	// -- Agent State -----------------------------------------------------------

	saveAgentState(snapshot: AgentStateSnapshot): void {
		const now = new Date().toISOString();
		this.db.run(
			`INSERT OR REPLACE INTO qic_agent_state
			 (session_id, state, current_task_id, conversation_json, created_at, updated_at, metadata_json)
			 VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM qic_agent_state WHERE session_id = ?), ?), ?, ?)`,
			snapshot.sessionId,
			snapshot.state,
			snapshot.currentTaskId ?? null,
			snapshot.conversationJson ?? null,
			snapshot.sessionId,
			now,
			now,
			snapshot.metadata ? JSON.stringify(snapshot.metadata) : null,
		);
	}

	loadAgentState(sessionId: string): AgentStateSnapshot | undefined {
		const row = this.db.get<{
			session_id: string;
			state: string;
			current_task_id: string | null;
			conversation_json: string | null;
			metadata_json: string | null;
		}>('SELECT * FROM qic_agent_state WHERE session_id = ?', sessionId);

		if (!row) {
			return undefined;
		}

		return {
			sessionId: row.session_id,
			state: row.state,
			currentTaskId: row.current_task_id ?? undefined,
			conversationJson: row.conversation_json ?? undefined,
			metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
		};
	}

	deleteAgentState(sessionId: string): void {
		this.db.run('DELETE FROM qic_agent_state WHERE session_id = ?', sessionId);
	}

	// -- Task State ------------------------------------------------------------

	saveTaskState(snapshot: TaskStateSnapshot): void {
		const now = new Date().toISOString();
		this.db.run(
			`INSERT OR REPLACE INTO qic_task_state
			 (task_id, session_id, state, plan_json, current_step, completed_steps_json, failed_steps_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM qic_task_state WHERE task_id = ?), ?), ?)`,
			snapshot.taskId,
			snapshot.sessionId,
			snapshot.state,
			snapshot.planJson ?? null,
			snapshot.currentStep,
			JSON.stringify(snapshot.completedSteps),
			JSON.stringify(snapshot.failedSteps),
			snapshot.taskId,
			now,
			now,
		);
	}

	loadTaskState(taskId: string): TaskStateSnapshot | undefined {
		const row = this.db.get<{
			task_id: string;
			session_id: string;
			state: string;
			plan_json: string | null;
			current_step: number;
			completed_steps_json: string;
			failed_steps_json: string;
			created_at: string;
			updated_at: string;
		}>('SELECT * FROM qic_task_state WHERE task_id = ?', taskId);

		if (!row) {
			return undefined;
		}

		return {
			taskId: row.task_id,
			sessionId: row.session_id,
			state: row.state,
			planJson: row.plan_json ?? undefined,
			currentStep: row.current_step,
			completedSteps: JSON.parse(row.completed_steps_json),
			failedSteps: JSON.parse(row.failed_steps_json),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	loadTasksForSession(sessionId: string): TaskStateSnapshot[] {
		const rows = this.db.all<{
			task_id: string;
			session_id: string;
			state: string;
			plan_json: string | null;
			current_step: number;
			completed_steps_json: string;
			failed_steps_json: string;
			created_at: string;
			updated_at: string;
		}>('SELECT * FROM qic_task_state WHERE session_id = ?', sessionId);

		return rows.map(row => ({
			taskId: row.task_id,
			sessionId: row.session_id,
			state: row.state,
			planJson: row.plan_json ?? undefined,
			currentStep: row.current_step,
			completedSteps: JSON.parse(row.completed_steps_json),
			failedSteps: JSON.parse(row.failed_steps_json),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	}

	deleteTaskState(taskId: string): void {
		this.db.run('DELETE FROM qic_task_state WHERE task_id = ?', taskId);
	}

	// -- Conversation State ----------------------------------------------------

	saveConversationState(snapshot: ConversationSnapshot): void {
		const now = new Date().toISOString();
		this.db.run(
			`INSERT OR REPLACE INTO qic_conversation_state
			 (conversation_id, session_id, messages_json, lane, token_count, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM qic_conversation_state WHERE conversation_id = ?), ?), ?)`,
			snapshot.conversationId,
			snapshot.sessionId,
			snapshot.messagesJson,
			snapshot.lane ?? null,
			snapshot.tokenCount,
			snapshot.conversationId,
			now,
			now,
		);
	}

	loadConversationState(conversationId: string): ConversationSnapshot | undefined {
		const row = this.db.get<{
			conversation_id: string;
			session_id: string;
			messages_json: string;
			lane: string | null;
			token_count: number;
		}>('SELECT * FROM qic_conversation_state WHERE conversation_id = ?', conversationId);

		if (!row) {
			return undefined;
		}

		return {
			conversationId: row.conversation_id,
			sessionId: row.session_id,
			messagesJson: row.messages_json,
			lane: row.lane ?? undefined,
			tokenCount: row.token_count,
		};
	}

	// -- Recovery --------------------------------------------------------------

	getRecoverableSessions(): string[] {
		const rows = this.db.all<{ session_id: string }>(
			`SELECT session_id FROM qic_agent_state
			 WHERE state IN ('processing', 'waiting_approval')
			 ORDER BY updated_at DESC`,
		);
		return rows.map(r => r.session_id);
	}
}
