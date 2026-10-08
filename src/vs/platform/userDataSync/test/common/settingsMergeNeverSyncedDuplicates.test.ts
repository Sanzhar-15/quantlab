/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { getIgnoredSettings, INeverSyncedPasses, merge, NeverSyncedSettingsError, removeNeverSyncedSettings, updateIgnoredSettings, updateIgnoredSettingsForRemote } from '../../common/settingsMerge.js';
import { assertNoNeverSynced, assertRawOccurrences, assertNoNeverSyncedProperty, assertOrdinaryKept, DEMO_EMAIL, DEMO_PASSWORD, IRawSettings, RawStyle, rawSettings, topLevelPropertyNames } from './rawNeverSyncedSettings.js';

// QuantLab F-SYNC-STRIP-1 (M1): content built to leave the machine holds NO occurrence of a never-synced key and none of its
// values, however many times the raw JSONC writes the key. The old strip removed one occurrence per key (setProperty removes
// the first match, the parser keeps the last duplicate), so a key written N times left N-1 occurrences in an upload.
suite('SettingsMerge - never-synced settings written more than once (STRIP-1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const formattingOptions = { eol: '\n', insertSpaces: false, tabSize: 4 };
	// What the workbench tombstone registration (`ignoreSync: true`) contributes to the default ignored settings.
	const ignored = getIgnoredSettings([DEMO_EMAIL, DEMO_PASSWORD], new TestConfigurationService());

	interface ICombination {
		readonly name: string;
		readonly keys: readonly string[];
		readonly occurrences: number;
		readonly style: RawStyle;
	}

	const keySets: { name: string; keys: readonly string[] }[] = [
		{ name: 'email', keys: [DEMO_EMAIL] },
		{ name: 'password', keys: [DEMO_PASSWORD] },
		{ name: 'both keys', keys: [DEMO_EMAIL, DEMO_PASSWORD] },
	];
	const combinations: ICombination[] = [];
	for (const { name, keys } of keySets) {
		for (const occurrences of [1, 4, 12]) {
			combinations.push({ name: `${name} x${occurrences} plain`, keys, occurrences, style: 'plain' });
		}
		for (const style of ['comments', 'trailing-comma', 'compact', 'escaped-key'] as const) {
			combinations.push({ name: `${name} x4 ${style}`, keys, occurrences: 4, style });
		}
	}
	// Only the credentials, with a trailing comma: removing the only property must not leave `{, }`.
	combinations.push({ name: 'both keys x4 keys-only-trailing-comma', keys: [DEMO_EMAIL, DEMO_PASSWORD], occurrences: 4, style: 'keys-only-trailing-comma' });
	combinations.push({ name: 'password x1 keys-only-trailing-comma', keys: [DEMO_PASSWORD], occurrences: 1, style: 'keys-only-trailing-comma' });

	const cleanRemote = '{\n\t"remote.x": 1\n}';
	const cleanLocal = '{\n\t"local.y": 2\n}';

	function assertOutbound(remoteContent: string | null, sentinels: readonly string[], ordinary: Readonly<Record<string, number>>, context: string): void {
		assert.ok(remoteContent !== null, `${context}: the path must produce remote content`);
		assertNoNeverSynced(remoteContent, sentinels, context);
		assertNoNeverSyncedProperty(remoteContent, context);
		assertOrdinaryKept(remoteContent, ordinary, context);
	}

	test('the fixture helper refuses text whose duplicates differ from the request', () => {
		const fixture = rawSettings([DEMO_EMAIL], 4, 'plain', 'SENTINEL', 'local');
		assert.strictEqual(fixture.text.split('"' + DEMO_EMAIL + '"').length - 1, 4);
		assert.deepStrictEqual(fixture.sentinels, ['SENTINEL-0', 'SENTINEL-1', 'SENTINEL-2', 'SENTINEL-3']);
		assert.throws(() => rawSettings([DEMO_EMAIL], 0, 'plain', 'SENTINEL', 'local'));
		// text that writes the key once is refused when four were asked for, and text that writes it four times when one was
		assert.throws(() => assertRawOccurrences('{ "' + DEMO_EMAIL + '": "x" }', [DEMO_EMAIL], 4), /asked for 4 occurrence/);
		assert.throws(() => assertRawOccurrences(fixture.text, [DEMO_EMAIL], 1), /asked for 1 occurrence/);
		assertRawOccurrences(fixture.text, [DEMO_EMAIL], 4);
	});

	for (const { name, keys, occurrences, style } of combinations) {

		// the settings the machine's own file holds, written `occurrences` times
		const local = (): IRawSettings => rawSettings(keys, occurrences, style, 'SENTINEL', 'local');
		// what a client from before the strip left on the server
		const remote = (): IRawSettings => rawSettings(keys, occurrences, style, 'REMOTE-SENTINEL', 'remote');

		test(`updateIgnoredSettingsForRemote against an empty remote: ${name}`, () => {
			const fixture = local();
			const actual = updateIgnoredSettingsForRemote(fixture.text, '{}', ignored, formattingOptions);
			assertOutbound(actual, fixture.sentinels, fixture.ordinary, name);
		});

		test(`updateIgnoredSettingsForRemote against a remote that holds the keys too: ${name}`, () => {
			const fixture = local();
			const other = remote();
			const actual = updateIgnoredSettingsForRemote(fixture.text, other.text, ignored, formattingOptions);
			assertOutbound(actual, [...fixture.sentinels, ...other.sentinels], fixture.ordinary, name);
		});

		test(`updateIgnoredSettingsForRemote with the keys opted back in by the user: ${name}`, () => {
			const fixture = local();
			const optedBackIn = getIgnoredSettings([DEMO_EMAIL, DEMO_PASSWORD], new TestConfigurationService({ 'settingsSync.ignoredSettings': ['-' + DEMO_EMAIL, '-' + DEMO_PASSWORD] }));
			const actual = updateIgnoredSettingsForRemote(fixture.text, '{}', optedBackIn, formattingOptions);
			assertOutbound(actual, fixture.sentinels, fixture.ordinary, name);
		});

		test(`updateIgnoredSettingsForRemote with no ignored settings passed: ${name}`, () => {
			const fixture = local();
			const actual = updateIgnoredSettingsForRemote(fixture.text, '{}', [], formattingOptions);
			assertOutbound(actual, fixture.sentinels, fixture.ordinary, name);
		});

		test(`merge remoteContent, local moved and remote did not: ${name}`, () => {
			const fixture = local();
			const result = merge(fixture.text, cleanRemote, cleanRemote, ignored, [], formattingOptions);
			assertOutbound(result.remoteContent, fixture.sentinels, fixture.ordinary, name);
		});

		test(`merge remoteContent, local moved and the remote holds the keys: ${name}`, () => {
			const fixture = local();
			const other = remote();
			const result = merge(fixture.text, other.text, null, ignored, [], formattingOptions);
			assertOutbound(result.remoteContent, [...fixture.sentinels, ...other.sentinels], { ...fixture.ordinary, ...other.ordinary }, name);
		});

		test(`merge remoteContent, local empty and never synced, the remote holds the keys: ${name}`, () => {
			const other = remote();
			const result = merge('{}', other.text, null, ignored, [], formattingOptions);
			assertOutbound(result.remoteContent, other.sentinels, other.ordinary, name);
		});

		test(`merge remoteContent, the remote holds the keys and local has its own change: ${name}`, () => {
			const other = remote();
			const result = merge(cleanLocal, other.text, cleanRemote, ignored, [], formattingOptions);
			assertOutbound(result.remoteContent, other.sentinels, { ...other.ordinary, 'local.y': 2 }, name);
		});

		test(`merge remoteContent, only the remote holds the keys and local matches the base: ${name}`, () => {
			const other = remote();
			const result = merge('{}', other.text, '{}', ignored, [], formattingOptions);
			// a remote that holds the keys must receive a change that removes them
			assertOutbound(result.remoteContent, other.sentinels, other.ordinary, name);
		});
	}

	test('ordinary settings and comments around the removed entries are kept', () => {
		const fixture = rawSettings([DEMO_PASSWORD], 4, 'comments', 'SENTINEL', 'local');
		const actual = updateIgnoredSettingsForRemote(fixture.text, '{}', ignored, formattingOptions);
		assertOutbound(actual, fixture.sentinels, fixture.ordinary, 'comments');
		assert.ok(actual.includes('"local.head": 1') && actual.includes('"local.tail": 2'), actual);
	});

	test('content without the keys is returned as the ordinary ignored settings alone rebuild it', () => {
		const local = '{\n\t// a comment\n\t"local.y": 2,\n}';
		assert.strictEqual(updateIgnoredSettingsForRemote(local, '{}', ignored, formattingOptions), local);
	});

	test('empty and comment-only content are not an error (the sync validator accepts them)', () => {
		for (const content of ['', '  ', '// only a comment\n', '/* only a comment */']) {
			assert.strictEqual(updateIgnoredSettingsForRemote(content, '{}', ignored, formattingOptions), content);
		}
	});

	test('a nested object that holds the key name is not a settings entry and is kept', () => {
		const local = '{\n\t"local.y": { "qic.demo.email": "nested" }\n}';
		assert.strictEqual(updateIgnoredSettingsForRemote(local, '{}', ignored, formattingOptions), local);
	});

	test('outbound content that does not parse is refused, naming no value', () => {
		const broken = '{ "local.y": 1 "qic.demo.email": "SENTINEL-broken" }';
		assert.throws(
			() => updateIgnoredSettingsForRemote(broken, '{}', ignored, formattingOptions),
			(error: unknown) => error instanceof NeverSyncedSettingsError && error.name === 'NeverSyncedSettingsError' && !error.message.includes('SENTINEL-broken')
		);
		assert.throws(
			() => updateIgnoredSettingsForRemote('{ "qic.demo.password": "SENTINEL-open"', '{}', ignored, formattingOptions),
			(error: unknown) => error instanceof NeverSyncedSettingsError && !error.message.includes('SENTINEL-open')
		);
	});

	test('a merge whose local content does not parse is refused (the sync validates it first)', () => {
		assert.throws(
			() => merge('{ "local.y": 1 "qic.demo.email": "SENTINEL-broken" }', cleanRemote, cleanRemote, ignored, [], formattingOptions),
			(error: unknown) => error instanceof NeverSyncedSettingsError && !error.message.includes('SENTINEL-broken')
		);
	});

	// A remote that does not parse is not refused: the merge reads it as the tolerant parser does, every occurrence of the keys
	// is removed from what is uploaded, and the result is checked. (Here the removal also repairs the missing comma.)
	test('a remote that does not parse and holds a key is uploaded without it', () => {
		const brokenRemote = '{ "remote.x": 1 "qic.demo.email": "SENTINEL-broken" }';
		const result = merge('{}', brokenRemote, null, ignored, [], formattingOptions);
		assertOutbound(result.remoteContent, ['SENTINEL-broken'], { 'remote.x': 1 }, 'broken remote');
	});

	// What upstream uploads for content without a never-synced key is not changed, syntax errors included: removing every
	// ordinary setting from `{ "a": 1, }` leaves `{ , }` and upstream uploads it.
	test('content without the keys comes back byte for byte as the ordinary ignored settings alone build it', () => {
		const contents = [
			'{\n\t// Machine\n\t"machine.a": 1,\n\t"machine.b": 2,\n}',
			'{\n\t"machine.a": 1,\n}',
			'{\n\t"local.y": 2,\n\t"machine.a": 1\n}',
			'{}',
		];
		for (const content of contents) {
			assert.strictEqual(
				updateIgnoredSettingsForRemote(content, '{}', [...ignored, 'machine.a', 'machine.b'], formattingOptions),
				updateIgnoredSettings(content, '{}', [...ignored, 'machine.a', 'machine.b'], formattingOptions)
			);
		}
	});

	// QuantLab F-SYNC-STRIP-2 (S1, B1): the removal makes a bounded number of full-document passes whatever the duplicate count.
	// The bound is frozen here, before any run: one traversal collects the ranges, one traversal checks the result, one parse
	// reads the object (STRIP-1 repeated all of these once per duplicate, so its cost grew with the square of the count).
	const MAX_FULL_DOCUMENT_PASSES = 3;

	test('the removal makes at most 3 full-document passes, however many duplicates the content holds', () => {
		const counts: number[] = [];
		for (const occurrences of [1, 4, 100, 2000]) {
			const fixture = rawSettings([DEMO_EMAIL, DEMO_PASSWORD], occurrences, 'plain', 'SENTINEL', 'local');
			const passes: INeverSyncedPasses = { fullDocumentPasses: 0 };
			const actual = removeNeverSyncedSettings(fixture.text, formattingOptions, passes);
			// every sentinel value starts with the fixture tag: one scan for all of them
			assertOutbound(actual, ['SENTINEL-'], fixture.ordinary, `${occurrences} duplicates of each key`);
			assert.ok(passes.fullDocumentPasses <= MAX_FULL_DOCUMENT_PASSES, `${occurrences} duplicates of each key took ${passes.fullDocumentPasses} full-document passes`);
			counts.push(passes.fullDocumentPasses);
		}
		assert.deepStrictEqual(counts, [counts[0], counts[0], counts[0], counts[0]], 'the pass count must not depend on the duplicate count');
	});

	test('content that holds no key is read in at most 3 passes and comes back unchanged', () => {
		const passes: INeverSyncedPasses = { fullDocumentPasses: 0 };
		const content = '{\n\t// a comment\n\t"local.y": 2,\n}';
		assert.strictEqual(removeNeverSyncedSettings(content, formattingOptions, passes), content);
		assert.ok(passes.fullDocumentPasses >= 1 && passes.fullDocumentPasses <= MAX_FULL_DOCUMENT_PASSES, String(passes.fullDocumentPasses));
	});

	test('2,000 duplicates of each key: the outbound content is clean through every outbound entry point', () => {
		const fixture = rawSettings([DEMO_EMAIL, DEMO_PASSWORD], 2000, 'plain', 'SENTINEL', 'local');
		assertOutbound(updateIgnoredSettingsForRemote(fixture.text, '{}', ignored, formattingOptions), ['SENTINEL-'], fixture.ordinary, 'updateIgnoredSettingsForRemote');
		assertOutbound(merge(fixture.text, cleanRemote, cleanRemote, ignored, [], formattingOptions).remoteContent, ['SENTINEL-'], fixture.ordinary, 'merge');
	});

	// The shape of the batch: exact strings, one per kind of run. A run takes the comma that joined it to the kept property
	// before it; a run that opens the object takes what leads up to the next kept property (and is formatted as setProperty
	// formats it); when nothing is kept, a trailing comma goes with the last property.
	test('the batch of removals leaves the kept properties and their commas as setProperty does', () => {
		const email = '"qic.demo.email": "x"';
		const password = '"qic.demo.password": "y"';
		const cases: { name: string; input: string; expected: string }[] = [
			{ name: 'a key between kept properties', input: `{\n\t"a": 1,\n\t${email},\n\t"b": 2\n}`, expected: '{\n\t"a": 1,\n\t"b": 2\n}' },
			{ name: 'the last key after a kept property', input: `{\n\t"a": 1,\n\t${email}\n}`, expected: '{\n\t"a": 1\n}' },
			{ name: 'the last key, a trailing comma follows', input: `{\n\t"a": 1,\n\t${email},\n}`, expected: '{\n\t"a": 1,\n}' },
			{ name: 'the first key', input: `{\n\t${email},\n\t"a": 1\n}`, expected: '{\n\t"a": 1\n}' },
			{ name: 'two adjacent keys in the middle', input: `{\n\t"a": 1,\n\t${email},\n\t${password},\n\t"b": 2\n}`, expected: '{\n\t"a": 1,\n\t"b": 2\n}' },
			{ name: 'keys at the start, in the middle and at the end', input: `{\n\t${email},\n\t"a": 1,\n\t${password},\n\t${email},\n\t"b": 2,\n\t${password}\n}`, expected: '{\n\t"a": 1,\n\t"b": 2\n}' },
			{ name: 'the only property, no comma', input: `{\n\t${email}\n}`, expected: '{\n}' },
			{ name: 'the only property, a trailing comma follows', input: `{\n\t${email},\n}`, expected: '{\n}' },
			{ name: 'only keys, a trailing comma follows', input: `{\n\t${email},\n\t${password},\n\t${email},\n}`, expected: '{\n}' },
			{ name: 'compact, the only property', input: `{${email}}`, expected: '{}' },
		];
		for (const { name, input, expected } of cases) {
			assert.strictEqual(removeNeverSyncedSettings(input, formattingOptions), expected, name);
		}
	});

	test('the only setting is a never-synced key and a comma follows it: the result parses', () => {
		const actual = updateIgnoredSettingsForRemote('{\n\t"qic.demo.password": "SENTINEL-0",\n}', '{}', ignored, formattingOptions);
		assert.deepStrictEqual(topLevelPropertyNames(actual), []);
		assert.ok(!actual.includes('SENTINEL-0'));
	});
});
