/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { QicDatabase } from '../../../common/storage/database.js';
import { StatePersistenceManager } from '../../../common/storage/statePersistence.js';
import { PersistentTaskStateMachine } from '../../../common/state/taskStateMachine.js';

suite('PersistentTaskStateMachine', () => {

	let tmpDir: string;
	let db: QicDatabase;
	let persistence: StatePersistenceManager;

	setup(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qic-tsm-test-'));
		db = new QicDatabase(path.join(tmpDir, 'test.db'));
		await db.initialize();
		persistence = new StatePersistenceManager(db);
		// Create required agent state (FK)
		persistence.saveAgentState({ sessionId: 'session-1', state: 'idle' });
	});

	teardown(async () => {
		db.close();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test('initial state is pending', () => {
		const machine = new PersistentTaskStateMachine(persistence, 'session-1', 'task-1');
		assert.strictEqual(machine.getState(), 'pending');
	});

	test('valid transition pending -> planning succeeds', async () => {
		const machine = new PersistentTaskStateMachine(persistence, 'session-1', 'task-1');
		await machine.transition('planning');
		assert.strictEqual(machine.getState(), 'planning');
	});

	test('invalid transition pending -> executing throws', async () => {
		const machine = new PersistentTaskStateMachine(persistence, 'session-1', 'task-1');
		await assert.rejects(
			() => machine.transition('executing'),
			/Invalid task state transition: pending -> executing/,
		);
	});

	test('completed and failed steps are tracked', async () => {
		const machine = new PersistentTaskStateMachine(persistence, 'session-1', 'task-1');
		await machine.transition('planning');
		await machine.transition('executing');

		machine.addCompletedStep('step-1');
		machine.addCompletedStep('step-2');
		machine.addFailedStep('step-3');

		assert.deepStrictEqual(machine.completedSteps, ['step-1', 'step-2']);
		assert.deepStrictEqual(machine.failedSteps, ['step-3']);
	});

	test('persist and recover round-trip with failedSteps (Audit IV-AO9)', async () => {
		const machine = new PersistentTaskStateMachine(persistence, 'session-1', 'task-rt');
		await machine.transition('planning');
		await machine.transition('executing');
		machine.addCompletedStep('step-1');
		machine.addFailedStep('step-2');
		// Force a persist
		await machine.transition('verifying');

		const recovered = await PersistentTaskStateMachine.recover(persistence, 'task-rt');
		assert.ok(recovered);
		assert.strictEqual(recovered!.recoveredFrom, 'verifying');
		assert.deepStrictEqual(recovered!.machine.completedSteps, ['step-1']);
		assert.deepStrictEqual(recovered!.machine.failedSteps, ['step-2']);
	});

	test('recover nonexistent task returns null', async () => {
		const result = await PersistentTaskStateMachine.recover(persistence, 'nonexistent');
		assert.strictEqual(result, null);
	});

	test('full lifecycle: pending -> planning -> executing -> verifying -> completed', async () => {
		const machine = new PersistentTaskStateMachine(persistence, 'session-1', 'task-lifecycle');
		await machine.transition('planning');
		await machine.transition('executing');
		await machine.transition('verifying');
		await machine.transition('completed');
		assert.strictEqual(machine.getState(), 'completed');
	});

	test('failed state can retry from pending', async () => {
		const machine = new PersistentTaskStateMachine(persistence, 'session-1', 'task-retry');
		await machine.transition('planning');
		await machine.transition('failed');
		assert.strictEqual(machine.getState(), 'failed');

		await machine.transition('pending');
		assert.strictEqual(machine.getState(), 'pending');
	});

	test('taskId and sessionId accessible via getters', () => {
		const machine = new PersistentTaskStateMachine(persistence, 'session-42', 'task-99');
		assert.strictEqual(machine.taskId, 'task-99');
		assert.strictEqual(machine.sessionId, 'session-42');
	});
});
