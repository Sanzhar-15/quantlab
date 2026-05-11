/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Schema-drift detector — Phase 5 step 5.C.2.
 *
 * Pure module. No vscode imports. No I/O. Given a `QvizSpec` and the
 * currently-live `SchemaInfo` for its dataset, report which of the
 * three drift branches applies:
 *
 *   - `same-hash`       — `spec.dataset.schema_hash` matches the live
 *                          schema's hash. The spec is consistent with
 *                          the file; webview opens normally.
 *   - `fields-preserved` — schema_hash changed (columns added / removed
 *                          / dtype-changed) but every column the spec
 *                          REFERENCES still exists in the new schema.
 *                          UI should warn ("data file changed since
 *                          spec was saved; save to update provenance").
 *   - `fields-missing`   — at least one column referenced by the spec
 *                          (encoding `field`, ohlcv member, transform
 *                          `column`, aggregate `column`, etc.) no
 *                          longer exists in the new schema. UI
 *                          highlights the broken references and refuses
 *                          to run aggregates until the user fixes them.
 *
 * The detector inspects every place a column name can appear in the
 * spec. Every Transform discriminant is handled explicitly (with a
 * compile-time exhaustiveness check) so a future Transform variant
 * can't silently slip through and produce a false `fields-preserved`.
 */

import type {
	AggregateTransform, BinTransform, DateTruncTransform, FilterTransform,
	GroupByTransform, MathTransform, QvizSpec, ResampleTransform,
	SortTransform, Transform, TzConvertTransform, WindowTransform,
} from './spec';
import type { SchemaInfo } from './messageProtocol';
import { assertNeverTransform } from './spec';

export type SchemaDriftKind = 'same-hash' | 'fields-preserved' | 'fields-missing';

export interface DriftResult {
	readonly drift: SchemaDriftKind;
	readonly oldHash: string;
	readonly newHash: string;
	/** Field names referenced by the spec but absent from the live schema.
	 *  Empty unless `drift === 'fields-missing'`. */
	readonly missingFields: readonly string[];
}

/**
 * Compute drift between the spec's recorded schema and the live one.
 *
 * `spec.dataset.schema_hash` is the hash captured when the spec was
 * last saved. `currentSchema.schema_hash` is the hash of the file as
 * it sits on disk now.
 *
 * Hash format requirement: both must be `sha256:<64 hex>`. Caller is
 * responsible for ensuring this; no validation here (the protocol
 * layer rejects malformed hashes upstream).
 */
export function detectDrift(spec: QvizSpec, currentSchema: SchemaInfo): DriftResult {
	const oldHash = spec.dataset.schema_hash;
	const newHash = currentSchema.schema_hash;
	if (oldHash === newHash) {
		return { drift: 'same-hash', oldHash, newHash, missingFields: [] };
	}
	const referenced = collectReferencedFields(spec);
	const liveColumns = new Set(currentSchema.columns.map(c => c.name));
	const missing: string[] = [];
	for (const f of referenced) {
		if (!liveColumns.has(f)) { missing.push(f); }
	}
	if (missing.length === 0) {
		return { drift: 'fields-preserved', oldHash, newHash, missingFields: [] };
	}
	// Stable order: first encountered wins. Dedupe though — a field
	// referenced multiple times only appears once.
	const dedup: string[] = [];
	const seen = new Set<string>();
	for (const f of missing) {
		if (!seen.has(f)) { seen.add(f); dedup.push(f); }
	}
	return { drift: 'fields-missing', oldHash, newHash, missingFields: dedup };
}

/**
 * Walk a spec and collect every column name it references. Used by
 * `detectDrift` to decide between `fields-preserved` and `fields-missing`.
 *
 * Includes:
 *   - All encoding `field` values (x, y, y2, color, size, shape, facet_row,
 *     facet_col).
 *   - OhlcvEncoding members (time, open, high, low, close, volume).
 *   - Transform inputs: filter.column, date_trunc.column, bin.column,
 *     groupby.columns, aggregate.aggs[*].column, window.column,
 *     math.column, resample.time_column, tz_convert.column,
 *     sort.columns[*].column.
 *
 * Does NOT include transform OUTPUT names (`as`) because those are
 * synthesized by the transform itself and only become live after the
 * pipeline runs. The drift detector cares about INPUTS — fields the
 * spec assumes exist in the source file.
 *
 * Note: a transform's output name CAN be referenced by a downstream
 * transform's input (e.g. `bin → groupby`). Such a reference is NOT
 * a missing-field issue because it points at a synthesized column,
 * not a source column. We track produced names and exclude them from
 * the "must exist in source schema" check.
 */
export function collectReferencedFields(spec: QvizSpec): readonly string[] {
	const sourceRefs: string[] = [];
	const produced = new Set<string>();

	// Walk transforms in order. At each transform, references are
	// classified IMMEDIATELY (before this transform's outputs are
	// registered) so an output that LATER aliases a name doesn't
	// retroactively hide an earlier source-column reference.
	//
	// Step C megaudit SD2 (Critical): the prior implementation
	// collected all references first then filtered against the FULL
	// produced set, so a later transform's `as: 'name'` could mask an
	// earlier transform's reference to a source column literally named
	// 'name'. Drift detection silently failed to flag genuinely missing
	// fields. The per-reference filter at the point-of-reference fixes
	// that.
	for (const t of spec.transforms) {
		const localRefs: string[] = [];
		walkTransformReferences(t, localRefs);
		for (const ref of localRefs) {
			if (!produced.has(ref)) { sourceRefs.push(ref); }
		}
		// AFTER walking references, register what this transform produces.
		registerProducedNames(t, produced);
	}

	// Walk encodings. Encoding fields can reference produced names from
	// any prior transform (the encoding "runs" after all transforms).
	const encodings = spec.chart.encodings;
	for (const channel of ENCODING_CHANNELS) {
		const enc = encodings[channel];
		if (enc && !produced.has(enc.field)) { sourceRefs.push(enc.field); }
	}
	if (encodings.ohlcv) {
		const o = encodings.ohlcv;
		for (const member of [o.time, o.open, o.high, o.low, o.close]) {
			if (!produced.has(member)) { sourceRefs.push(member); }
		}
		if (o.volume !== undefined && !produced.has(o.volume)) {
			sourceRefs.push(o.volume);
		}
	}

	return sourceRefs;
}

const ENCODING_CHANNELS: readonly (
	'x' | 'y' | 'y2' | 'color' | 'size' | 'shape' | 'facet_row' | 'facet_col'
)[] = ['x', 'y', 'y2', 'color', 'size', 'shape', 'facet_row', 'facet_col'];

function walkTransformReferences(
	t: Transform, referenced: string[],
): void {
	switch (t.kind) {
		case 'filter': {
			const f: FilterTransform = t;
			referenced.push(f.column);
			return;
		}
		case 'date_trunc': {
			const f: DateTruncTransform = t;
			referenced.push(f.column);
			return;
		}
		case 'bin': {
			const f: BinTransform = t;
			referenced.push(f.column);
			return;
		}
		case 'groupby': {
			const f: GroupByTransform = t;
			for (const c of f.columns) { referenced.push(c); }
			return;
		}
		case 'aggregate': {
			const f: AggregateTransform = t;
			for (const op of f.aggs) {
				// 'count' over no column is permitted by some specs;
				// here every AggregationOp has a `column` (per the type).
				referenced.push(op.column);
			}
			return;
		}
		case 'window': {
			const f: WindowTransform = t;
			referenced.push(f.column);
			return;
		}
		case 'math': {
			const f: MathTransform = t;
			referenced.push(f.column);
			return;
		}
		case 'resample': {
			const f: ResampleTransform = t;
			referenced.push(f.time_column);
			return;
		}
		case 'tz_convert': {
			const f: TzConvertTransform = t;
			referenced.push(f.column);
			return;
		}
		case 'sort': {
			const f: SortTransform = t;
			for (const c of f.columns) { referenced.push(c.column); }
			return;
		}
		case 'limit': {
			// limit references no fields.
			return;
		}
		default:
			assertNeverTransform(t);
	}
}

function registerProducedNames(t: Transform, produced: Set<string>): void {
	switch (t.kind) {
		case 'date_trunc':
		case 'bin':
		case 'window':
		case 'math':
			produced.add(t.as);
			return;
		case 'aggregate':
			for (const op of t.aggs) { produced.add(op.as); }
			return;
		case 'resample':
			if (t.as_time !== undefined) { produced.add(t.as_time); }
			return;
		case 'tz_convert':
			if (t.as !== undefined) { produced.add(t.as); }
			return;
		case 'filter':
		case 'groupby':
		case 'sort':
		case 'limit':
			// No output name to register.
			return;
		default:
			assertNeverTransform(t);
	}
}
