/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildHelpMessage, formatOptions, Option, OptionDescriptions, OPTIONS, Subcommand, parseArgs, ErrorReporter, REFUSED_CLI_COMMANDS, REFUSED_CLI_OPTIONS, refusedCliCommand, refusedCliOption, refuseRemovedCliArgs } from '../../node/argv.js';
import { addArg } from '../../node/argvHelper.js';

function o(description: string, type: 'boolean' | 'string' | 'string[]' = 'string'): Option<any> {
	return {
		description, type
	};
}
function c(description: string, options: OptionDescriptions<any>): Subcommand<any> {
	return {
		description, type: 'subcommand', options
	};
}

suite('formatOptions', () => {

	test('Text should display small columns correctly', () => {
		assert.deepStrictEqual(
			formatOptions({
				'add': o('bar')
			}, 80),
			['  --add        bar']
		);
		assert.deepStrictEqual(
			formatOptions({
				'add': o('bar'),
				'wait': o('ba'),
				'trace': o('b')
			}, 80),
			[
				'  --add        bar',
				'  --wait       ba',
				'  --trace      b'
			]);
	});

	test('Text should wrap', () => {
		assert.deepStrictEqual(
			formatOptions({
				// eslint-disable-next-line local/code-no-any-casts
				'add': o((<any>'bar ').repeat(9))
			}, 40),
			[
				'  --add        bar bar bar bar bar bar',
				'               bar bar bar'
			]);
	});

	test('Text should revert to the condensed view when the terminal is too narrow', () => {
		assert.deepStrictEqual(
			formatOptions({
				// eslint-disable-next-line local/code-no-any-casts
				'add': o((<any>'bar ').repeat(9))
			}, 30),
			[
				'  --add',
				'      bar bar bar bar bar bar bar bar bar '
			]);
	});

	test('tunnel, serve-web and chat parse, are refused by name and are not offered in the help', () => {
		const reporter: ErrorReporter = { onUnknownOption: () => { }, onMultipleValues: () => { }, onEmptyValue: () => { }, onDeprecatedOption: () => { } };
		assert.deepStrictEqual([...REFUSED_CLI_COMMANDS], ['tunnel', 'serve-web', 'chat']);
		for (const subcommand of REFUSED_CLI_COMMANDS) {
			const args = parseArgs([subcommand], OPTIONS, reporter);
			assert.deepStrictEqual(args._, [], `'${subcommand}' must not be taken for a path`);
			assert.strictEqual(refusedCliCommand(args), subcommand);
		}
		// control: an ordinary invocation is not refused
		assert.strictEqual(refusedCliCommand(parseArgs(['tunnel.txt', 'chat.md', '--wait'], OPTIONS, reporter)), undefined);
		const help = buildHelpMessage('Product', 'product', '1.0.0', OPTIONS);
		assert.ok(help.includes('--wait'), 'control: the help lists options');
		assert.ok(!/tunnel|serve-web|chat|Subcommands/.test(help), help);
	});

	test('options of removed areas are refused by name and are not offered in the help', () => {
		const reporter: ErrorReporter = { onUnknownOption: () => { }, onMultipleValues: () => { }, onEmptyValue: () => { }, onDeprecatedOption: () => { } };
		assert.deepStrictEqual([...REFUSED_CLI_OPTIONS], ['add-mcp', 'sync', 'telemetry', 'remote']);

		const refused: [string[], string][] = [
			[['--add-mcp', '{"name":"server-name","command":"x"}'], '--add-mcp'],
			[['--add-mcp='], '--add-mcp'],
			[['--sync', 'on'], '--sync'],
			[['--sync'], '--sync'],
			[['--telemetry'], '--telemetry'],
			[['--remote', 'ssh-remote+host'], '--remote'],
			[['--remote='], '--remote'],
			[['--folder-uri', 'vscode-remote://ssh-remote+host/home/user'], '--folder-uri vscode-remote://'],
			[['--file-uri', 'VSCODE-REMOTE://wsl+distro/home/file.txt'], '--file-uri vscode-remote://'],
			[['--folder-uri', 'file:///home/user', '--folder-uri', 'vscode-remote://ssh-remote+host/x'], '--folder-uri vscode-remote://'],
		];
		for (const [argv, expected] of refused) {
			assert.strictEqual(refusedCliOption(parseArgs(argv, OPTIONS, reporter)), expected, argv.join(' '));
		}

		// controls: the extension install CLI, local URIs and ordinary invocations are not refused
		const allowed: string[][] = [
			['--install-extension', 'publisher.name'],
			['--install-extension', 'publisher.name', '--force', '--pre-release', '--do-not-sync'],
			['--uninstall-extension', 'publisher.name'],
			['--list-extensions', '--show-versions'],
			['--update-extensions'],
			['--folder-uri', 'file:///home/user'],
			['--file-uri', 'vscode-userdata:///settings.json'],
			['--disable-telemetry'],
			['--wait', 'remote.txt', 'sync.md', 'telemetry.log'],
			[]
		];
		for (const argv of allowed) {
			assert.strictEqual(refusedCliOption(parseArgs(argv, OPTIONS, reporter)), undefined, argv.join(' '));
		}

		const help = buildHelpMessage('Product', 'product', '1.0.0', OPTIONS);
		assert.ok(help.includes('--install-extension'), 'control: the help lists the extension install option');
		assert.ok(!/--add-mcp|--sync|--telemetry|--remote|Model Context Protocol/.test(help), help);
	});

	test('a refused command line is an error naming what it refuses, never a result (the CLI exits non-zero)', () => {
		const reporter: ErrorReporter = { onUnknownOption: () => { }, onMultipleValues: () => { }, onEmptyValue: () => { }, onDeprecatedOption: () => { } };
		const refused: [string[], string][] = [
			[['tunnel'], `'tunnel' command not supported in product`],
			[['serve-web'], `'serve-web' command not supported in product`],
			[['chat'], `'chat' command not supported in product`],
			[['--add-mcp', '{"name":"server-name","command":"x"}'], `'--add-mcp' option not supported in product`],
			[['--sync', 'on'], `'--sync' option not supported in product`],
			[['--telemetry'], `'--telemetry' option not supported in product`],
			[['--remote', 'ssh-remote+host'], `'--remote' option not supported in product`],
			[['--folder-uri', 'vscode-remote://ssh-remote+host/home/user'], `'--folder-uri vscode-remote://' option not supported in product`],
		];
		for (const [argv, expected] of refused) {
			assert.throws(() => refuseRemovedCliArgs(parseArgs(argv, OPTIONS, reporter), 'product'), (error: Error) => error.message === expected, argv.join(' '));
		}

		// controls: the extension install CLI, local URIs and ordinary invocations are not refused
		const allowed: string[][] = [
			['--install-extension', 'publisher.name'],
			['--list-extensions', '--show-versions'],
			['--folder-uri', 'file:///home/user'],
			['--wait', 'tunnel.txt', 'chat.md', 'remote.txt'],
			[]
		];
		for (const argv of allowed) {
			assert.doesNotThrow(() => refuseRemovedCliArgs(parseArgs(argv, OPTIONS, reporter), 'product'), argv.join(' '));
		}
	});

	test('addArg', () => {
		assert.deepStrictEqual(addArg([], 'foo'), ['foo']);
		assert.deepStrictEqual(addArg([], 'foo', 'bar'), ['foo', 'bar']);
		assert.deepStrictEqual(addArg(['foo'], 'bar'), ['foo', 'bar']);
		assert.deepStrictEqual(addArg(['--wait'], 'bar'), ['--wait', 'bar']);
		assert.deepStrictEqual(addArg(['--wait', '--', '--foo'], 'bar'), ['--wait', 'bar', '--', '--foo']);
		assert.deepStrictEqual(addArg(['--', '--foo'], 'bar'), ['bar', '--', '--foo']);
	});

	test('subcommands', () => {
		assert.deepStrictEqual(
			formatOptions({
				'testcmd': c('A test command', { add: o('A test command option') })
			}, 30),
			[
				'  --testcmd',
				'      A test command'
			]);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});

suite('parseArgs', () => {
	function newErrorReporter(result: string[] = [], command = ''): ErrorReporter & { result: string[] } {
		const commandPrefix = command ? command + '-' : '';
		return {
			onDeprecatedOption: (deprecatedId) => result.push(`${commandPrefix}onDeprecatedOption ${deprecatedId}`),
			onUnknownOption: (id) => result.push(`${commandPrefix}onUnknownOption ${id}`),
			onEmptyValue: (id) => result.push(`${commandPrefix}onEmptyValue ${id}`),
			onMultipleValues: (id, usedValue) => result.push(`${commandPrefix}onMultipleValues ${id} ${usedValue}`),
			getSubcommandReporter: (c) => newErrorReporter(result, commandPrefix + c),
			result
		};
	}

	function assertParse<T>(options: OptionDescriptions<T>, input: string[], expected: T, expectedErrors: string[]) {
		const errorReporter = newErrorReporter();
		assert.deepStrictEqual(parseArgs(input, options, errorReporter), expected);
		assert.deepStrictEqual(errorReporter.result, expectedErrors);
	}

	test('subcommands', () => {

		interface TestArgs1 {
			testcmd?: {
				testArg?: string;
				_: string[];
			};
			_: string[];
		}

		const options1 = {
			'testcmd': c('A test command', {
				testArg: o('A test command option'),
				_: { type: 'string[]' }
			}),
			_: { type: 'string[]' }
		} as OptionDescriptions<TestArgs1>;
		assertParse(
			options1,
			['testcmd', '--testArg=foo'],
			{ testcmd: { testArg: 'foo', '_': [] }, '_': [] },
			[]
		);
		assertParse(
			options1,
			['testcmd', '--testArg=foo', '--testX'],
			{ testcmd: { testArg: 'foo', '_': [] }, '_': [] },
			['testcmd-onUnknownOption testX']
		);

		assertParse(
			options1,
			['--testArg=foo', 'testcmd', '--testX'],
			{ testcmd: { testArg: 'foo', '_': [] }, '_': [] },
			['testcmd-onUnknownOption testX']
		);

		assertParse(
			options1,
			['--testArg=foo', 'testcmd'],
			{ testcmd: { testArg: 'foo', '_': [] }, '_': [] },
			[]
		);

		assertParse(
			options1,
			['--testArg', 'foo', 'testcmd'],
			{ testcmd: { testArg: 'foo', '_': [] }, '_': [] },
			[]
		);

		interface TestArgs2 {
			testcmd?: {
				testArg?: string;
				testX?: boolean;
				_: string[];
			};
			testX?: boolean;
			_: string[];
		}

		const options2 = {
			'testcmd': c('A test command', {
				testArg: o('A test command option')
			}),
			testX: { type: 'boolean', global: true, description: '' },
			_: { type: 'string[]' }
		} as OptionDescriptions<TestArgs2>;
		assertParse(
			options2,
			['testcmd', '--testArg=foo', '--testX'],
			{ testcmd: { testArg: 'foo', testX: true, '_': [] }, '_': [] },
			[]
		);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
