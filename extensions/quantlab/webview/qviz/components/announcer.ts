/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/// <reference lib="dom" />

/**
 * Accessibility announcer -- Phase 5 step 5.H.1.
 *
 * A hidden `aria-live` region that emits speech-friendly status
 * messages for state transitions a screen-reader user would otherwise
 * miss (assignments change visual UI but not always focus; query
 * lifecycle is invisible without the diagnostics readout).
 *
 * Two channels: `polite` (default) and `assertive` (errors). Both are
 * single-line; we set `aria-atomic="true"` so each update is read as
 * a whole rather than diff'd. Messages are deduped within a 1s window
 * so a rapid sequence of identical state changes (e.g., setEncoding
 * called twice via DnD+click) doesn't double-announce.
 *
 * Subscribes to the store and watches:
 *   - encoding assignments (setEncoding, setOhlcv) -- polite
 *   - query lifecycle (requestStarted, dataReceived, errorReceived) -- polite
 *   - save lifecycle (saveStarted, saveResult) -- polite (ok) / assertive (failed)
 *   - drift detection (schemaChanged) -- polite
 *   - daemon status transitions to crashed/unavailable -- assertive
 */

import type { QvizStore, RootState } from '../state/store';

export interface AnnouncerHandle {
	dispose(): void;
	/** Imperative emit for non-state-driven announcements (e.g., DnD
	 *  drop landed). Bypasses the dedup window. */
	announce(message: string, level?: 'polite' | 'assertive'): void;
}

const DEDUP_WINDOW_MS = 1000;

export function mountAnnouncer(root: HTMLElement, store: QvizStore): AnnouncerHandle {
	const polite = document.createElement('div');
	polite.className = 'qviz-announcer qviz-announcer--polite';
	polite.setAttribute('aria-live', 'polite');
	polite.setAttribute('aria-atomic', 'true');
	polite.setAttribute('role', 'status');

	const assertive = document.createElement('div');
	assertive.className = 'qviz-announcer qviz-announcer--assertive';
	assertive.setAttribute('aria-live', 'assertive');
	assertive.setAttribute('aria-atomic', 'true');
	assertive.setAttribute('role', 'alert');

	// Visually hidden but readable by screen readers.
	for (const el of [polite, assertive]) {
		el.style.position = 'absolute';
		el.style.left = '-10000px';
		el.style.top = 'auto';
		el.style.width = '1px';
		el.style.height = '1px';
		el.style.overflow = 'hidden';
	}
	root.appendChild(polite);
	root.appendChild(assertive);

	const recent = new Map<string, number>();
	const emit = (message: string, level: 'polite' | 'assertive' = 'polite'): void => {
		const key = `${level}:${message}`;
		const now = Date.now();
		const last = recent.get(key);
		if (last !== undefined && now - last < DEDUP_WINDOW_MS) { return; }
		recent.set(key, now);
		// Trim old entries opportunistically.
		if (recent.size > 50) {
			for (const [k, t] of recent) {
				if (now - t > DEDUP_WINDOW_MS * 5) { recent.delete(k); }
			}
		}
		const target = level === 'assertive' ? assertive : polite;
		// Clear then set: screen readers re-announce when the text node
		// itself changes (not just its contents).
		target.textContent = '';
		// rAF so the clear lands as a separate paint frame.
		requestAnimationFrame(() => { target.textContent = message; });
	};

	// Track previous state for transition-based announcements.
	let prev: RootState = store.getState();
	const onChange = (state: RootState): void => {
		try {
			diffAndAnnounce(prev, state, emit);
		} finally {
			prev = state;
		}
	};
	const off = store.subscribe(onChange);

	return {
		dispose: () => {
			off();
			polite.remove();
			assertive.remove();
			recent.clear();
		},
		announce: emit,
	};
}

/** Megaudit Theme G (G10, 2026-05-13): format a chart's x-axis
 *  selection value for SR users. If x looks like an epoch timestamp
 *  (plausible ms or s range), emit as ISO; otherwise stringify as-is.
 *  Heuristic: ms epoch 1e12..4e13 (2001..3266) or s epoch 1e9..4e10. */
function formatSelectionX(x: unknown): string {
	if (typeof x === 'number' && Number.isFinite(x)) {
		// ms epoch: 1e12 = 2001-09; 4e13 = 3236-10.
		// s epoch: 1e9 = 2001-09; 4e10 = 3236-10.
		const looksMs = x >= 1e12 && x <= 4e13;
		const looksSec = x >= 1e9 && x < 1e12;
		if (looksMs) {
			return new Date(x).toISOString();
		}
		if (looksSec) {
			return new Date(x * 1000).toISOString();
		}
	}
	return String(x);
}

/**
 * Compare two states and emit announcements for meaningful transitions.
 * Each branch is intentionally narrow (announces the SPECIFIC thing
 * that changed, not a generic "state updated") so screen readers
 * convey useful context.
 */
function diffAndAnnounce(
	prev: RootState,
	state: RootState,
	emit: (message: string, level?: 'polite' | 'assertive') => void,
): void {
	// Encoding assignments via shelves.
	const prevEnc = prev.spec.current?.chart.encodings;
	const curEnc = state.spec.current?.chart.encodings;
	if (curEnc !== prevEnc && prevEnc !== undefined && curEnc !== undefined) {
		const channels: ('x' | 'y' | 'y2' | 'color' | 'size' | 'shape' | 'facet_row' | 'facet_col')[]
			= ['x', 'y', 'y2', 'color', 'size', 'shape', 'facet_row', 'facet_col'];
		for (const ch of channels) {
			const before = prevEnc[ch]?.field;
			const after = curEnc[ch]?.field;
			if (before !== after) {
				if (after !== undefined && before === undefined) {
					emit(`Assigned ${after} to ${ch}.`);
				} else if (after === undefined && before !== undefined) {
					emit(`Cleared ${ch}.`);
				} else if (after !== undefined && before !== undefined) {
					emit(`Replaced ${ch} with ${after}.`);
				}
			}
		}
		// OHLCV cluster: announce just "OHLCV updated" rather than per-slot.
		if (prevEnc.ohlcv !== curEnc.ohlcv) {
			emit('OHLCV cluster updated.');
		}
	}

	// Chart type swap.
	const prevType = prev.spec.current?.chart.type;
	const curType = state.spec.current?.chart.type;
	if (prevType !== curType && curType !== undefined) {
		emit(`Chart type changed to ${curType}.`);
	}

	// Query lifecycle.
	const prevInflight = prev.query.inflight;
	const curInflight = state.query.inflight;
	if (prevInflight === null && curInflight !== null) {
		emit('Computing chart…');
	}
	if (prevInflight !== null && curInflight === null
		&& state.query.lastData !== prev.query.lastData
		&& state.query.lastData !== null) {
		const ms = state.query.lastData.elapsedMs;
		emit(`Chart updated in ${Math.round(ms)} milliseconds.`);
	}
	if (state.query.lastErrorMessage !== null
		&& state.query.lastErrorMessage !== prev.query.lastErrorMessage) {
		emit(`Query failed: ${state.query.lastErrorMessage}`, 'assertive');
	}

	// Save lifecycle.
	if (prev.persistence.lastStatus !== state.persistence.lastStatus) {
		if (state.persistence.lastStatus === 'ok') {
			emit(`Saved to ${state.persistence.lastFsPath ?? 'file'}.`);
		} else if (state.persistence.lastStatus === 'failed') {
			emit(`Save failed: ${state.persistence.lastError ?? 'unknown error'}.`, 'assertive');
		}
	}

	// Drift detection.
	if (prev.schema.drift !== state.schema.drift) {
		switch (state.schema.drift) {
			case 'fields-preserved':
				emit('Data file changed; schema fields preserved.');
				break;
			case 'fields-missing':
				emit(
					`Data file changed; ${state.schema.missingFields.length} field(s) missing: `
					+ state.schema.missingFields.join(', '),
					'assertive',
				);
				break;
			case 'same-hash':
				// Don't announce returning to clean -- the user just
				// saved or the drift was resolved silently.
				break;
		}
	}

	// Daemon status.
	if (prev.runtime.daemonStatus !== state.runtime.daemonStatus) {
		const s = state.runtime.daemonStatus;
		if (s === 'crashed') {
			emit('Daemon crashed; retrying.', 'assertive');
		} else if (s === 'unavailable') {
			emit(
				`Daemon unavailable${state.runtime.daemonLastError ? ': ' + state.runtime.daemonLastError : ''}.`,
				'assertive',
			);
		} else if (s === 'ready' && (prev.runtime.daemonStatus === 'crashed' || prev.runtime.daemonStatus === 'respawning')) {
			emit('Daemon ready.');
		}
	}

	// Audit M-42 (2026-05-11): inspector announcements so SR users
	// hear filter / selection / error transitions.
	if (prev.inspector.visible !== state.inspector.visible) {
		emit(state.inspector.visible ? 'Data inspector opened.' : 'Data inspector closed.');
	}
	const prevFilterKeys = Object.keys(prev.inspector.filters);
	const curFilterKeys = Object.keys(state.inspector.filters);
	if (prevFilterKeys.length !== curFilterKeys.length
		|| prevFilterKeys.some(k => state.inspector.filters[k] !== prev.inspector.filters[k])) {
		if (curFilterKeys.length === 0 && prevFilterKeys.length > 0) {
			emit('All inspector filters cleared.');
		} else {
			// Megaudit Theme D (D2, 2026-05-13): rewrite the diff to use
			// the union of prev+cur keys and compare against PREV for
			// "cleared" vs CUR for "applied/updated". The prior loops
			// had two bugs:
			//   (a) a stray `state.inspector.filters[k] !== state.inspector.filters[k]`
			//       check (always false except NaN) flagged as unreachable
			//       but indicates the diff was hand-typed against the
			//       wrong reference.
			//   (b) partial-clear (clearing 1 of 3 filters) would also
			//       enter the "applied" loop and announce "filter
			//       applied to <surviving-key>" — false positive.
			const allKeys = new Set([...prevFilterKeys, ...curFilterKeys]);
			for (const k of allKeys) {
				const had = prev.inspector.filters[k] !== undefined;
				const has = state.inspector.filters[k] !== undefined;
				if (had && !has) {
					emit(`Inspector filter cleared on ${k}.`);
					break;
				} else if (!had && has) {
					emit(`Inspector filter applied to ${k}.`);
					break;
				} else if (had && has && state.inspector.filters[k] !== prev.inspector.filters[k]) {
					emit(`Inspector filter updated on ${k}.`);
					break;
				}
			}
		}
	}
	if (prev.inspector.selection !== state.inspector.selection) {
		if (state.inspector.selection === null && prev.inspector.selection !== null) {
			emit('Inspector selection cleared.');
		} else if (state.inspector.selection !== null) {
			// Megaudit Theme G (G10, 2026-05-13): when x is a plausible
			// epoch timestamp (large finite number in ms or s range),
			// announce it as an ISO string instead of raw ms — SR users
			// won't parse "1715638800000" but "2024-05-13T..." is
			// readable.
			emit(`Inspector selection: ${formatSelectionX(state.inspector.selection.x)}.`);
		}
	}
	if (prev.inspector.lastError !== state.inspector.lastError
		&& state.inspector.lastError !== null) {
		// Megaudit D3 (2026-05-13) + audit revision: vary the verb by
		// kind so SR users hear a meaningful action signal. Use an
		// exhaustive switch so a future kind added to
		// `InspectorErrorKind` fails the TS compile rather than
		// silently falling into a default. `kind === null` while
		// `lastError !== null` is an invariant violation (enforced
		// in the reducer); we log and treat it as 'internal' for
		// announcement purposes — better to surface a generic
		// message than to omit the announcement entirely.
		const kind = state.inspector.lastErrorKind;
		if (kind === null) {
			console.error(
				'[qviz announcer] invariant violation: lastError set but '
				+ 'lastErrorKind=null. Announcing as generic error.',
			);
			emit(`Inspector error: ${state.inspector.lastError}.`, 'assertive');
		} else {
			let verb: string;
			switch (kind) {
				case 'security':
				case 'protocol':
				case 'compile':
					verb = 'Inspector denied'; break;
				case 'timeout':
				case 'memory':
				case 'internal':
					verb = 'Inspector error'; break;
				default: {
					const _exhaustive: never = kind;
					throw new Error(`unhandled inspector kind: ${String(_exhaustive)}`);
				}
			}
			emit(`${verb} (${kind}): ${state.inspector.lastError}.`, 'assertive');
		}
	}
}
