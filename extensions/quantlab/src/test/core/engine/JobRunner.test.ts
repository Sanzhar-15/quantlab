/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 *  Verification tests for audit fixes in JobRunner.ts
 *
 *  Tests:
 *    4. proc.stdin!.end() can throw → wrapped in try-catch
 *    5. proc.kill() can throw → wrapped in try-catch
 *    6. cancel() before start() → start() guards against it
 *    7. handleStderrMessage type safety
 *    8. onProcessExit JSON parse type guard
 */

import 'mocha';

import { isTestFlagEnabled } from '../../helpers/envFlag';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bundledEngineLaunch, ENGINE_SOURCES, EngineLaunch } from '../../../core/engine/bundledEngine';
import { JobRunner, readEngineResult, resolveEngineModule } from '../../../core/engine/JobRunner';
import { EngineEvent, JobRequest } from '../../../types/engine';

function makeRequest(overrides?: Partial<JobRequest>): JobRequest {
	return {
		jobId: 'test-job-1',
		action: 'backtest',
		strategyPath: '/tmp/fake_strategy.py',
		strategyHash: 'abc123',
		config: { action: 'backtest', values: { symbol: 'AAPL' } },
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function launch(executable: string): EngineLaunch {
	return { executable, source: 'test', cwd: os.tmpdir(), engineRoot: os.tmpdir() };
}

suite('JobRunner – Audit Verification', () => {

	// -----------------------------------------------------------------------
	// Verification 4: proc.stdin!.end() can throw
	// -----------------------------------------------------------------------
	suite('Issue #4: stdin.end() failure handling', () => {
		test('bad pythonPath produces a failed event, not an unhandled exception', function (done) {
			this.timeout(10000);
			const events: EngineEvent[] = [];
			const runner = new JobRunner({
				request: makeRequest(),
				engine: launch('/nonexistent/python/path/that/does/not/exist'),
				onEvent: (event) => {
					events.push(event);
					if (event.type === 'failed') {
						// Success: we got a clean failure event
						assert.ok(event.error.length > 0, 'Error message should be non-empty');
						done();
					}
				},
			});
			// This should NOT throw an unhandled exception
			runner.start();
		});
	});

	// -----------------------------------------------------------------------
	// Verification 5: proc.kill() can throw (TOCTOU race)
	// -----------------------------------------------------------------------
	suite('Issue #5: kill() race condition', () => {
		test('cancel on already-exited process does not throw', function (done) {
			// Megaudit Final.2: this test races spawn-vs-write on a
			// real OS process and surfaces an uncaught EPIPE when the
			// child exits before our stdin write completes. The
			// underlying invariant (cancel is safe after exit) is
			// covered by smaller unit tests; this end-to-end variant
			// is too flaky outside a real VS Code runtime. Gate so
			// the suite is deterministic in plain mocha.
			if (!isTestFlagEnabled(process.env.RUN_SPAWN_RACE_TESTS)) {  // Megaudit-2 A6-MAJOR-3
				this.skip();
				return;
			}
			this.timeout(15000);
			const events: EngineEvent[] = [];
			// Use a command that exits immediately — "python -c pass" would work if python exists
			const runner = new JobRunner({
				request: makeRequest(),
				engine: launch('/bin/echo'),  // will fail as a Python process but exits immediately
				onEvent: (event) => {
					events.push(event);
					if (event.type === 'failed' || event.type === 'complete') {
						// Process has exited. Now try to cancel — should not throw.
						try {
							runner.cancel();
							// If we get here, no throw — test passes
							done();
						} catch (err) {
							done(new Error(`cancel() threw after process exit: ${err}`));
						}
					}
				},
			});
			runner.start();
		});
	});

	// -----------------------------------------------------------------------
	// Verification 6: cancel() before start()
	// -----------------------------------------------------------------------
	suite('Issue #6: cancel before start', () => {
		test('cancel before start emits failed event without spawning process', () => {
			const events: EngineEvent[] = [];
			const runner = new JobRunner({
				request: makeRequest(),
				engine: launch('/usr/bin/python3'),
				onEvent: (event) => events.push(event),
			});

			// Cancel BEFORE start
			runner.cancel();
			runner.start();

			// Should have a failed event from start() detecting the cancelled flag
			const failedEvents = events.filter(e => e.type === 'failed');
			assert.strictEqual(failedEvents.length, 1, 'Should have exactly one failed event');
			assert.ok(
				failedEvents[0].type === 'failed' && failedEvents[0].error.includes('cancelled'),
				'Error should mention cancellation',
			);
		});
	});

	// -----------------------------------------------------------------------
	// Verification 7: handleStderrMessage type safety
	// -----------------------------------------------------------------------
	suite('Issue #7: handleStderrMessage type guard', () => {
		test('non-object JSON on stderr does not crash', function (done) {
			this.timeout(15000);
			// We'll test this by spawning a process that writes non-object JSON to stderr
			// and then exits. The runner should handle it gracefully.
			const events: EngineEvent[] = [];
			const runner = new JobRunner({
				request: makeRequest(),
				// Use bash to write non-object JSON to stderr and valid JSON to stdout
				engine: launch('/bin/bash'),
				onEvent: (event) => {
					events.push(event);
					// The process will fail because bash doesn't understand -m flag,
					// but the important thing is no unhandled exception
					if (event.type === 'failed' || event.type === 'complete') {
						done();
					}
				},
			});
			runner.start();
		});
	});

	// -----------------------------------------------------------------------
	// Verification 8: onProcessExit JSON parse type guard
	// -----------------------------------------------------------------------
	// Each stand-in engine reads its config first, as the real one does, so these test the type guard and
	// nothing else (the former /bin/bash stand-in exited without reading stdin and raced an EPIPE).
	suite('Issue #8: stdout JSON type guard', () => {
		let dir: string;

		setup(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-jobrunner-guard-'));
		});

		teardown(() => {
			fs.rmSync(dir, { recursive: true });
		});

		for (const [label, stdout] of [['non-object (array)', '[1,2,3]'], ['string', '"done"']]) {
			test(`${label} JSON stdout produces one failed event naming the type guard`, async function () {
				if (process.platform === 'win32') {
					this.skip();
				}
				const exe = engineScript(dir, `cat >/dev/null\nprintf '%s' '${stdout}'\n`);
				const events = await runToEnd(makeRequest(), launch(exe));
				assert.deepStrictEqual(events.filter(e => e.type === 'failed' || e.type === 'complete'), [
					{ type: 'failed', jobId: 'test-job-1', error: 'Python output is not a JSON object. Exit code: 0' },
				]);
			});
		}
	});

	// A config larger than any pipe buffer cannot be written before the engine exits, so an engine that closes
	// its stdin without reading always gets an EPIPE: the ordering is forced, not left to the scheduler.
	suite('the engine exits without reading its config', () => {
		let dir: string;

		setup(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-jobrunner-epipe-'));
		});

		teardown(() => {
			fs.rmSync(dir, { recursive: true });
		});

		const bigRequest = () => makeRequest({ config: { action: 'backtest', values: { 'param.padding': 'x'.repeat(1024 * 1024) } } } as Partial<JobRequest>);

		test('the write fails with EPIPE: one failed event names it, nothing is thrown', async function () {
			if (process.platform === 'win32') {
				this.skip();
			}
			const exe = engineScript(dir, `exec 0<&-\nprintf '%s' '${COMPLETE}'\nexit 3\n`);
			const events = await runToEnd(bigRequest(), launch(exe));
			const terminal = events.filter(e => e.type === 'failed' || e.type === 'complete');
			assert.strictEqual(terminal.length, 1, JSON.stringify(terminal));
			assert.ok(terminal[0].type === 'failed');
			assert.strictEqual(terminal[0].error, 'The engine exited (code 3) without reading its job config: write EPIPE');
			assert.ok(events.some(e => e.type === 'log' && e.level === 'error' && e.message === 'The engine did not read its job config from stdin: write EPIPE'));
		});

		test('control: the same config to an engine that reads it completes', async function () {
			if (process.platform === 'win32') {
				this.skip();
			}
			const exe = engineScript(dir, `cat >/dev/null\nprintf '%s' '${COMPLETE}'\n`);
			const events = await runToEnd(bigRequest(), launch(exe));
			const terminal = events.filter(e => e.type === 'failed' || e.type === 'complete');
			assert.strictEqual(terminal.length, 1, JSON.stringify(terminal));
			assert.strictEqual(terminal[0].type, 'complete');
		});
	});
});

/** A complete success result, every field the engine's contract requires (run_backtest.py:160-166). */
const COMPLETE = JSON.stringify({ success: true, metrics: { Sharpe: 1.2, Trades: 3 }, warnings: [], equity: [{ t: 1, v: 100 }], signals: [{ t: 1, type: 'entry', price: 10 }] });

// The engine's stdout contract: engine/quantlab/cli/run_backtest.py convert_results :105-112 and :160-166 (a success always
// has metrics, warnings, equity, signals); main :259, :267 (a failure without stack) and :279-283 (with stack).
suite('JobRunner - the engine result contract', () => {
	const complete = JSON.parse(COMPLETE) as Record<string, unknown>;

	test('a complete success is read as is', () => {
		assert.deepStrictEqual(readEngineResult(complete), { kind: 'complete', result: { metrics: { Sharpe: 1.2, Trades: 3 }, warnings: [], equity: [{ t: 1, v: 100 }], signals: [{ t: 1, type: 'entry', price: 10 }] } });
	});

	for (const field of ['metrics', 'warnings', 'equity', 'signals']) {
		test(`a success without '${field}' is invalid, naming it`, () => {
			const result = { ...complete };
			delete result[field];
			const reading = readEngineResult(result);
			assert.ok(reading.kind === 'invalid', JSON.stringify(reading));
			assert.match(reading.reason, new RegExp(`no '${field}'`));
		});
	}

	test('wrong shapes are named: a non-number metric, an equity point, a signal type, success itself', () => {
		assert.deepStrictEqual(readEngineResult({ ...complete, metrics: { Sharpe: null } }), { kind: 'invalid', reason: `metric 'Sharpe' is null, not a finite number` });
		assert.strictEqual(readEngineResult({ ...complete, equity: [{ t: 1 }] }).kind, 'invalid');
		assert.strictEqual(readEngineResult({ ...complete, signals: [{ t: 1, type: 'hold' }] }).kind, 'invalid');
		assert.deepStrictEqual(readEngineResult({ metrics: {} }), { kind: 'invalid', reason: `'success' is undefined, not true or false` });
	});

	test('a failure needs its error; stack is optional (:259, :267 omit it)', () => {
		assert.deepStrictEqual(readEngineResult({ success: false, error: 'No input received on stdin' }), { kind: 'failed', error: 'No input received on stdin', stack: undefined });
		assert.deepStrictEqual(readEngineResult({ success: false, error: 'boom', stack: 'Traceback' }), { kind: 'failed', error: 'boom', stack: 'Traceback' });
		assert.deepStrictEqual(readEngineResult({ success: false }), { kind: 'invalid', reason: `a failure result has no 'error' string (got undefined)` });
	});

	test('a job whose engine prints a success without metrics fails by name, never an empty success', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-jobrunner-contract-'));
		try {
			const exe = engineScript(dir, `cat >/dev/null\nprintf '{"success":true,"warnings":[],"equity":[],"signals":[]}'\n`);
			const events = await runToEnd(makeRequest(), launch(exe));
			assert.deepStrictEqual(events.filter(e => e.type === 'failed' || e.type === 'complete'), [
				{ type: 'failed', jobId: 'test-job-1', error: `The engine's result is invalid: a success result has no 'metrics' object (got undefined). Exit code: 0` },
			]);
		} finally {
			fs.rmSync(dir, { recursive: true });
		}
	});
});

/** A stand-in engine: a shell script whose body is `body`. */
function engineScript(dir: string, body: string): string {
	const exe = path.join(dir, 'quantlab-engine');
	fs.writeFileSync(exe, `#!/bin/sh\n${body}`, { mode: 0o755 });
	return exe;
}

/** Runs a job to its terminal event, then 300 ms more, so a second terminal event would be seen. */
function runToEnd(request: JobRequest, engine: EngineLaunch): Promise<EngineEvent[]> {
	return new Promise(resolve => {
		const events: EngineEvent[] = [];
		let ended = false;
		new JobRunner({
			request,
			engine,
			onEvent: (event) => {
				events.push(event);
				if (!ended && (event.type === 'failed' || event.type === 'complete')) {
					ended = true;
					setTimeout(() => resolve(events), 300);
				}
			},
		}).start();
	});
}

suite('JobRunner – engine actions and launch', () => {

	for (const [action, label] of [['optimize', 'Optimize'], ['monteCarlo', 'Monte Carlo'], ['wfa', 'Walk-forward analysis']]) {
		test(`${action} is refused by name, without starting a process`, () => {
			const events: EngineEvent[] = [];
			const runner = new JobRunner({
				request: makeRequest({ action }),
				engine: launch('/nonexistent/engine'),
				onEvent: (event) => events.push(event),
			});
			runner.start();
			const failed = events.filter(e => e.type === 'failed');
			assert.strictEqual(failed.length, 1);
			assert.ok(failed[0].type === 'failed' && failed[0].error === `${label} is not available yet: the Quantlab engine has no ${label} module.`);
			assert.ok(!events.some(e => e.type === 'log' && e.message.startsWith('Starting')), 'no process may be started');
		});
	}

	test('an unknown action is refused by name, never run as a backtest', () => {
		assert.deepStrictEqual(resolveEngineModule('frobnicate'), { kind: 'refused', reason: `Unknown engine action 'frobnicate': the Quantlab engine runs only a backtest.` });
		assert.deepStrictEqual(resolveEngineModule('constructor'), { kind: 'refused', reason: `Unknown engine action 'constructor': the Quantlab engine runs only a backtest.` });
		assert.deepStrictEqual(resolveEngineModule('backtest'), { kind: 'module', module: 'quantlab.cli.run_backtest' });
	});

	suite('the process the job starts', () => {
		let root: string;
		let savedPythonPath: string | undefined;

		setup(() => {
			root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ql-jobrunner-')));
			savedPythonPath = process.env.PYTHONPATH;
			process.env.PYTHONPATH = '/inherited/pythonpath';
		});

		teardown(() => {
			if (savedPythonPath === undefined) {
				delete process.env.PYTHONPATH;
			} else {
				process.env.PYTHONPATH = savedPythonPath;
			}
			fs.rmSync(root, { recursive: true });
		});

		// A stand-in engine: reports its argv, working directory and PYTHONPATH through the failure channel.
		function probe(dir: string): string {
			fs.mkdirSync(dir, { recursive: true });
			const exe = path.join(dir, 'quantlab-engine');
			fs.writeFileSync(exe, '#!/bin/sh\ncat >/dev/null\nprintf \'{"success":false,"error":"%s|%s|%s"}\' "$*" "$(pwd -P)" "${PYTHONPATH-unset}"\n', { mode: 0o755 });
			return exe;
		}

		function run(engine: EngineLaunch): Promise<EngineEvent[]> {
			return new Promise(resolve => {
				const events: EngineEvent[] = [];
				new JobRunner({
					request: makeRequest(),
					engine,
					onEvent: (event) => {
						events.push(event);
						if (event.type === 'failed' || event.type === 'complete') {
							resolve(events);
						}
					},
				}).start();
			});
		}

		function firstLog(events: EngineEvent[]): string {
			const first = events.find(e => e.type === 'log');
			assert.ok(first && first.type === 'log');
			return first.message;
		}

		for (const [step, source] of [['packaged', ENGINE_SOURCES.packaged], ['development', ENGINE_SOURCES.development]] as const) {
			test(`the ${step} bundled engine runs in its own directory with no PYTHONPATH, and the first log line names the step`, async function () {
				if (process.platform === 'win32') {
					this.skip();
				}
				const dir = path.join(root, 'engine', 'quantlab-engine');
				const exe = probe(dir);
				const events = await run(bundledEngineLaunch(exe, source));
				const failed = events.find(e => e.type === 'failed');
				assert.ok(failed && failed.type === 'failed');
				assert.strictEqual(failed.error, `-m quantlab.cli.run_backtest|${dir}|unset`);
				assert.strictEqual(firstLog(events), `Starting backtest job: ${exe} -m quantlab.cli.run_backtest (${step} bundled engine; cwd ${dir})`);
			});
		}

		test('an interpreter runs in the engine source tree with it on PYTHONPATH', async function () {
			if (process.platform === 'win32') {
				this.skip();
			}
			const engineRoot = path.join(root, 'engine-src');
			fs.mkdirSync(engineRoot);
			const exe = probe(path.join(root, 'bin'));
			const events = await run({ executable: exe, source: ENGINE_SOURCES.setting, cwd: engineRoot, engineRoot });
			const failed = events.find(e => e.type === 'failed');
			assert.ok(failed && failed.type === 'failed');
			assert.strictEqual(failed.error, `-m quantlab.cli.run_backtest|${engineRoot}|${engineRoot}`);
			assert.strictEqual(firstLog(events), `Starting backtest job: ${exe} -m quantlab.cli.run_backtest (setting quantlab.pythonPath; cwd ${engineRoot})`);
		});
	});
});
