/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-G -- the vscode-free core of the "bound-cell indicator".
//
// A cell is BOUND iff it is the current target of a live reactive publish. TE1 (var<->cell moat,
// 2026-06-27) made the ENGINE's unified binding registry the single source of truth for that map: a
// published Python var is one engine `BindingInfo` (bindingId == the var name) tying name <-> produced
// range <-> provenance <-> alive. This store is no longer an independent writer -- it is a DERIVED
// MIRROR of `session.bindings()`, rebuilt at each reactive-op boundary by the ReactiveKernelClient
// (`syncBadgesFromEngine`). The badge + the engine therefore can never disagree (the pre-TE1 hazard:
// the host resolved the target itself, so the host badge and the engine binding could drift).
//
//   ReactiveKernelClient applies republishes (publishDataset) -> at the op boundary it reconciles the
//   engine (unbind for G3-refused / kernel-stale vars) and then calls syncFromBindings(session.bindings())
//   -> this store projects that list into per-sheet badge rectangles for the CellGridPanel webview and
//   the COMPLETE set for the MCP `get_published_variables` tool.
//
// Correctness model (the engine is truth; this is its projection):
//   - syncFromBindings(bindings): REPLACE the mirror wholesale with the engine's current bindings. A
//     moved/shrunk target, a re-publish, a structural invalidation (alive=false), and an unbind all
//     arrive as the next engine snapshot -- there is no incremental host-side bookkeeping to drift.
//   - rangesForSheet(sheet): the ALIVE bindings on `sheet` -- the badge shows only live ones. A binding
//     the engine marked `alive=false` (a structural row/col/sheet delete) is suppressed from the badge.
//   - allRangesWithSheet(): EVERY binding (alive OR dead), paired with its (possibly tombstoned-sheet)
//     target -- the MCP tool needs the complete set so a structurally-invalidated var still surfaces
//     (as a `#REF!` ref) rather than being silently omitted. (No-Fallbacks: never silently drop a var.)
//
// vscode-free + napi-free (type-only imports) so it compiles in the extension AND is unit-tested
// headlessly. The kernel `_reg` (kernel-side) and this store are BOTH mirrors of the engine binding --
// never two independent writers; any divergence is a bug, not a fallback.

import type { BindingInfoJson, CellRangeJson } from '../types';

/**
 * One published target on a single sheet, in the host->webview wire shape. Coordinates are 0-based and
 * INCLUSIVE (mirroring CellRangeJson); a publish may target a single cell OR a range (range-aware bind).
 * `name` is the driving variable -- the badge marks the cells, and the formula-bar chip + hover tooltip
 * surface the name (W-G bound-cell name display).
 */
export interface PublishedRange {
	startRow: number;
	startCol: number;
	endRow: number;
	endCol: number;
	name: string;
}

/**
 * Tracks, per reactive session, which cells each published variable currently drives -- a DERIVED MIRROR
 * of the engine's binding registry (TE1). One instance is owned by each {@link ReactiveKernelClient}
 * (the manager keys clients by session), so the store's lifetime is exactly the kernel's: it dies with
 * the client on dispose and a reseed repopulates it from `session.bindings()`.
 */
export class PublishedCellsStore {
	// bindingId (== the published var name) -> { its engine target range, its engine `alive` flag }.
	// A defensive COPY of the engine target is stored so a later mutation of the source BindingInfoJson
	// cannot corrupt the mirror. NOT `readonly`: {@link syncFromBindings} reassigns the whole field
	// (`this.byName = next`) to swap the mirror wholesale, rather than clear()+refill, so a reader can
	// never observe a half-rebuilt map. (`generation`/`forceCheck` from the engine are intentionally not
	// mirrored -- they drive kernel re-publish behavior, not badge geometry.)
	private byName = new Map<string, { range: CellRangeJson; alive: boolean }>();

	/**
	 * Rebuild the mirror from the engine's current binding list (the authoritative source). Returns
	 * `true` iff the BADGE-VISIBLE (alive) projection actually changed, so the caller repaints only when
	 * a badge moved / appeared / cleared -- not on a no-op resync. Dead bindings are retained (for the
	 * MCP complete-set view) but do not affect the badge signature.
	 */
	syncFromBindings(bindings: BindingInfoJson[]): boolean {
		const before = this.aliveSignature();
		const next = new Map<string, { range: CellRangeJson; alive: boolean }>();
		for (const b of bindings) {
			// The engine keys its registry by binding id, so `bindings()` is unique by construction. Assert
			// it LOUD (No-Fallbacks) rather than let a duplicate silently last-write-wins and shrink the
			// mirror below the engine's binding count -- a future engine change that broke uniqueness must
			// fail visibly, not corrupt the badge set.
			if (next.has(b.bindingId)) {
				throw new Error(`PublishedCellsStore.syncFromBindings: duplicate bindingId "${b.bindingId}" from session.bindings()`);
			}
			next.set(b.bindingId, {
				range: {
					sheet: b.target.sheet,
					startRow: b.target.startRow,
					startCol: b.target.startCol,
					endRow: b.target.endRow,
					endCol: b.target.endCol,
				},
				alive: b.alive,
			});
		}
		this.byName = next;
		return this.aliveSignature() !== before;
	}

	/**
	 * A stable, order-independent fingerprint of the ALIVE badge projection (the only thing the webview
	 * paints). Used to decide whether a resync warrants a repaint. Dead bindings are excluded -- a
	 * binding going alive->dead drops out of this signature, which correctly registers as a change. Each
	 * alive binding is one self-delimited JSON record (the name is JSON-quoted so an arbitrary bindRange
	 * id can never collide across records); sorting the records makes the fingerprint order-independent.
	 */
	private aliveSignature(): string {
		const records: string[] = [];
		for (const [name, e] of this.byName) {
			if (e.alive) {
				records.push(JSON.stringify([name, e.range.sheet, e.range.startRow, e.range.startCol, e.range.endRow, e.range.endCol]));
			}
		}
		return records.sort().join('|');
	}

	/** Drop the whole mirror (teardown / explicit reset). A reseed repopulates it from the engine. */
	clear(): void {
		this.byName.clear();
	}

	/** Number of distinct bindings mirrored, alive OR dead (test/diagnostic aid). */
	get size(): number {
		return this.byName.size;
	}

	/**
	 * The ALIVE published ranges that fall on `sheet`, in wire shape. A CellGridPanel renders ONE sheet,
	 * so it asks only for its own sheet's ranges (a two-sheet workbook shows each sheet's own badges).
	 * A structurally-invalidated (dead) binding is suppressed -- the badge tracks only live bindings.
	 * Iteration order follows Map insertion order; callers treat the result as an unordered set.
	 */
	rangesForSheet(sheet: number): PublishedRange[] {
		const out: PublishedRange[] = [];
		for (const [name, e] of this.byName) {
			if (e.alive && e.range.sheet === sheet) {
				out.push({
					startRow: e.range.startRow,
					startCol: e.range.startCol,
					endRow: e.range.endRow,
					endCol: e.range.endCol,
					name,
				});
			}
		}
		return out;
	}

	/**
	 * EVERY mirrored binding (alive OR dead), each with its (possibly now-deleted) target sheet id AND its
	 * `alive` flag. Unlike {@link rangesForSheet} this does NOT filter to alive/live -- the MCP
	 * `get_published_variables` tool needs the COMPLETE set so a variable invalidated by a structural edit
	 * (or tracked on a tombstoned sheet) is never silently omitted. The caller uses `alive` (plus the
	 * tombstoned-sheet `#REF!` rendering it already does for an unknown sheet id) to FLAG an invalidated
	 * binding rather than present a dead one as a live published variable. Iteration follows Map insertion
	 * order.
	 */
	allRangesWithSheet(): Array<{ sheet: number; range: PublishedRange; alive: boolean }> {
		const out: Array<{ sheet: number; range: PublishedRange; alive: boolean }> = [];
		for (const [name, e] of this.byName) {
			out.push({
				sheet: e.range.sheet,
				range: { startRow: e.range.startRow, startCol: e.range.startCol, endRow: e.range.endRow, endCol: e.range.endCol, name },
				alive: e.alive,
			});
		}
		return out;
	}
}
