/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { addSetting, getIgnoredSettings, merge, updateIgnoredSettings, updateIgnoredSettingsForRemote } from '../../common/settingsMerge.js';
import type { IConflictSetting } from '../../common/userDataSync.js';

const formattingOptions = { eol: '\n', insertSpaces: false, tabSize: 4 };

suite('SettingsMerge - Merge', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('merge when local and remote are same with one entry', async () => {
		const localContent = stringify({ 'a': 1 });
		const remoteContent = stringify({ 'a': 1 });
		const actual = merge(localContent, remoteContent, null, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when local and remote are same with multiple entries', async () => {
		const localContent = stringify({
			'a': 1,
			'b': 2
		});
		const remoteContent = stringify({
			'a': 1,
			'b': 2
		});
		const actual = merge(localContent, remoteContent, null, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when local and remote are same with multiple entries in different order', async () => {
		const localContent = stringify({
			'b': 2,
			'a': 1,
		});
		const remoteContent = stringify({
			'a': 1,
			'b': 2
		});
		const actual = merge(localContent, remoteContent, null, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, localContent);
		assert.strictEqual(actual.remoteContent, remoteContent);
		assert.ok(actual.hasConflicts);
		assert.strictEqual(actual.conflictsSettings.length, 0);
	});

	test('merge when local and remote are same with different base content', async () => {
		const localContent = stringify({
			'b': 2,
			'a': 1,
		});
		const baseContent = stringify({
			'a': 2,
			'b': 1
		});
		const remoteContent = stringify({
			'a': 1,
			'b': 2
		});
		const actual = merge(localContent, remoteContent, baseContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, localContent);
		assert.strictEqual(actual.remoteContent, remoteContent);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(actual.hasConflicts);
	});

	test('merge when a new entry is added to remote', async () => {
		const localContent = stringify({
			'a': 1,
		});
		const remoteContent = stringify({
			'a': 1,
			'b': 2
		});
		const actual = merge(localContent, remoteContent, null, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, remoteContent);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when multiple new entries are added to remote', async () => {
		const localContent = stringify({
			'a': 1,
		});
		const remoteContent = stringify({
			'a': 1,
			'b': 2,
			'c': 3,
		});
		const actual = merge(localContent, remoteContent, null, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, remoteContent);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when multiple new entries are added to remote from base and local has not changed', async () => {
		const localContent = stringify({
			'a': 1,
		});
		const remoteContent = stringify({
			'b': 2,
			'a': 1,
			'c': 3,
		});
		const actual = merge(localContent, remoteContent, localContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, remoteContent);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when an entry is removed from remote from base and local has not changed', async () => {
		const localContent = stringify({
			'a': 1,
			'b': 2,
		});
		const remoteContent = stringify({
			'a': 1,
		});
		const actual = merge(localContent, remoteContent, localContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, remoteContent);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when all entries are removed from base and local has not changed', async () => {
		const localContent = stringify({
			'a': 1,
		});
		const remoteContent = stringify({});
		const actual = merge(localContent, remoteContent, localContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, remoteContent);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when an entry is updated in remote from base and local has not changed', async () => {
		const localContent = stringify({
			'a': 1,
		});
		const remoteContent = stringify({
			'a': 2
		});
		const actual = merge(localContent, remoteContent, localContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, remoteContent);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when remote has moved forwareded with multiple changes and local stays with base', async () => {
		const localContent = stringify({
			'a': 1,
		});
		const remoteContent = stringify({
			'a': 2,
			'b': 1,
			'c': 3,
			'd': 4,
		});
		const actual = merge(localContent, remoteContent, localContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, remoteContent);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when remote has moved forwareded with order changes and local stays with base', async () => {
		const localContent = stringify({
			'a': 1,
			'b': 2,
			'c': 3,
		});
		const remoteContent = stringify({
			'a': 2,
			'd': 4,
			'c': 3,
			'b': 2,
		});
		const actual = merge(localContent, remoteContent, localContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, remoteContent);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when remote has moved forwareded with comment changes and local stays with base', async () => {
		const localContent = `
{
	// this is comment for b
	"b": 2,
	// this is comment for c
	"c": 1,
}`;
		const remoteContent = stringify`
{
	// comment b has changed
	"b": 2,
	// this is comment for c
	"c": 1,
}`;
		const actual = merge(localContent, remoteContent, localContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, remoteContent);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when remote has moved forwareded with comment and order changes and local stays with base', async () => {
		const localContent = `
{
	// this is comment for b
	"b": 2,
	// this is comment for c
	"c": 1,
}`;
		const remoteContent = stringify`
{
	// this is comment for c
	"c": 1,
	// comment b has changed
	"b": 2,
}`;
		const actual = merge(localContent, remoteContent, localContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, remoteContent);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when a new entries are added to local', async () => {
		const localContent = stringify({
			'a': 1,
			'b': 2,
			'c': 3,
			'd': 4,
		});
		const remoteContent = stringify({
			'a': 1,
		});
		const actual = merge(localContent, remoteContent, null, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, localContent);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when multiple new entries are added to local from base and remote is not changed', async () => {
		const localContent = stringify({
			'a': 2,
			'b': 1,
			'c': 3,
			'd': 4,
		});
		const remoteContent = stringify({
			'a': 1,
		});
		const actual = merge(localContent, remoteContent, remoteContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, localContent);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when an entry is removed from local from base and remote has not changed', async () => {
		const localContent = stringify({
			'a': 1,
			'c': 2
		});
		const remoteContent = stringify({
			'a': 2,
			'b': 1,
			'c': 3,
			'd': 4,
		});
		const actual = merge(localContent, remoteContent, remoteContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, localContent);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when an entry is updated in local from base and remote has not changed', async () => {
		const localContent = stringify({
			'a': 1,
			'c': 2
		});
		const remoteContent = stringify({
			'a': 2,
			'c': 2,
		});
		const actual = merge(localContent, remoteContent, remoteContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, localContent);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when local has moved forwarded with multiple changes and remote stays with base', async () => {
		const localContent = stringify({
			'a': 2,
			'b': 1,
			'c': 3,
			'd': 4,
		});
		const remoteContent = stringify({
			'a': 1,
		});
		const actual = merge(localContent, remoteContent, remoteContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, localContent);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when local has moved forwarded with order changes and remote stays with base', async () => {
		const localContent = `
{
	"b": 2,
	"c": 1,
}`;
		const remoteContent = stringify`
{
	"c": 1,
	"b": 2,
}`;
		const actual = merge(localContent, remoteContent, remoteContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, localContent);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when local has moved forwarded with comment changes and remote stays with base', async () => {
		const localContent = `
{
	// comment for b has changed
	"b": 2,
	// comment for c
	"c": 1,
}`;
		const remoteContent = stringify`
{
	// comment for b
	"b": 2,
	// comment for c
	"c": 1,
}`;
		const actual = merge(localContent, remoteContent, remoteContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, localContent);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when local has moved forwarded with comment and order changes and remote stays with base', async () => {
		const localContent = `
{
	// comment for c
	"c": 1,
	// comment for b has changed
	"b": 2,
}`;
		const remoteContent = stringify`
{
	// comment for b
	"b": 2,
	// comment for c
	"c": 1,
}`;
		const actual = merge(localContent, remoteContent, remoteContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, localContent);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('merge when local and remote with one entry but different value', async () => {
		const localContent = stringify({
			'a': 1
		});
		const remoteContent = stringify({
			'a': 2
		});
		const expectedConflicts: IConflictSetting[] = [{ key: 'a', localValue: 1, remoteValue: 2 }];
		const actual = merge(localContent, remoteContent, null, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, localContent);
		assert.strictEqual(actual.remoteContent, remoteContent);
		assert.ok(actual.hasConflicts);
		assert.deepStrictEqual(actual.conflictsSettings, expectedConflicts);
	});

	test('merge when the entry is removed in remote but updated in local and a new entry is added in remote', async () => {
		const baseContent = stringify({
			'a': 1
		});
		const localContent = stringify({
			'a': 2
		});
		const remoteContent = stringify({
			'b': 2
		});
		const expectedConflicts: IConflictSetting[] = [{ key: 'a', localValue: 2, remoteValue: undefined }];
		const actual = merge(localContent, remoteContent, baseContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, stringify({
			'a': 2,
			'b': 2
		}));
		assert.strictEqual(actual.remoteContent, remoteContent);
		assert.ok(actual.hasConflicts);
		assert.deepStrictEqual(actual.conflictsSettings, expectedConflicts);
	});

	test('merge with single entry and local is empty', async () => {
		const baseContent = stringify({
			'a': 1
		});
		const localContent = stringify({});
		const remoteContent = stringify({
			'a': 2
		});
		const expectedConflicts: IConflictSetting[] = [{ key: 'a', localValue: undefined, remoteValue: 2 }];
		const actual = merge(localContent, remoteContent, baseContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, localContent);
		assert.strictEqual(actual.remoteContent, remoteContent);
		assert.ok(actual.hasConflicts);
		assert.deepStrictEqual(actual.conflictsSettings, expectedConflicts);
	});

	test('merge when local and remote has moved forwareded with conflicts', async () => {
		const baseContent = stringify({
			'a': 1,
			'b': 2,
			'c': 3,
			'd': 4,
		});
		const localContent = stringify({
			'a': 2,
			'c': 3,
			'd': 5,
			'e': 4,
			'f': 1,
		});
		const remoteContent = stringify({
			'b': 3,
			'c': 3,
			'd': 6,
			'e': 5,
		});
		const expectedConflicts: IConflictSetting[] = [
			{ key: 'b', localValue: undefined, remoteValue: 3 },
			{ key: 'a', localValue: 2, remoteValue: undefined },
			{ key: 'd', localValue: 5, remoteValue: 6 },
			{ key: 'e', localValue: 4, remoteValue: 5 },
		];
		const actual = merge(localContent, remoteContent, baseContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, stringify({
			'a': 2,
			'c': 3,
			'd': 5,
			'e': 4,
			'f': 1,
		}));
		assert.strictEqual(actual.remoteContent, stringify({
			'b': 3,
			'c': 3,
			'd': 6,
			'e': 5,
			'f': 1,
		}));
		assert.ok(actual.hasConflicts);
		assert.deepStrictEqual(actual.conflictsSettings, expectedConflicts);
	});

	test('merge when local and remote has moved forwareded with change in order', async () => {
		const baseContent = stringify({
			'a': 1,
			'b': 2,
			'c': 3,
			'd': 4,
		});
		const localContent = stringify({
			'a': 2,
			'c': 3,
			'b': 2,
			'd': 4,
			'e': 5,
		});
		const remoteContent = stringify({
			'a': 1,
			'b': 2,
			'c': 4,
		});
		const actual = merge(localContent, remoteContent, baseContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, stringify({
			'a': 2,
			'c': 4,
			'b': 2,
			'e': 5,
		}));
		assert.strictEqual(actual.remoteContent, stringify({
			'a': 2,
			'b': 2,
			'e': 5,
			'c': 4,
		}));
		assert.ok(actual.hasConflicts);
		assert.deepStrictEqual(actual.conflictsSettings, []);
	});

	test('merge when local and remote has moved forwareded with comment changes', async () => {
		const baseContent = `
{
	// this is comment for b
	"b": 2,
	// this is comment for c
	"c": 1
}`;
		const localContent = `
{
	// comment b has changed in local
	"b": 2,
	// this is comment for c
	"c": 1
}`;
		const remoteContent = `
{
	// comment b has changed in remote
	"b": 2,
	// this is comment for c
	"c": 1
}`;
		const actual = merge(localContent, remoteContent, baseContent, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, localContent);
		assert.strictEqual(actual.remoteContent, remoteContent);
		assert.ok(actual.hasConflicts);
		assert.deepStrictEqual(actual.conflictsSettings, []);
	});

	test('resolve when local and remote has moved forwareded with resolved conflicts', async () => {
		const baseContent = stringify({
			'a': 1,
			'b': 2,
			'c': 3,
			'd': 4,
		});
		const localContent = stringify({
			'a': 2,
			'c': 3,
			'd': 5,
			'e': 4,
			'f': 1,
		});
		const remoteContent = stringify({
			'b': 3,
			'c': 3,
			'd': 6,
			'e': 5,
		});
		const expectedConflicts: IConflictSetting[] = [
			{ key: 'd', localValue: 5, remoteValue: 6 },
		];
		const actual = merge(localContent, remoteContent, baseContent, [], [{ key: 'a', value: 2 }, { key: 'b', value: undefined }, { key: 'e', value: 5 }], formattingOptions);
		assert.strictEqual(actual.localContent, stringify({
			'a': 2,
			'c': 3,
			'd': 5,
			'e': 5,
			'f': 1,
		}));
		assert.strictEqual(actual.remoteContent, stringify({
			'c': 3,
			'd': 6,
			'e': 5,
			'f': 1,
			'a': 2,
		}));
		assert.ok(actual.hasConflicts);
		assert.deepStrictEqual(actual.conflictsSettings, expectedConflicts);
	});

	test('ignored setting is not merged when changed in local and remote', async () => {
		const localContent = stringify({ 'a': 1 });
		const remoteContent = stringify({ 'a': 2 });
		const actual = merge(localContent, remoteContent, null, ['a'], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('ignored setting is not merged when changed in local and remote from base', async () => {
		const baseContent = stringify({ 'a': 0 });
		const localContent = stringify({ 'a': 1 });
		const remoteContent = stringify({ 'a': 2 });
		const actual = merge(localContent, remoteContent, baseContent, ['a'], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('ignored setting is not merged when added in remote', async () => {
		const localContent = stringify({});
		const remoteContent = stringify({ 'a': 1 });
		const actual = merge(localContent, remoteContent, null, ['a'], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('ignored setting is not merged when added in remote from base', async () => {
		const localContent = stringify({ 'b': 2 });
		const remoteContent = stringify({ 'a': 1, 'b': 2 });
		const actual = merge(localContent, remoteContent, localContent, ['a'], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('ignored setting is not merged when removed in remote', async () => {
		const localContent = stringify({ 'a': 1 });
		const remoteContent = stringify({});
		const actual = merge(localContent, remoteContent, null, ['a'], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('ignored setting is not merged when removed in remote from base', async () => {
		const localContent = stringify({ 'a': 2 });
		const remoteContent = stringify({});
		const actual = merge(localContent, remoteContent, localContent, ['a'], [], formattingOptions);
		assert.strictEqual(actual.localContent, null);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('ignored setting is not merged with other changes without conflicts', async () => {
		const baseContent = stringify({
			'a': 2,
			'b': 2,
			'c': 3,
			'd': 4,
			'e': 5,
		});
		const localContent = stringify({
			'a': 1,
			'b': 2,
			'c': 3,
		});
		const remoteContent = stringify({
			'a': 3,
			'b': 3,
			'd': 4,
			'e': 6,
		});
		const actual = merge(localContent, remoteContent, baseContent, ['a', 'e'], [], formattingOptions);
		assert.strictEqual(actual.localContent, stringify({
			'a': 1,
			'b': 3,
		}));
		assert.strictEqual(actual.remoteContent, stringify({
			'a': 3,
			'b': 3,
			'e': 6,
		}));
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});

	test('ignored setting is not merged with other changes conflicts', async () => {
		const baseContent = stringify({
			'a': 2,
			'b': 2,
			'c': 3,
			'd': 4,
			'e': 5,
		});
		const localContent = stringify({
			'a': 1,
			'b': 4,
			'c': 3,
			'd': 5,
		});
		const remoteContent = stringify({
			'a': 3,
			'b': 3,
			'e': 6,
		});
		const expectedConflicts: IConflictSetting[] = [
			{ key: 'd', localValue: 5, remoteValue: undefined },
			{ key: 'b', localValue: 4, remoteValue: 3 },
		];
		const actual = merge(localContent, remoteContent, baseContent, ['a', 'e'], [], formattingOptions);
		assert.strictEqual(actual.localContent, stringify({
			'a': 1,
			'b': 4,
			'd': 5,
		}));
		assert.strictEqual(actual.remoteContent, stringify({
			'a': 3,
			'b': 3,
			'e': 6,
		}));
		assert.deepStrictEqual(actual.conflictsSettings, expectedConflicts);
		assert.ok(actual.hasConflicts);
	});

	test('merge when remote has comments and local is empty', async () => {
		const localContent = `
{

}`;
		const remoteContent = stringify`
{
	// this is a comment
	"a": 1,
}`;
		const actual = merge(localContent, remoteContent, null, [], [], formattingOptions);
		assert.strictEqual(actual.localContent, remoteContent);
		assert.strictEqual(actual.remoteContent, null);
		assert.strictEqual(actual.conflictsSettings.length, 0);
		assert.ok(!actual.hasConflicts);
	});
});

suite('SettingsMerge - Compute Remote Content', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('local content is returned when there are no ignored settings', async () => {
		const localContent = stringify({
			'a': 1,
			'b': 2,
			'c': 3,
		});
		const remoteContent = stringify({
			'a': 3,
			'b': 3,
			'd': 4,
			'e': 6,
		});
		const actual = updateIgnoredSettings(localContent, remoteContent, [], formattingOptions);
		assert.strictEqual(actual, localContent);
	});

	test('when target content is empty', async () => {
		const remoteContent = stringify({
			'a': 3,
		});
		const actual = updateIgnoredSettings('', remoteContent, ['a'], formattingOptions);
		assert.strictEqual(actual, '');
	});

	test('when source content is empty', async () => {
		const localContent = stringify({
			'a': 3,
			'b': 3,
		});
		const expected = stringify({
			'b': 3,
		});
		const actual = updateIgnoredSettings(localContent, '', ['a'], formattingOptions);
		assert.strictEqual(actual, expected);
	});

	test('ignored settings are not updated from remote content', async () => {
		const localContent = stringify({
			'a': 1,
			'b': 2,
			'c': 3,
		});
		const remoteContent = stringify({
			'a': 3,
			'b': 3,
			'd': 4,
			'e': 6,
		});
		const expected = stringify({
			'a': 3,
			'b': 2,
			'c': 3,
		});
		const actual = updateIgnoredSettings(localContent, remoteContent, ['a'], formattingOptions);
		assert.strictEqual(actual, expected);
	});

});

suite('SettingsMerge - Add Setting', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Insert after a setting without comments', () => {

		const sourceContent = `
{
	"a": 1,
	"b": 2,
	"c": 3
}`;
		const targetContent = `
{
	"a": 2,
	"d": 3
}`;

		const expected = `
{
	"a": 2,
	"b": 2,
	"d": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert after a setting without comments at the end', () => {

		const sourceContent = `
{
	"a": 1,
	"b": 2,
	"c": 3
}`;
		const targetContent = `
{
	"a": 2
}`;

		const expected = `
{
	"a": 2,
	"b": 2
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert between settings without comment', () => {

		const sourceContent = `
{
	"a": 1,
	"b": 2,
	"c": 3
}`;
		const targetContent = `
{
	"a": 1,
	"c": 3
}`;

		const expected = `
{
	"a": 1,
	"b": 2,
	"c": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert between settings and there is a comment in between in source', () => {

		const sourceContent = `
{
	"a": 1,
	// this is comment for b
	"b": 2,
	"c": 3
}`;
		const targetContent = `
{
	"a": 1,
	"c": 3
}`;

		const expected = `
{
	"a": 1,
	"b": 2,
	"c": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert after a setting and after a comment at the end', () => {

		const sourceContent = `
{
	"a": 1,
	// this is comment for b
	"b": 2
}`;
		const targetContent = `
{
	"a": 1
	// this is comment for b
}`;

		const expected = `
{
	"a": 1,
	// this is comment for b
	"b": 2
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert after a setting ending with comma and after a comment at the end', () => {

		const sourceContent = `
{
	"a": 1,
	// this is comment for b
	"b": 2
}`;
		const targetContent = `
{
	"a": 1,
	// this is comment for b
}`;

		const expected = `
{
	"a": 1,
	// this is comment for b
	"b": 2
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert after a comment and there are no settings', () => {

		const sourceContent = `
{
	// this is comment for b
	"b": 2
}`;
		const targetContent = `
{
	// this is comment for b
}`;

		const expected = `
{
	// this is comment for b
	"b": 2
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert after a setting and between a comment and setting', () => {

		const sourceContent = `
{
	"a": 1,
	// this is comment for b
	"b": 2,
	"c": 3
}`;
		const targetContent = `
{
	"a": 1,
	// this is comment for b
	"c": 3
}`;

		const expected = `
{
	"a": 1,
	// this is comment for b
	"b": 2,
	"c": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert after a setting between two comments and there is a setting after', () => {

		const sourceContent = `
{
	"a": 1,
	// this is comment for b
	"b": 2,
	// this is comment for c
	"c": 3
}`;
		const targetContent = `
{
	"a": 1,
	// this is comment for b
	// this is comment for c
	"c": 3
}`;

		const expected = `
{
	"a": 1,
	// this is comment for b
	"b": 2,
	// this is comment for c
	"c": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert after a setting between two comments on the same line and there is a setting after', () => {

		const sourceContent = `
{
	"a": 1,
	/* this is comment for b */
	"b": 2,
	// this is comment for c
	"c": 3
}`;
		const targetContent = `
{
	"a": 1,
	/* this is comment for b */ // this is comment for c
	"c": 3
}`;

		const expected = `
{
	"a": 1,
	/* this is comment for b */
	"b": 2, // this is comment for c
	"c": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert after a setting between two line comments on the same line and there is a setting after', () => {

		const sourceContent = `
{
	"a": 1,
	/* this is comment for b */
	"b": 2,
	// this is comment for c
	"c": 3
}`;
		const targetContent = `
{
	"a": 1,
	// this is comment for b // this is comment for c
	"c": 3
}`;

		const expected = `
{
	"a": 1,
	// this is comment for b // this is comment for c
	"b": 2,
	"c": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert after a setting between two comments and there is no setting after', () => {

		const sourceContent = `
{
	"a": 1,
	// this is comment for b
	"b": 2
	// this is a comment
}`;
		const targetContent = `
{
	"a": 1
	// this is comment for b
	// this is a comment
}`;

		const expected = `
{
	"a": 1,
	// this is comment for b
	"b": 2
	// this is a comment
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert after a setting with comma and between two comments and there is no setting after', () => {

		const sourceContent = `
{
	"a": 1,
	// this is comment for b
	"b": 2
	// this is a comment
}`;
		const targetContent = `
{
	"a": 1,
	// this is comment for b
	// this is a comment
}`;

		const expected = `
{
	"a": 1,
	// this is comment for b
	"b": 2
	// this is a comment
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});
	test('Insert before a setting without comments', () => {

		const sourceContent = `
{
	"a": 1,
	"b": 2,
	"c": 3
}`;
		const targetContent = `
{
	"d": 2,
	"c": 3
}`;

		const expected = `
{
	"d": 2,
	"b": 2,
	"c": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert before a setting without comments at the end', () => {

		const sourceContent = `
{
	"a": 1,
	"b": 2,
	"c": 3
}`;
		const targetContent = `
{
	"c": 3
}`;

		const expected = `
{
	"b": 2,
	"c": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert before a setting with comment', () => {

		const sourceContent = `
{
	"a": 1,
	"b": 2,
	// this is comment for c
	"c": 3
}`;
		const targetContent = `
{
	// this is comment for c
	"c": 3
}`;

		const expected = `
{
	"b": 2,
	// this is comment for c
	"c": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert before a setting and before a comment at the beginning', () => {

		const sourceContent = `
{
	// this is comment for b
	"b": 2,
	"c": 3,
}`;
		const targetContent = `
{
	// this is comment for b
	"c": 3
}`;

		const expected = `
{
	// this is comment for b
	"b": 2,
	"c": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert before a setting ending with comma and before a comment at the begninning', () => {

		const sourceContent = `
{
	// this is comment for b
	"b": 2,
	"c": 3,
}`;
		const targetContent = `
{
	// this is comment for b
	"c": 3,
}`;

		const expected = `
{
	// this is comment for b
	"b": 2,
	"c": 3,
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert before a setting and between a setting and comment', () => {

		const sourceContent = `
{
	"a": 1,
	// this is comment for b
	"b": 2,
	"c": 3
}`;
		const targetContent = `
{
	"d": 1,
	// this is comment for b
	"c": 3
}`;

		const expected = `
{
	"d": 1,
	// this is comment for b
	"b": 2,
	"c": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert before a setting between two comments and there is a setting before', () => {

		const sourceContent = `
{
	"a": 1,
	// this is comment for b
	"b": 2,
	// this is comment for c
	"c": 3
}`;
		const targetContent = `
{
	"d": 1,
	// this is comment for b
	// this is comment for c
	"c": 3
}`;

		const expected = `
{
	"d": 1,
	// this is comment for b
	"b": 2,
	// this is comment for c
	"c": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert before a setting between two comments on the same line and there is a setting before', () => {

		const sourceContent = `
{
	"a": 1,
	/* this is comment for b */
	"b": 2,
	// this is comment for c
	"c": 3
}`;
		const targetContent = `
{
	"d": 1,
	/* this is comment for b */ // this is comment for c
	"c": 3
}`;

		const expected = `
{
	"d": 1,
	/* this is comment for b */
	"b": 2,
	// this is comment for c
	"c": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert before a setting between two line comments on the same line and there is a setting before', () => {

		const sourceContent = `
{
	"a": 1,
	/* this is comment for b */
	"b": 2,
	// this is comment for c
	"c": 3
}`;
		const targetContent = `
{
	"d": 1,
	// this is comment for b // this is comment for c
	"c": 3
}`;

		const expected = `
{
	"d": 1,
	"b": 2,
	// this is comment for b // this is comment for c
	"c": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert before a setting between two comments and there is no setting before', () => {

		const sourceContent = `
{
	// this is comment for b
	"b": 2,
	// this is comment for c
	"c": 1
}`;
		const targetContent = `
{
	// this is comment for b
	// this is comment for c
	"c": 1
}`;

		const expected = `
{
	// this is comment for b
	"b": 2,
	// this is comment for c
	"c": 1
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert before a setting with comma and between two comments and there is no setting before', () => {

		const sourceContent = `
{
	// this is comment for b
	"b": 2,
	// this is comment for c
	"c": 1
}`;
		const targetContent = `
{
	// this is comment for b
	// this is comment for c
	"c": 1,
}`;

		const expected = `
{
	// this is comment for b
	"b": 2,
	// this is comment for c
	"c": 1,
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert after a setting that is of object type', () => {

		const sourceContent = `
{
	"b": {
		"d": 1
	},
	"a": 2,
	"c": 1
}`;
		const targetContent = `
{
	"b": {
		"d": 1
	},
	"c": 1
}`;

		const actual = addSetting('a', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, sourceContent);
	});

	test('Insert after a setting that is of array type', () => {

		const sourceContent = `
{
	"b": [
		1
	],
	"a": 2,
	"c": 1
}`;
		const targetContent = `
{
	"b": [
		1
	],
	"c": 1
}`;

		const actual = addSetting('a', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, sourceContent);
	});

	test('Insert after a comment with comma separator of previous setting and no next nodes ', () => {

		const sourceContent = `
{
	"a": 1
	// this is comment for a
	,
	"b": 2
}`;
		const targetContent = `
{
	"a": 1
	// this is comment for a
	,
}`;

		const expected = `
{
	"a": 1
	// this is comment for a
	,
	"b": 2
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert after a comment with comma separator of previous setting and there is a setting after ', () => {

		const sourceContent = `
{
	"a": 1
	// this is comment for a
	,
	"b": 2,
	"c": 3
}`;
		const targetContent = `
{
	"a": 1
	// this is comment for a
	,
	"c": 3
}`;

		const expected = `
{
	"a": 1
	// this is comment for a
	,
	"b": 2,
	"c": 3
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});

	test('Insert after a comment with comma separator of previous setting and there is a comment after ', () => {

		const sourceContent = `
{
	"a": 1
	// this is comment for a
	,
	"b": 2
	// this is a comment
}`;
		const targetContent = `
{
	"a": 1
	// this is comment for a
	,
	// this is a comment
}`;

		const expected = `
{
	"a": 1
	// this is comment for a
	,
	"b": 2
	// this is a comment
}`;

		const actual = addSetting('b', sourceContent, targetContent, formattingOptions);

		assert.strictEqual(actual, expected);
	});
});

// QuantLab carry SYNC-1: the retired demo pair never reaches Settings Sync content, whatever the user's ignoredSettings say.
suite('SettingsMerge - never-synced settings (SYNC-1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// What the workbench tombstone registration (`ignoreSync: true`) contributes to the default ignored settings.
	const tombstoneDefaults = ['qic.demo.email', 'qic.demo.password'];
	const optBackIn = ['-qic.demo.password', '-qic.demo.email'];
	const passwordSentinel = 'SENTINEL-not-a-real-value';
	const emailSentinel = 'SENTINEL-not-a-real-address';
	const base = stringify({ 'a': 1 });

	function localWithDemoPair(extra: Record<string, unknown>): string {
		const content = stringify({ 'a': 2, 'qic.demo.email': emailSentinel, 'qic.demo.password': passwordSentinel, ...extra });
		assert.ok(content.includes(passwordSentinel) && content.includes(emailSentinel), 'the local content must hold both sentinels');
		return content;
	}

	function assertNoDemoPair(remoteContent: string | null): void {
		assert.ok(remoteContent !== null, 'the path must produce remote content');
		assert.ok(!remoteContent.includes(passwordSentinel), 'qic.demo.password value reached the remote content');
		assert.ok(!remoteContent.includes(emailSentinel), 'qic.demo.email value reached the remote content');
		assert.ok(remoteContent.includes('"a": 2'), 'the other local change must still reach the remote content');
	}

	test('demo pair is absent from remote content with default ignored settings', () => {
		const local = localWithDemoPair({});
		const ignored = getIgnoredSettings(tombstoneDefaults, new TestConfigurationService());

		// first sync (settingsSync.ts applyResult): local content stripped of ignored settings against an empty remote
		assertNoDemoPair(updateIgnoredSettings(local, '{}', ignored, formattingOptions));
		// later sync: local moved forward from base, remote did not
		assertNoDemoPair(merge(local, base, base, ignored, [], formattingOptions).remoteContent);
	});

	test('demo pair is absent from remote content when the user opts both keys back in', () => {
		const local = localWithDemoPair({});
		const ignored = getIgnoredSettings(tombstoneDefaults, new TestConfigurationService({ 'settingsSync.ignoredSettings': optBackIn }));

		assertNoDemoPair(updateIgnoredSettings(local, '{}', ignored, formattingOptions));
		assertNoDemoPair(merge(local, base, base, ignored, [], formattingOptions).remoteContent);

		// applyResult reads the ignored settings from the content it is about to upload
		const localOptingBackIn = localWithDemoPair({ 'settingsSync.ignoredSettings': optBackIn });
		const ignoredFromContent = getIgnoredSettings(tombstoneDefaults, new TestConfigurationService(), localOptingBackIn);
		assertNoDemoPair(updateIgnoredSettings(localOptingBackIn, '{}', ignoredFromContent, formattingOptions));
	});
});


// QuantLab carry SYNC-1, c1 repair M2: a REMOTE (and base) that already holds the retired pair must not keep it. Ordinary ignored
// settings keep the other side's value; the never-synced pair is removed from every outbound content and a remote holding it
// receives a change that removes it.
suite('SettingsMerge - never-synced settings already held by the remote (SYNC-1 M2)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const passwordSentinel = 'SENTINEL-old-not-a-real-value';
	const emailSentinel = 'SENTINEL-old-not-a-real-address';
	const withPair = (content: Record<string, unknown>) => stringify({ ...content, 'qic.demo.email': emailSentinel, 'qic.demo.password': passwordSentinel });

	// What the workbench tombstone registration (`ignoreSync: true`) contributes to the default ignored settings.
	const tombstoneDefaults = ['qic.demo.email', 'qic.demo.password'];
	const ignoredVariants: { name: string; ignored: string[] }[] = [
		{ name: 'default ignored settings', ignored: getIgnoredSettings(tombstoneDefaults, new TestConfigurationService()) },
		{ name: 'explicit -qic.demo.* opt-back-in', ignored: getIgnoredSettings(tombstoneDefaults, new TestConfigurationService({ 'settingsSync.ignoredSettings': ['-qic.demo.password', '-qic.demo.email'] })) },
		{ name: 'explicit +qic.demo.password entry', ignored: getIgnoredSettings(tombstoneDefaults, new TestConfigurationService({ 'settingsSync.ignoredSettings': ['+qic.demo.password'] })) },
		{ name: 'explicit +qic.demo.password and -qic.demo.password entries', ignored: getIgnoredSettings(tombstoneDefaults, new TestConfigurationService({ 'settingsSync.ignoredSettings': ['+qic.demo.password', '-qic.demo.password', '-qic.demo.email'] })) },
	];

	function assertNoPair(content: string | null, message: string): asserts content is string {
		assert.ok(content !== null, `${message}: the path must produce content`);
		assert.ok(!content.includes(passwordSentinel), `${message}: qic.demo.password value is in the content`);
		assert.ok(!content.includes(emailSentinel), `${message}: qic.demo.email value is in the content`);
		const parsed = JSON.parse(content);
		assert.ok(!('qic.demo.password' in parsed), `${message}: qic.demo.password key is in the content`);
		assert.ok(!('qic.demo.email' in parsed), `${message}: qic.demo.email key is in the content`);
	}

	test('the ignored settings of every variant still list both keys', () => {
		for (const { name, ignored } of ignoredVariants) {
			assert.ok(ignored.includes('qic.demo.email') && ignored.includes('qic.demo.password'), name);
		}
	});

	for (const { name, ignored } of ignoredVariants) {

		test(`merge from base: remote == base holds the pair, local removed it and changed another setting [${name}]`, () => {
			const remote = withPair({ 'a': 1 });
			const local = stringify({ 'a': 2 });

			const actual = merge(local, remote, remote, ignored, [], formattingOptions);

			assertNoPair(actual.remoteContent, 'uploaded content');
			assert.strictEqual(JSON.parse(actual.remoteContent).a, 2);
			assert.strictEqual(actual.localContent, null);
			assert.strictEqual(actual.hasConflicts, false);
		});

		test(`merge from base: remote holds the pair and local changed too [${name}]`, () => {
			const base = withPair({ 'a': 1 });
			const remote = withPair({ 'a': 1, 'b': 3 });
			const local = stringify({ 'a': 2 });

			const actual = merge(local, remote, base, ignored, [], formattingOptions);

			assertNoPair(actual.remoteContent, 'uploaded content');
			assert.deepStrictEqual(JSON.parse(actual.remoteContent), { 'a': 2, 'b': 3 });
			assert.strictEqual(actual.hasConflicts, false);
		});

		test(`merge from base: only the remote moved and it holds the pair, so the remote gets a removal change [${name}]`, () => {
			const base = stringify({ 'a': 1 });
			const remote = withPair({ 'a': 1, 'b': 3 });
			const local = stringify({ 'a': 1 });

			const actual = merge(local, remote, base, ignored, [], formattingOptions);

			assertNoPair(actual.remoteContent, 'uploaded content');
			assert.deepStrictEqual(JSON.parse(actual.remoteContent), { 'a': 1, 'b': 3 });
			assertNoPair(actual.localContent, 'local content');
		});

		test(`merge from base: nothing but the pair differs, local already lacks it, so the remote gets a removal change [${name}]`, () => {
			const remote = withPair({ 'a': 1 });
			const local = stringify({ 'a': 1 });

			const actual = merge(local, remote, remote, ignored, [], formattingOptions);

			assertNoPair(actual.remoteContent, 'uploaded content');
			assert.deepStrictEqual(JSON.parse(actual.remoteContent), { 'a': 1 });
		});

		test(`first sync (no base): remote holds the pair and local adds a setting [${name}]`, () => {
			const remote = withPair({ 'a': 1 });
			const local = stringify({ 'a': 1, 'b': 2 });

			const actual = merge(local, remote, null, ignored, [], formattingOptions);

			assertNoPair(actual.remoteContent, 'uploaded content');
			assert.deepStrictEqual(JSON.parse(actual.remoteContent), { 'a': 1, 'b': 2 });
			assert.strictEqual(actual.hasConflicts, false);
		});

		test(`first sync (no base): empty local, remote holds the pair, so the remote gets a removal change [${name}]`, () => {
			const remote = withPair({ 'a': 1 });

			const actual = merge('{}', remote, null, ignored, [], formattingOptions);

			assertNoPair(actual.remoteContent, 'uploaded content');
			assert.deepStrictEqual(JSON.parse(actual.remoteContent), { 'a': 1 });
			assertNoPair(actual.localContent, 'local content');
		});

		test(`has-remote-changed check: last synced content holds the pair and local lacks it [${name}]`, () => {
			// settingsSync.hasRemoteChanged: merge(local, lastSync, lastSync, ...).remoteContent !== null
			const lastSync = withPair({ 'a': 1 });
			const local = stringify({ 'a': 1 });

			const actual = merge(local, lastSync, lastSync, ignored, [], formattingOptions);

			assertNoPair(actual.remoteContent, 'uploaded content');
		});

		test(`accepted preview: content about to be uploaded is rebuilt against a remote that holds the pair [${name}]`, () => {
			// settingsSync.applyResult: content = updateIgnoredSettingsForRemote(content, <remote settings>, ignored, ...) before updateRemoteUserData
			const remote = withPair({ 'a': 1 });
			const preview = stringify({ 'a': 2 });

			const actual = updateIgnoredSettingsForRemote(preview, remote, ignored, formattingOptions);

			assertNoPair(actual, 'applyResult upload');
			assert.deepStrictEqual(JSON.parse(actual), { 'a': 2 });
		});

		test(`accepted preview: edited content that carries the pair is scrubbed against the remote [${name}]`, () => {
			const remote = withPair({ 'a': 1 });
			const edited = withPair({ 'a': 2 });

			const actual = updateIgnoredSettingsForRemote(edited, remote, ignored, formattingOptions);

			assertNoPair(actual, 'accepted preview');
			assert.deepStrictEqual(JSON.parse(actual), { 'a': 2 });
		});

		test(`opt-back-in read from the uploaded content itself still drops the pair [${name}]`, () => {
			// applyResult: getIgnoredSettings(defaults, config, content) reads settingsSync.ignoredSettings from the content
			const remote = withPair({ 'a': 1 });
			const content = stringify({ 'a': 2, 'settingsSync.ignoredSettings': ['+qic.demo.password', '-qic.demo.password', '-qic.demo.email'] });
			const ignoredFromContent = getIgnoredSettings(tombstoneDefaults, new TestConfigurationService(), content);

			assertNoPair(updateIgnoredSettingsForRemote(content, remote, ignoredFromContent, formattingOptions), 'applyResult upload');
		});
	}

	test('an ordinary ignored setting keeps the remote value (established behaviour, unchanged)', () => {
		const ignored = getIgnoredSettings([...tombstoneDefaults, 'ordinary.ignored'], new TestConfigurationService());
		const remote = stringify({ 'a': 1, 'ordinary.ignored': 'remote-value' });
		const local = stringify({ 'a': 2, 'ordinary.ignored': 'local-value' });

		const merged = merge(local, remote, remote, ignored, [], formattingOptions);
		assert.ok(merged.remoteContent !== null);
		assert.deepStrictEqual(JSON.parse(merged.remoteContent), { 'a': 2, 'ordinary.ignored': 'remote-value' });

		assert.deepStrictEqual(JSON.parse(updateIgnoredSettings(local, remote, ignored, formattingOptions)), { 'a': 2, 'ordinary.ignored': 'remote-value' });
	});

	test('an ordinary ignored setting keeps the remote value while the pair is removed', () => {
		const ignored = getIgnoredSettings([...tombstoneDefaults, 'ordinary.ignored'], new TestConfigurationService());
		const remote = withPair({ 'a': 1, 'ordinary.ignored': 'remote-value' });
		const local = stringify({ 'a': 2, 'ordinary.ignored': 'local-value' });

		const merged = merge(local, remote, remote, ignored, [], formattingOptions);
		assertNoPair(merged.remoteContent, 'uploaded content');
		assert.deepStrictEqual(JSON.parse(merged.remoteContent), { 'a': 2, 'ordinary.ignored': 'remote-value' });

		const rebuilt = updateIgnoredSettingsForRemote(local, remote, ignored, formattingOptions);
		assertNoPair(rebuilt, 'applyResult upload');
		assert.deepStrictEqual(JSON.parse(rebuilt), { 'a': 2, 'ordinary.ignored': 'remote-value' });
	});
});


// QuantLab carry SYNC-1, c1 repair M2 (run 8, settingsResource row a6): content built for the LOCAL file keeps the local
// values of the never-synced pair and never takes the other side's (profile import, accept-remote, a merge that only the
// remote moved), whatever ignored-settings list the caller passes.
suite('SettingsMerge - never-synced settings in local-bound content (SYNC-1 M2)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const remotePair = { 'qic.demo.email': 'SENTINEL-remote-not-a-real-address', 'qic.demo.password': 'SENTINEL-remote-not-a-real-value' };
	const localPair = { 'qic.demo.email': 'SENTINEL-local-not-a-real-address', 'qic.demo.password': 'SENTINEL-local-not-a-real-value' };

	const tombstoneDefaults = ['qic.demo.email', 'qic.demo.password'];
	const ignoredVariants: { name: string; ignored: string[] }[] = [
		{ name: 'default ignored settings', ignored: getIgnoredSettings(tombstoneDefaults, new TestConfigurationService()) },
		{ name: 'explicit -qic.demo.* opt-back-in', ignored: getIgnoredSettings(tombstoneDefaults, new TestConfigurationService({ 'settingsSync.ignoredSettings': ['-qic.demo.password', '-qic.demo.email'] })) },
		{ name: 'an ignored list without the pair', ignored: [] },
	];

	for (const { name, ignored } of ignoredVariants) {

		test(`rebuilt for the local file: the local values of the pair are kept, the remote ones are not taken [${name}]`, () => {
			// settingsSync.getAcceptResult (accept remote) and settingsResource.apply (profile import):
			// updateIgnoredSettings(<incoming content>, <local file content>, ...)
			const incoming = stringify({ 'a': 1, ...remotePair });
			const local = stringify({ 'b': 2, ...localPair });

			const actual = updateIgnoredSettings(incoming, local, ignored, formattingOptions);

			assert.deepStrictEqual(JSON.parse(actual), { 'a': 1, ...localPair });
		});

		test(`rebuilt for the local file: a local file without the pair does not receive the remote one [${name}]`, () => {
			const incoming = stringify({ 'a': 1, ...remotePair });
			const local = stringify({ 'b': 2 });

			const actual = updateIgnoredSettings(incoming, local, ignored, formattingOptions);

			assert.deepStrictEqual(JSON.parse(actual), { 'a': 1 });
		});

		test(`merge where only the remote moved: local keeps its pair, the remote gets a removal change [${name}]`, () => {
			const base = stringify({ 'a': 1 });
			const remote = stringify({ 'a': 1, 'b': 3, ...remotePair });
			const local = stringify({ 'a': 1, ...localPair });

			const actual = merge(local, remote, base, ignored, [], formattingOptions);

			assert.ok(actual.localContent !== null);
			assert.deepStrictEqual(JSON.parse(actual.localContent), { 'a': 1, 'b': 3, ...localPair });
			assert.ok(actual.remoteContent !== null);
			assert.deepStrictEqual(JSON.parse(actual.remoteContent), { 'a': 1, 'b': 3 });
		});

		test(`merge where both moved: local keeps its pair, the upload holds none [${name}]`, () => {
			const base = stringify({ 'a': 1, ...remotePair });
			const remote = stringify({ 'a': 1, 'b': 3, ...remotePair });
			const local = stringify({ 'a': 2, ...localPair });

			const actual = merge(local, remote, base, ignored, [], formattingOptions);

			assert.ok(actual.localContent !== null);
			assert.deepStrictEqual(JSON.parse(actual.localContent), { 'a': 2, 'b': 3, ...localPair });
			assert.ok(actual.remoteContent !== null);
			assert.deepStrictEqual(JSON.parse(actual.remoteContent), { 'a': 2, 'b': 3 });
		});
	}
});

function stringify(value: any): string {
	return JSON.stringify(value, null, '\t');
}
