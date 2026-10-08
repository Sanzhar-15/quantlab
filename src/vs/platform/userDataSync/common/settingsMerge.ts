/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { distinct } from '../../../base/common/arrays.js';
import { IStringDictionary } from '../../../base/common/collections.js';
import { JSONVisitor, ParseError, parse, visit } from '../../../base/common/json.js';
import { applyEdits, setProperty, withFormatting } from '../../../base/common/jsonEdit.js';
import { Edit, FormattingOptions, getEOL } from '../../../base/common/jsonFormatter.js';
import * as objects from '../../../base/common/objects.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import * as contentUtil from './content.js';
import { getDisallowedIgnoredSettings, IConflictSetting } from './userDataSync.js';

export interface IMergeResult {
	localContent: string | null;
	remoteContent: string | null;
	hasConflicts: boolean;
	conflictsSettings: IConflictSetting[];
}

/**
 * QuantLab carry SYNC-1 (release-blocking, ruling Q-LOGIN-5 (a)): settings that must NEVER reach Settings Sync
 * content. `qic.demo.email` and `qic.demo.password` were registered by a contribution that no longer exists, so a
 * value left in a user's settings.json must not be synced. They are appended AFTER the user's `-key` opt-back-in
 * entries in {@link getIgnoredSettings}, so no `settingsSync.ignoredSettings` entry can bring them back.
 *
 * Outbound (what this guarantee covers): content built to leave this machine holds neither key, whatever the remote, the base
 * or the ignored-settings list say, and a remote that still holds them receives a change that removes them. That content is
 * {@link updateIgnoredSettingsForRemote}, and every `remoteContent` of {@link merge}, which is either null (nothing is sent) or
 * went through {@link removeNeverSyncedSettings} (called directly in the branches that start from the remote's own content, and
 * inside updateIgnoredSettingsForRemote in the others). Local-bound: content built for the local file ({@link updateIgnoredSettings}
 * with the local content as source, every `localContent` of {@link merge}) keeps the local values and never takes the other
 * side's. Not covered: the inbound initialisers (the first-run `SettingsInitializer` writes remote settings into a profile
 * without this module); they are reserved to a later fold.
 * Outbound content is checked, not trusted: every occurrence of a key is removed however often the raw text writes it
 * (the parser keeps the last duplicate, so one removal per key is not enough), the result is scanned again, and a result
 * that still holds a key, or built from a local content that does not parse, is refused with a {@link NeverSyncedSettingsError}.
 * Byte identity with upstream holds only where it is stated: {@link removeNeverSyncedSettings} returns content that holds no
 * key exactly as it came in, and {@link updateIgnoredSettingsForRemote} returns what the ordinary ignored-settings step
 * ({@link updateIgnoredSettings}) builds whenever the source holds no key. Where the source holds a key it is copied in and
 * removed again, and the result can differ from the base's, as stated at {@link updateIgnoredSettingsForRemote}.
 * Remove this list after the first user-facing release that includes QuantLab.
 */
export const NEVER_SYNCED_SETTINGS: readonly string[] = Object.freeze(['qic.demo.email', 'qic.demo.password']);

export function getIgnoredSettings(defaultIgnoredSettings: string[], configurationService: IConfigurationService, settingsContent?: string): string[] {
	let value: ReadonlyArray<string> = [];
	if (settingsContent) {
		value = getIgnoredSettingsFromContent(settingsContent);
	} else {
		value = getIgnoredSettingsFromConfig(configurationService);
	}
	const added: string[] = [], removed: string[] = [...getDisallowedIgnoredSettings()];
	if (Array.isArray(value)) {
		for (const key of value) {
			if (key.startsWith('-')) {
				removed.push(key.substring(1));
			} else {
				added.push(key);
			}
		}
	}
	return distinct([...defaultIgnoredSettings, ...added,].filter(setting => !removed.includes(setting)).concat(NEVER_SYNCED_SETTINGS));
}

function getIgnoredSettingsFromConfig(configurationService: IConfigurationService): ReadonlyArray<string> {
	let userValue = configurationService.inspect<string[]>('settingsSync.ignoredSettings').userValue;
	if (userValue !== undefined) {
		return userValue;
	}
	userValue = configurationService.inspect<string[]>('sync.ignoredSettings').userValue;
	if (userValue !== undefined) {
		return userValue;
	}
	return configurationService.getValue<string[]>('settingsSync.ignoredSettings') || [];
}

function getIgnoredSettingsFromContent(settingsContent: string): string[] {
	const parsed = parse(settingsContent);
	return parsed ? parsed['settingsSync.ignoredSettings'] || parsed['sync.ignoredSettings'] || [] : [];
}

export function removeComments(content: string, formattingOptions: FormattingOptions): string {
	const source = parse(content) || {};
	let result = '{}';
	for (const key of Object.keys(source)) {
		const edits = setProperty(result, [key], source[key], formattingOptions);
		result = applyEdits(result, edits);
	}
	return result;
}

function holdsNeverSyncedSettings(content: string): boolean {
	const parsed = parse(content);
	return !!parsed && NEVER_SYNCED_SETTINGS.some(key => parsed[key] !== undefined);
}

function neverSyncedSettingsHeld(targetContent: string, sourceContent: string): string[] {
	const target = parse(targetContent);
	const source = parse(sourceContent);
	return NEVER_SYNCED_SETTINGS.filter(key => (!!target && target[key] !== undefined) || (!!source && source[key] !== undefined));
}

/**
 * Thrown when content that would leave this machine cannot be shown to be free of {@link NEVER_SYNCED_SETTINGS}: the
 * content handed to {@link updateIgnoredSettingsForRemote} does not parse, a key is still there after every occurrence was
 * removed, or the removal itself left the content with more syntax errors than it had. The message names keys and offsets
 * only, never a value or any part of the content.
 */
export class NeverSyncedSettingsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NeverSyncedSettingsError';
	}
}

/** The same parse options as the sync validator (`AbstractJsonSynchronizer.hasErrors`): comments, trailing commas and empty content are valid. */
const NEVER_SYNCED_PARSE_OPTIONS = { allowTrailingComma: true, allowEmptyContent: true };

function parseErrorsOf(content: string): ParseError[] {
	const errors: ParseError[] = [];
	visit(content, { onError: (error, offset, length) => { errors.push({ error, offset, length }); } }, NEVER_SYNCED_PARSE_OPTIONS);
	return errors;
}

/** Throws a {@link NeverSyncedSettingsError} when the content has a syntax error (comments, trailing commas and empty content are valid). */
function assertParses(content: string): void {
	const errors = parseErrorsOf(content);
	if (errors.length) {
		throw new NeverSyncedSettingsError(`Settings content cannot be checked for never-synced settings: it has ${errors.length} syntax error(s), the first (code ${errors[0].error}) at offset ${errors[0].offset}`);
	}
}

/**
 * Counts the full-document passes (a tokenizer or parser traversal of the whole content) that {@link removeNeverSyncedSettings}
 * makes. The function takes it as an argument, so that a test reads the count off the real function, whatever the content.
 */
export interface INeverSyncedPasses {
	fullDocumentPasses: number;
}

/** A property of the root object: where its key starts, where its value ends, and the offset of the comma that follows it (if any). */
interface IRootProperty {
	readonly name: string;
	readonly start: number;
	end: number;
	comma: number | undefined;
}

interface IRootScan {
	/** Every property of the root object, in text order, duplicates included. */
	readonly properties: IRootProperty[];
	/** The offset of the root object's opening brace, when the root value is an object. */
	readonly rootOffset: number | undefined;
	readonly errorCount: number;
}

/**
 * ONE tokenizer traversal of the whole content: the properties of the root object with their ranges, and the number of syntax
 * errors. The tokenizer recovers from syntax errors, so this also reads content the ordinary ignored-settings removal left
 * with errors (all settings removed from `{ "a": 1, }` leaves `{ , }`, which upstream uploads as it is).
 */
function scanRoot(content: string, passes: INeverSyncedPasses): IRootScan {
	passes.fullDocumentPasses++;
	const properties: IRootProperty[] = [];
	let rootOffset: number | undefined;
	let depth = 0;
	let errorCount = 0;
	let current: IRootProperty | undefined;
	const inRoot = () => rootOffset !== undefined && depth === 1;
	visit(content, {
		onObjectBegin: (offset: number) => {
			if (depth === 0) {
				rootOffset = offset;
			}
			depth++;
		},
		onObjectEnd: (offset: number, length: number) => {
			depth--;
			if (inRoot() && current) {
				current.end = offset + length;
			}
		},
		onArrayBegin: () => { depth++; },
		onArrayEnd: (offset: number, length: number) => {
			depth--;
			if (inRoot() && current) {
				current.end = offset + length;
			}
		},
		onObjectProperty: (name: string, offset: number, length: number) => {
			if (inRoot()) {
				current = { name, start: offset, end: offset + length, comma: undefined };
				properties.push(current);
			}
		},
		onLiteralValue: (_value: unknown, offset: number, length: number) => {
			if (inRoot() && current) {
				current.end = offset + length;
			}
		},
		onSeparator: (character: string, offset: number) => {
			if (character === ',' && inRoot() && current && current.comma === undefined) {
				current.comma = offset;
			}
		},
		onError: () => { errorCount++; }
	}, NEVER_SYNCED_PARSE_OPTIONS);
	return { properties, rootOffset, errorCount };
}

/**
 * The removal of every never-synced property of a scan, as ONE batch of edits that do not overlap. A run of adjacent
 * never-synced properties is one edit, comma-aware the way `setProperty(…, undefined)` is: after a kept property it takes
 * the text from that property's end to the run's last end, so the comma that followed the run stays as the separator (or as
 * the trailing comma the content already had); a run that opens the object takes the text from the opening brace to the next
 * kept property, or, when no property is kept, to the last property's comma (`{ "k": 1, }` becomes `{}`, where
 * `setProperty` would leave `{ , }`, which does not parse). The edit that opens the object is returned apart, for it
 * is formatted after the batch is applied (as `setProperty` formats it); it lies before every edit of the batch.
 */
function planRemovals(scan: IRootScan): { batch: Edit[]; leading: Edit | undefined } {
	const { properties, rootOffset } = scan;
	const batch: Edit[] = [];
	let leading: Edit | undefined;
	const held = (index: number) => NEVER_SYNCED_SETTINGS.includes(properties[index].name);
	for (let first = 0; first < properties.length; first++) {
		if (!held(first)) {
			continue;
		}
		let last = first;
		while (last + 1 < properties.length && held(last + 1)) {
			last++;
		}
		if (first > 0) {
			const begin = properties[first - 1].end;
			batch.push({ offset: begin, length: properties[last].end - begin, content: '' });
		} else {
			if (rootOffset === undefined) {
				throw new NeverSyncedSettingsError('A never-synced setting was found in settings content that has no root object');
			}
			const begin = rootOffset + 1;
			const next = properties[last + 1];
			const lastComma = properties[last].comma;
			const end = next ? next.start : (lastComma !== undefined ? lastComma + 1 : properties[last].end);
			leading = { offset: begin, length: end - begin, content: '' };
		}
		first = last;
	}
	return { batch, leading };
}

/** Applies edits that are sorted by offset and do not overlap, in one linear pass; an overlap is an error, never an adjustment. */
function applySortedEdits(content: string, edits: Edit[]): string {
	const parts: string[] = [];
	let cursor = 0;
	for (const edit of edits) {
		if (edit.offset < cursor) {
			throw new NeverSyncedSettingsError('The removals of the never-synced settings overlap');
		}
		parts.push(content.substring(cursor, edit.offset), edit.content);
		cursor = edit.offset + edit.length;
	}
	parts.push(content.substring(cursor));
	return parts.join('');
}

/**
 * Removes EVERY top-level occurrence of each {@link NEVER_SYNCED_SETTINGS} key, however often the raw text writes it, in a
 * bounded number of full-document passes whatever the duplicate count: one traversal collects the ranges of all of them, one
 * batch of edits removes them, one traversal checks the result, and the parsed object is read once more (at most three
 * passes, counted in `passes`). Content that holds no key comes back as it came in. A throw ({@link NeverSyncedSettingsError})
 * means a key is still there, or the removal left the content with more syntax errors than it had: content that leaves
 * this machine is never passed on unchecked. The last check, on the parsed object, is a second property-presence check, not an
 * independent parser (`parse` runs on the same tokenizer).
 */
export function removeNeverSyncedSettings(content: string, formattingOptions: FormattingOptions, passes: INeverSyncedPasses = { fullDocumentPasses: 0 }): string {
	const before = scanRoot(content, passes);
	if (before.properties.some(property => NEVER_SYNCED_SETTINGS.includes(property.name))) {
		const { batch, leading } = planRemovals(before);
		content = applySortedEdits(content, batch);
		if (leading) {
			const formatted = withFormatting(content, leading, formattingOptions)[0];
			content = content.substring(0, formatted.offset) + formatted.content + content.substring(formatted.offset + formatted.length);
		}
		const after = scanRoot(content, passes);
		const remaining = after.properties.filter(property => NEVER_SYNCED_SETTINGS.includes(property.name)).map(property => property.name);
		if (remaining.length) {
			throw new NeverSyncedSettingsError(`A never-synced setting could not be removed from the settings content: ${distinct(remaining).join(', ')}`);
		}
		if (after.errorCount > before.errorCount) {
			throw new NeverSyncedSettingsError('Removing the never-synced settings left the settings content with syntax errors it did not have');
		}
	}

	passes.fullDocumentPasses++;
	const parsed = parse(content, [], NEVER_SYNCED_PARSE_OPTIONS);
	if (parsed !== null && typeof parsed === 'object') {
		const left = NEVER_SYNCED_SETTINGS.filter(key => Object.prototype.hasOwnProperty.call(parsed, key));
		if (left.length) {
			throw new NeverSyncedSettingsError(`Settings content still holds never-synced settings after their removal: ${left.join(', ')}`);
		}
	}
	return content;
}

/**
 * Ignored settings take the value they have in `sourceContent` (or are removed when the source lacks them). Each
 * {@link NEVER_SYNCED_SETTINGS} key is among them exactly when either side holds it, whatever list the caller passed, so
 * content where neither side holds the pair is rebuilt as the ordinary ignored settings alone rebuild it. Built for the
 * local file with the local content as source, the result keeps the local values; built with `'{}'` as source, it holds
 * none of a key written once. Like every ignored setting here, a key the raw text writes several times loses one occurrence
 * per call: content that leaves this machine is therefore never built with this function alone but with
 * {@link updateIgnoredSettingsForRemote}, which removes every occurrence.
 */
export function updateIgnoredSettings(targetContent: string, sourceContent: string, ignoredSettings: string[], formattingOptions: FormattingOptions): string {
	ignoredSettings = distinct([...ignoredSettings.filter(key => !NEVER_SYNCED_SETTINGS.includes(key)), ...neverSyncedSettingsHeld(targetContent, sourceContent)]);
	if (ignoredSettings.length) {
		const sourceTree = parseSettings(sourceContent);
		const source = parse(sourceContent) || {};
		const target = parse(targetContent);
		if (!target) {
			return targetContent;
		}
		const settingsToAdd: INode[] = [];
		for (const key of ignoredSettings) {
			const sourceValue = source[key];
			const targetValue = target[key];

			// Remove in target
			if (sourceValue === undefined) {
				targetContent = contentUtil.edit(targetContent, [key], undefined, formattingOptions);
			}

			// Update in target
			else if (targetValue !== undefined) {
				targetContent = contentUtil.edit(targetContent, [key], sourceValue, formattingOptions);
			}

			else {
				settingsToAdd.push(findSettingNode(key, sourceTree)!);
			}
		}

		settingsToAdd.sort((a, b) => a.startOffset - b.startOffset);
		settingsToAdd.forEach(s => targetContent = addSetting(s.setting!.key, sourceContent, targetContent, formattingOptions));
	}
	return targetContent;
}

/**
 * Outbound content (it leaves this machine): {@link updateIgnoredSettings}, then every occurrence of the
 * {@link NEVER_SYNCED_SETTINGS} keys is removed whatever `sourceContent` holds, so a remote that holds them never has them
 * copied back into an upload. That guarantee does not rest on {@link updateIgnoredSettings}, which removes one occurrence
 * per ignored key. Throws a {@link NeverSyncedSettingsError} when `targetContent` does not parse or the result still holds a key.
 *
 * Against the base (7931203e520, whose strip removed one occurrence of each key), for a target that holds no key: the output is
 * byte for byte the base's when the source holds no key either (updateIgnoredSettings alone builds it). When the source holds
 * a key, updateIgnoredSettings copies it into the target and the removal takes it out again; the tests compare the base's exact
 * output for the layouts they pin. The one difference known and asserted: upstream's removal of an ignored setting can leave a
 * bare comma (`{ , }`), and when every property left is a never-synced one, the removal of the last of them takes that comma
 * too. Target `{"machine.a":1,}` with `machine.a` ignored and a source that holds both keys gives `{\n\t,\n}` on the base
 * (which does not parse) and `{\n}` here.
 */
export function updateIgnoredSettingsForRemote(targetContent: string, sourceContent: string, ignoredSettings: string[], formattingOptions: FormattingOptions): string {
	// The content this builds from is the caller's own: it must parse (the sync validates it first). What the ordinary
	// ignored-settings removal then leaves behind is not judged here, only that no never-synced key is left.
	assertParses(targetContent);
	// The keys go first, whole: updateIgnoredSettings would remove one occurrence of each and, from an object whose only
	// setting is a key followed by a comma, leave `{ , }`. Content that holds no key comes back from this as it is.
	targetContent = removeNeverSyncedSettings(targetContent, formattingOptions);
	return removeNeverSyncedSettings(updateIgnoredSettings(targetContent, sourceContent, ignoredSettings, formattingOptions), formattingOptions);
}

export function merge(originalLocalContent: string, originalRemoteContent: string, baseContent: string | null, ignoredSettings: string[], resolvedConflicts: { key: string; value: any | undefined }[], formattingOptions: FormattingOptions): IMergeResult {

	// NEVER_SYNCED_SETTINGS are ignored by every merge, whatever list the caller passed.
	ignoredSettings = distinct([...ignoredSettings, ...NEVER_SYNCED_SETTINGS]);
	// A remote that holds them must receive a change that removes them, even when nothing else differs.
	const remoteHoldsNeverSynced = holdsNeverSyncedSettings(originalRemoteContent);

	// Outbound: it is compared with the base (the last uploaded content) and uploaded as is when only local moved.
	const localContentWithoutIgnoredSettings = updateIgnoredSettingsForRemote(originalLocalContent, originalRemoteContent, ignoredSettings, formattingOptions);
	const localForwarded = baseContent !== localContentWithoutIgnoredSettings;
	const remoteForwarded = baseContent !== originalRemoteContent;

	/* no changes */
	if (!localForwarded && !remoteForwarded) {
		return { conflictsSettings: [], localContent: null, remoteContent: null, hasConflicts: false };
	}

	/* local has changed and remote has not */
	if (localForwarded && !remoteForwarded) {
		return { conflictsSettings: [], localContent: null, remoteContent: localContentWithoutIgnoredSettings, hasConflicts: false };
	}

	/* remote has changed and local has not */
	if (remoteForwarded && !localForwarded) {
		return {
			conflictsSettings: [],
			localContent: updateIgnoredSettings(originalRemoteContent, originalLocalContent, ignoredSettings, formattingOptions),
			remoteContent: remoteHoldsNeverSynced ? removeNeverSyncedSettings(originalRemoteContent, formattingOptions) : null,
			hasConflicts: false
		};
	}

	/* local is empty and not synced before */
	if (baseContent === null && isEmpty(originalLocalContent)) {
		const localContent = areSame(originalLocalContent, originalRemoteContent, ignoredSettings) ? null : updateIgnoredSettings(originalRemoteContent, originalLocalContent, ignoredSettings, formattingOptions);
		return { conflictsSettings: [], localContent, remoteContent: remoteHoldsNeverSynced ? removeNeverSyncedSettings(originalRemoteContent, formattingOptions) : null, hasConflicts: false };
	}

	/* remote and local has changed */
	let localContent = originalLocalContent;
	let remoteContent = originalRemoteContent;
	const local = parse(originalLocalContent);
	const remote = parse(originalRemoteContent);
	const base = baseContent ? parse(baseContent) : null;

	const ignored = ignoredSettings.reduce((set, key) => { set.add(key); return set; }, new Set<string>());
	const localToRemote = compare(local, remote, ignored);
	const baseToLocal = compare(base, local, ignored);
	const baseToRemote = compare(base, remote, ignored);

	const conflicts: Map<string, IConflictSetting> = new Map<string, IConflictSetting>();
	const handledConflicts: Set<string> = new Set<string>();
	const handleConflict = (conflictKey: string): void => {
		handledConflicts.add(conflictKey);
		const resolvedConflict = resolvedConflicts.filter(({ key }) => key === conflictKey)[0];
		if (resolvedConflict) {
			localContent = contentUtil.edit(localContent, [conflictKey], resolvedConflict.value, formattingOptions);
			remoteContent = contentUtil.edit(remoteContent, [conflictKey], resolvedConflict.value, formattingOptions);
		} else {
			conflicts.set(conflictKey, { key: conflictKey, localValue: local[conflictKey], remoteValue: remote[conflictKey] });
		}
	};

	// Removed settings in Local
	for (const key of baseToLocal.removed.values()) {
		// Conflict - Got updated in remote.
		if (baseToRemote.updated.has(key)) {
			handleConflict(key);
		}
		// Also remove in remote
		else {
			remoteContent = contentUtil.edit(remoteContent, [key], undefined, formattingOptions);
		}
	}

	// Removed settings in Remote
	for (const key of baseToRemote.removed.values()) {
		if (handledConflicts.has(key)) {
			continue;
		}
		// Conflict - Got updated in local
		if (baseToLocal.updated.has(key)) {
			handleConflict(key);
		}
		// Also remove in locals
		else {
			localContent = contentUtil.edit(localContent, [key], undefined, formattingOptions);
		}
	}

	// Updated settings in Local
	for (const key of baseToLocal.updated.values()) {
		if (handledConflicts.has(key)) {
			continue;
		}
		// Got updated in remote
		if (baseToRemote.updated.has(key)) {
			// Has different value
			if (localToRemote.updated.has(key)) {
				handleConflict(key);
			}
		} else {
			remoteContent = contentUtil.edit(remoteContent, [key], local[key], formattingOptions);
		}
	}

	// Updated settings in Remote
	for (const key of baseToRemote.updated.values()) {
		if (handledConflicts.has(key)) {
			continue;
		}
		// Got updated in local
		if (baseToLocal.updated.has(key)) {
			// Has different value
			if (localToRemote.updated.has(key)) {
				handleConflict(key);
			}
		} else {
			localContent = contentUtil.edit(localContent, [key], remote[key], formattingOptions);
		}
	}

	// Added settings in Local
	for (const key of baseToLocal.added.values()) {
		if (handledConflicts.has(key)) {
			continue;
		}
		// Got added in remote
		if (baseToRemote.added.has(key)) {
			// Has different value
			if (localToRemote.updated.has(key)) {
				handleConflict(key);
			}
		} else {
			remoteContent = addSetting(key, localContent, remoteContent, formattingOptions);
		}
	}

	// Added settings in remote
	for (const key of baseToRemote.added.values()) {
		if (handledConflicts.has(key)) {
			continue;
		}
		// Got added in local
		if (baseToLocal.added.has(key)) {
			// Has different value
			if (localToRemote.updated.has(key)) {
				handleConflict(key);
			}
		} else {
			localContent = addSetting(key, remoteContent, localContent, formattingOptions);
		}
	}

	remoteContent = removeNeverSyncedSettings(remoteContent, formattingOptions);

	const hasConflicts = conflicts.size > 0 || !areSame(localContent, remoteContent, ignoredSettings);
	const hasLocalChanged = hasConflicts || !areSame(localContent, originalLocalContent, []);
	const hasRemoteChanged = hasConflicts || !areSame(remoteContent, originalRemoteContent, []);
	return { localContent: hasLocalChanged ? localContent : null, remoteContent: hasRemoteChanged ? remoteContent : null, conflictsSettings: [...conflicts.values()], hasConflicts };
}

function areSame(localContent: string, remoteContent: string, ignoredSettings: string[]): boolean {
	if (localContent === remoteContent) {
		return true;
	}

	const local = parse(localContent);
	const remote = parse(remoteContent);
	const ignored = ignoredSettings.reduce((set, key) => { set.add(key); return set; }, new Set<string>());
	const localTree = parseSettings(localContent).filter(node => !(node.setting && ignored.has(node.setting.key)));
	const remoteTree = parseSettings(remoteContent).filter(node => !(node.setting && ignored.has(node.setting.key)));

	if (localTree.length !== remoteTree.length) {
		return false;
	}

	for (let index = 0; index < localTree.length; index++) {
		const localNode = localTree[index];
		const remoteNode = remoteTree[index];
		if (localNode.setting && remoteNode.setting) {
			if (localNode.setting.key !== remoteNode.setting.key) {
				return false;
			}
			if (!objects.equals(local[localNode.setting.key], remote[localNode.setting.key])) {
				return false;
			}
		} else if (!localNode.setting && !remoteNode.setting) {
			if (localNode.value !== remoteNode.value) {
				return false;
			}
		} else {
			return false;
		}
	}

	return true;
}

export function isEmpty(content: string): boolean {
	if (content) {
		const nodes = parseSettings(content);
		return nodes.length === 0;
	}
	return true;
}

function compare(from: IStringDictionary<any> | null, to: IStringDictionary<any>, ignored: Set<string>): { added: Set<string>; removed: Set<string>; updated: Set<string> } {
	const fromKeys = from ? Object.keys(from).filter(key => !ignored.has(key)) : [];
	const toKeys = Object.keys(to).filter(key => !ignored.has(key));
	const added = toKeys.filter(key => !fromKeys.includes(key)).reduce((r, key) => { r.add(key); return r; }, new Set<string>());
	const removed = fromKeys.filter(key => !toKeys.includes(key)).reduce((r, key) => { r.add(key); return r; }, new Set<string>());
	const updated: Set<string> = new Set<string>();

	if (from) {
		for (const key of fromKeys) {
			if (removed.has(key)) {
				continue;
			}
			const value1 = from[key];
			const value2 = to[key];
			if (!objects.equals(value1, value2)) {
				updated.add(key);
			}
		}
	}

	return { added, removed, updated };
}

export function addSetting(key: string, sourceContent: string, targetContent: string, formattingOptions: FormattingOptions): string {
	const source = parse(sourceContent);
	const sourceTree = parseSettings(sourceContent);
	const targetTree = parseSettings(targetContent);
	const insertLocation = getInsertLocation(key, sourceTree, targetTree);
	return insertAtLocation(targetContent, key, source[key], insertLocation, targetTree, formattingOptions);
}

interface InsertLocation {
	index: number;
	insertAfter: boolean;
}

function getInsertLocation(key: string, sourceTree: INode[], targetTree: INode[]): InsertLocation {

	const sourceNodeIndex = sourceTree.findIndex(node => node.setting?.key === key);

	const sourcePreviousNode: INode = sourceTree[sourceNodeIndex - 1];
	if (sourcePreviousNode) {
		/*
			Previous node in source is a setting.
			Find the same setting in the target.
			Insert it after that setting
		*/
		if (sourcePreviousNode.setting) {
			const targetPreviousSetting = findSettingNode(sourcePreviousNode.setting.key, targetTree);
			if (targetPreviousSetting) {
				/* Insert after target's previous setting */
				return { index: targetTree.indexOf(targetPreviousSetting), insertAfter: true };
			}
		}
		/* Previous node in source is a comment */
		else {
			const sourcePreviousSettingNode = findPreviousSettingNode(sourceNodeIndex, sourceTree);
			/*
				Source has a setting defined before the setting to be added.
				Find the same previous setting in the target.
				If found, insert before its next setting so that comments are retrieved.
				Otherwise, insert at the end.
			*/
			if (sourcePreviousSettingNode) {
				const targetPreviousSetting = findSettingNode(sourcePreviousSettingNode.setting!.key, targetTree);
				if (targetPreviousSetting) {
					const targetNextSetting = findNextSettingNode(targetTree.indexOf(targetPreviousSetting), targetTree);
					const sourceCommentNodes = findNodesBetween(sourceTree, sourcePreviousSettingNode, sourceTree[sourceNodeIndex]);
					if (targetNextSetting) {
						const targetCommentNodes = findNodesBetween(targetTree, targetPreviousSetting, targetNextSetting);
						const targetCommentNode = findLastMatchingTargetCommentNode(sourceCommentNodes, targetCommentNodes);
						if (targetCommentNode) {
							return { index: targetTree.indexOf(targetCommentNode), insertAfter: true }; /* Insert after comment */
						} else {
							return { index: targetTree.indexOf(targetNextSetting), insertAfter: false }; /* Insert before target next setting */
						}
					} else {
						const targetCommentNodes = findNodesBetween(targetTree, targetPreviousSetting, targetTree[targetTree.length - 1]);
						const targetCommentNode = findLastMatchingTargetCommentNode(sourceCommentNodes, targetCommentNodes);
						if (targetCommentNode) {
							return { index: targetTree.indexOf(targetCommentNode), insertAfter: true }; /* Insert after comment */
						} else {
							return { index: targetTree.length - 1, insertAfter: true }; /* Insert at the end */
						}
					}
				}
			}
		}

		const sourceNextNode = sourceTree[sourceNodeIndex + 1];
		if (sourceNextNode) {
			/*
				Next node in source is a setting.
				Find the same setting in the target.
				Insert it before that setting
			*/
			if (sourceNextNode.setting) {
				const targetNextSetting = findSettingNode(sourceNextNode.setting.key, targetTree);
				if (targetNextSetting) {
					/* Insert before target's next setting */
					return { index: targetTree.indexOf(targetNextSetting), insertAfter: false };
				}
			}
			/* Next node in source is a comment */
			else {
				const sourceNextSettingNode = findNextSettingNode(sourceNodeIndex, sourceTree);
				/*
					Source has a setting defined after the setting to be added.
					Find the same next setting in the target.
					If found, insert after its previous setting so that comments are retrieved.
					Otherwise, insert at the beginning.
				*/
				if (sourceNextSettingNode) {
					const targetNextSetting = findSettingNode(sourceNextSettingNode.setting!.key, targetTree);
					if (targetNextSetting) {
						const targetPreviousSetting = findPreviousSettingNode(targetTree.indexOf(targetNextSetting), targetTree);
						const sourceCommentNodes = findNodesBetween(sourceTree, sourceTree[sourceNodeIndex], sourceNextSettingNode);
						if (targetPreviousSetting) {
							const targetCommentNodes = findNodesBetween(targetTree, targetPreviousSetting, targetNextSetting);
							const targetCommentNode = findLastMatchingTargetCommentNode(sourceCommentNodes.reverse(), targetCommentNodes.reverse());
							if (targetCommentNode) {
								return { index: targetTree.indexOf(targetCommentNode), insertAfter: false }; /* Insert before comment */
							} else {
								return { index: targetTree.indexOf(targetPreviousSetting), insertAfter: true }; /* Insert after target previous setting */
							}
						} else {
							const targetCommentNodes = findNodesBetween(targetTree, targetTree[0], targetNextSetting);
							const targetCommentNode = findLastMatchingTargetCommentNode(sourceCommentNodes.reverse(), targetCommentNodes.reverse());
							if (targetCommentNode) {
								return { index: targetTree.indexOf(targetCommentNode), insertAfter: false }; /* Insert before comment */
							} else {
								return { index: 0, insertAfter: false }; /* Insert at the beginning */
							}
						}
					}
				}
			}
		}
	}
	/* Insert at the end */
	return { index: targetTree.length - 1, insertAfter: true };
}

function insertAtLocation(content: string, key: string, value: any, location: InsertLocation, tree: INode[], formattingOptions: FormattingOptions): string {
	let edits: Edit[];
	/* Insert at the end */
	if (location.index === -1) {
		edits = setProperty(content, [key], value, formattingOptions);
	} else {
		edits = getEditToInsertAtLocation(content, key, value, location, tree, formattingOptions).map(edit => withFormatting(content, edit, formattingOptions)[0]);
	}
	return applyEdits(content, edits);
}

function getEditToInsertAtLocation(content: string, key: string, value: any, location: InsertLocation, tree: INode[], formattingOptions: FormattingOptions): Edit[] {
	const newProperty = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
	const eol = getEOL(formattingOptions, content);
	const node = tree[location.index];

	if (location.insertAfter) {

		const edits: Edit[] = [];

		/* Insert after a setting */
		if (node.setting) {
			edits.push({ offset: node.endOffset, length: 0, content: ',' + newProperty });
		}

		/* Insert after a comment */
		else {

			const nextSettingNode = findNextSettingNode(location.index, tree);
			const previousSettingNode = findPreviousSettingNode(location.index, tree);
			const previousSettingCommaOffset = previousSettingNode?.setting?.commaOffset;

			/* If there is a previous setting and it does not has comma then add it */
			if (previousSettingNode && previousSettingCommaOffset === undefined) {
				edits.push({ offset: previousSettingNode.endOffset, length: 0, content: ',' });
			}

			const isPreviouisSettingIncludesComment = previousSettingCommaOffset !== undefined && previousSettingCommaOffset > node.endOffset;
			edits.push({
				offset: isPreviouisSettingIncludesComment ? previousSettingCommaOffset + 1 : node.endOffset,
				length: 0,
				content: nextSettingNode ? eol + newProperty + ',' : eol + newProperty
			});
		}


		return edits;
	}

	else {

		/* Insert before a setting */
		if (node.setting) {
			return [{ offset: node.startOffset, length: 0, content: newProperty + ',' }];
		}

		/* Insert before a comment */
		const content = (tree[location.index - 1] && !tree[location.index - 1].setting /* previous node is comment */ ? eol : '')
			+ newProperty
			+ (findNextSettingNode(location.index, tree) ? ',' : '')
			+ eol;
		return [{ offset: node.startOffset, length: 0, content }];
	}

}

function findSettingNode(key: string, tree: INode[]): INode | undefined {
	return tree.filter(node => node.setting?.key === key)[0];
}

function findPreviousSettingNode(index: number, tree: INode[]): INode | undefined {
	for (let i = index - 1; i >= 0; i--) {
		if (tree[i].setting) {
			return tree[i];
		}
	}
	return undefined;
}

function findNextSettingNode(index: number, tree: INode[]): INode | undefined {
	for (let i = index + 1; i < tree.length; i++) {
		if (tree[i].setting) {
			return tree[i];
		}
	}
	return undefined;
}

function findNodesBetween(nodes: INode[], from: INode, till: INode): INode[] {
	const fromIndex = nodes.indexOf(from);
	const tillIndex = nodes.indexOf(till);
	return nodes.filter((node, index) => fromIndex < index && index < tillIndex);
}

function findLastMatchingTargetCommentNode(sourceComments: INode[], targetComments: INode[]): INode | undefined {
	if (sourceComments.length && targetComments.length) {
		let index = 0;
		for (; index < targetComments.length && index < sourceComments.length; index++) {
			if (sourceComments[index].value !== targetComments[index].value) {
				return targetComments[index - 1];
			}
		}
		return targetComments[index - 1];
	}
	return undefined;
}

interface INode {
	readonly startOffset: number;
	readonly endOffset: number;
	readonly value: string;
	readonly setting?: {
		readonly key: string;
		readonly commaOffset: number | undefined;
	};
	readonly comment?: string;
}

function parseSettings(content: string): INode[] {
	const nodes: INode[] = [];
	let hierarchyLevel = -1;
	let startOffset: number;
	let key: string;

	const visitor: JSONVisitor = {
		onObjectBegin: (offset: number) => {
			hierarchyLevel++;
		},
		onObjectProperty: (name: string, offset: number, length: number) => {
			if (hierarchyLevel === 0) {
				// this is setting key
				startOffset = offset;
				key = name;
			}
		},
		onObjectEnd: (offset: number, length: number) => {
			hierarchyLevel--;
			if (hierarchyLevel === 0) {
				nodes.push({
					startOffset,
					endOffset: offset + length,
					value: content.substring(startOffset, offset + length),
					setting: {
						key,
						commaOffset: undefined
					}
				});
			}
		},
		onArrayBegin: (offset: number, length: number) => {
			hierarchyLevel++;
		},
		onArrayEnd: (offset: number, length: number) => {
			hierarchyLevel--;
			if (hierarchyLevel === 0) {
				nodes.push({
					startOffset,
					endOffset: offset + length,
					value: content.substring(startOffset, offset + length),
					setting: {
						key,
						commaOffset: undefined
					}
				});
			}
		},
		onLiteralValue: (value: any, offset: number, length: number) => {
			if (hierarchyLevel === 0) {
				nodes.push({
					startOffset,
					endOffset: offset + length,
					value: content.substring(startOffset, offset + length),
					setting: {
						key,
						commaOffset: undefined
					}
				});
			}
		},
		onSeparator: (sep: string, offset: number, length: number) => {
			if (hierarchyLevel === 0) {
				if (sep === ',') {
					let index = nodes.length - 1;
					for (; index >= 0; index--) {
						if (nodes[index].setting) {
							break;
						}
					}
					const node = nodes[index];
					if (node) {
						nodes.splice(index, 1, {
							startOffset: node.startOffset,
							endOffset: node.endOffset,
							value: node.value,
							setting: {
								key: node.setting!.key,
								commaOffset: offset
							}
						});
					}
				}
			}
		},
		onComment: (offset: number, length: number) => {
			if (hierarchyLevel === 0) {
				nodes.push({
					startOffset: offset,
					endOffset: offset + length,
					value: content.substring(offset, offset + length),
				});
			}
		}
	};
	visit(content, visitor);
	return nodes;
}
