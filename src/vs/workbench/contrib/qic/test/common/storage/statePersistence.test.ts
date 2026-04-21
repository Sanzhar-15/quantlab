/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { QicDatabase } from '../../../common/storage/database.js';
import { StatePersistenceManager, AgentStateSnapshot, TaskStateSnapshot, ConversationSnapshot } from '../../../common/storage/statePersistence.js';

suite('StatePersistenceManager', () => {

	let tmpDir: string;
	let db: QicDatabase;
	let manager: StatePersistenceManager;

	setup(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qic-sp-test-'));
		db = new QicDatabase(path.join(tmpDir, 'test.db'));
		await db.initialize();
		manager = new StatePersistenceManager(db);
	});

	teardown(async () => {
		db.close();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// -- Agent State -----------------------------------------------------------

	test('save and load agent state round-trip', () => {
		const snapshot: AgentStateSnapshot = {
			sessionId: 'session-1',
			state: 'idle',
			currentTaskId: 'task-1',
			metadata: { foo: 'bar' },
		};

		manager.saveAgentState(snapshot);
		const loaded = manager.loadAgentState('session-1');

		assert.ok(loaded);
		assert.strictEqual(loaded!.sessionId, 'session-1');
		assert.strictEqual(loaded!.state, 'idle');
		assert.strictEqual(loaded!.currentTaskId, 'task-1');
		assert.deepStrictEqual(loaded!.metadata, { foo: 'bar' });
	});

	test('load nonexistent agent state returns undefined', () => {
		const result = manager.loadAgentState('nonexistent');
		assert.strictEqual(result, undefined);
	});

	test('delete agent state', () => {
		manager.saveAgentState({ sessionId: 's1', state: 'idle' });
		manager.deleteAgentState('s1');
		assert.strictEqual(manager.loadAgentState('s1'), undefined);
	});

	// -- Task State ------------------------------------------------------------

	test('save and load task state with failed_steps', () => {
		const snapshot: TaskStateSnapshot = {
			taskId: 'task-1',
			sessionId: 'session-1',
			state: 'executing',
			currentStep: 2,
			completedSteps: ['step-1', 'step-2'],
			failedSteps: ['step-3'],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		// Need an agent state first (FK)
		manager.saveAgentState({ sessionId: 'session-1', state: 'processing' });
		manager.saveTaskState(snapshot);

		const loaded = manager.loadTaskState('task-1');
		assert.ok(loaded);
		assert.strictEqual(loaded!.taskId, 'task-1');
		assert.strictEqual(loaded!.currentStep, 2);
		assert.deepStrictEqual(loaded!.completedSteps, ['step-1', 'step-2']);
		assert.deepStrictEqual(loaded!.failedSteps, ['step-3']);
	});

	test('loadTasksForSession returns all tasks', () => {
		manager.saveAgentState({ sessionId: 'session-1', state: 'idle' });
		manager.saveTaskState({
			taskId: 'task-1', sessionId: 'session-1', state: 'completed',
			currentStep: 0, completedSteps: [], failedSteps: [],
			createdAt: '', updatedAt: '',
		});
		manager.saveTaskState({
			taskId: 'task-2', sessionId: 'session-1', state: 'pending',
			currentStep: 0, completedSteps: [], failedSteps: [],
			createdAt: '', updatedAt: '',
		});

		const tasks = manager.loadTasksForSession('session-1');
		assert.strictEqual(tasks.length, 2);
	});

	// -- Conversation State ----------------------------------------------------

	test('save and load conversation state', () => {
		manager.saveAgentState({ sessionId: 'session-1', state: 'idle' });

		const snapshot: ConversationSnapshot = {
			conversationId: 'conv-1',
			sessionId: 'session-1',
			messagesJson: JSON.stringify([{ role: 'user', content: 'hi' }]),
			lane: 'chat-ask',
			tokenCount: 42,
		};

		manager.saveConversationState(snapshot);
		const loaded = manager.loadConversationState('conv-1');

		assert.ok(loaded);
		assert.strictEqual(loaded!.lane, 'chat-ask');
		assert.strictEqual(loaded!.tokenCount, 42);
	});

	// -- Recovery --------------------------------------------------------------

	test('getRecoverableSessions returns processing/waiting_approval sessions', () => {
		manager.saveAgentState({ sessionId: 's-idle', state: 'idle' });
		manager.saveAgentState({ sessionId: 's-processing', state: 'processing' });
		manager.saveAgentState({ sessionId: 's-waiting', state: 'waiting_approval' });
		manager.saveAgentState({ sessionId: 's-error', state: 'error' });

		const recoverable = manager.getRecoverableSessions();
		assert.ok(recoverable.includes('s-processing'));
		assert.ok(recoverable.includes('s-waiting'));
		assert.ok(!recoverable.includes('s-idle'));
		assert.ok(!recoverable.includes('s-error'));
	});

	test('empty database returns empty arrays', () => {
		assert.strictEqual(manager.loadAgentState('x'), undefined);
		assert.deepStrictEqual(manager.loadTasksForSession('x'), []);
		assert.deepStrictEqual(manager.getRecoverableSessions(), []);
	});
});
