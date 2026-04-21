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
import { PersistentAgentStateMachine } from '../../../common/state/agentStateMachine.js';

suite('PersistentAgentStateMachine', () => {

	let tmpDir: string;
	let db: QicDatabase;
	let persistence: StatePersistenceManager;

	setup(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qic-asm-test-'));
		db = new QicDatabase(path.join(tmpDir, 'test.db'));
		await db.initialize();
		persistence = new StatePersistenceManager(db);
	});

	teardown(async () => {
		db.close();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test('initial state is idle', () => {
		const machine = new PersistentAgentStateMachine(persistence, 'session-1');
		assert.strictEqual(machine.getState(), 'idle');
	});

	test('sessionId is accessible via getter (Audit X-PS8)', () => {
		const machine = new PersistentAgentStateMachine(persistence, 'session-42');
		assert.strictEqual(machine.sessionId, 'session-42');
	});

	test('valid transition idle -> processing succeeds', async () => {
		const machine = new PersistentAgentStateMachine(persistence, 'session-1');
		await machine.transition('processing');
		assert.strictEqual(machine.getState(), 'processing');
	});

	test('valid transition processing -> waiting_approval succeeds', async () => {
		const machine = new PersistentAgentStateMachine(persistence, 'session-1');
		await machine.transition('processing');
		await machine.transition('waiting_approval');
		assert.strictEqual(machine.getState(), 'waiting_approval');
	});

	test('invalid transition idle -> error throws', async () => {
		const machine = new PersistentAgentStateMachine(persistence, 'session-1');
		await assert.rejects(
			() => machine.transition('error'),
			/Invalid agent state transition: idle -> error/,
		);
	});

	test('invalid transition idle -> waiting_approval throws', async () => {
		const machine = new PersistentAgentStateMachine(persistence, 'session-1');
		await assert.rejects(
			() => machine.transition('waiting_approval'),
			/Invalid agent state transition/,
		);
	});

	test('transition persists to database', async () => {
		const machine = new PersistentAgentStateMachine(persistence, 'session-1');
		await machine.transition('processing');

		const snapshot = persistence.loadAgentState('session-1');
		assert.ok(snapshot);
		assert.strictEqual(snapshot!.state, 'processing');
	});

	test('recover from processing resets to idle (Audit S-4)', async () => {
		// Simulate crash during processing
		persistence.saveAgentState({ sessionId: 'session-crash', state: 'processing' });

		const result = await PersistentAgentStateMachine.recover(persistence, 'session-crash');
		assert.ok(result);
		assert.strictEqual(result!.recoveredFrom, 'processing');
		assert.strictEqual(result!.machine.getState(), 'idle');
	});

	test('recover from waiting_approval preserves state', async () => {
		persistence.saveAgentState({ sessionId: 'session-wait', state: 'waiting_approval' });

		const result = await PersistentAgentStateMachine.recover(persistence, 'session-wait');
		assert.ok(result);
		assert.strictEqual(result!.recoveredFrom, 'waiting_approval');
		assert.strictEqual(result!.machine.getState(), 'waiting_approval');
	});

	test('recover nonexistent session returns null', async () => {
		const result = await PersistentAgentStateMachine.recover(persistence, 'nonexistent');
		assert.strictEqual(result, null);
	});

	test('full lifecycle: idle -> processing -> waiting_approval -> processing -> idle', async () => {
		const machine = new PersistentAgentStateMachine(persistence, 'session-lifecycle');
		assert.strictEqual(machine.getState(), 'idle');

		await machine.transition('processing');
		assert.strictEqual(machine.getState(), 'processing');

		await machine.transition('waiting_approval');
		assert.strictEqual(machine.getState(), 'waiting_approval');

		await machine.transition('processing');
		assert.strictEqual(machine.getState(), 'processing');

		await machine.transition('idle');
		assert.strictEqual(machine.getState(), 'idle');
	});

	test('error state can transition to idle', async () => {
		const machine = new PersistentAgentStateMachine(persistence, 'session-err');
		await machine.transition('processing');
		await machine.transition('error');
		assert.strictEqual(machine.getState(), 'error');

		await machine.transition('idle');
		assert.strictEqual(machine.getState(), 'idle');
	});
});
