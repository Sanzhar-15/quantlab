/// <reference lib="dom" />
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Accessibility announcer — Phase 5 step 5.H.1.
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
 *   - encoding assignments (setEncoding, setOhlcv) — polite
 *   - query lifecycle (requestStarted, dataReceived, errorReceived) — polite
 *   - save lifecycle (saveStarted, saveResult) — polite (ok) / assertive (failed)
 *   - drift detection (schemaChanged) — polite
 *   - daemon status transitions to crashed/unavailable — assertive
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
				// Don't announce returning to clean — the user just
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
			// Find first-added / first-changed for the announcement.
			for (const k of curFilterKeys) {
				if (state.inspector.filters[k] !== prev.inspector.filters[k]) {
					emit(`Inspector filter applied to ${k}.`);
					break;
				}
			}
			for (const k of prevFilterKeys) {
				if (state.inspector.filters[k] !== undefined
					&& state.inspector.filters[k] !== state.inspector.filters[k]) { /* unreachable */ }
				if (state.inspector.filters[k] === undefined) {
					emit(`Inspector filter cleared on ${k}.`);
					break;
				}
			}
		}
	}
	if (prev.inspector.selection !== state.inspector.selection) {
		if (state.inspector.selection === null && prev.inspector.selection !== null) {
			emit('Inspector selection cleared.');
		} else if (state.inspector.selection !== null) {
			emit(`Inspector selection: ${String(state.inspector.selection.x)}.`);
		}
	}
	if (prev.inspector.lastError !== state.inspector.lastError
		&& state.inspector.lastError !== null) {
		emit(`Inspector error: ${state.inspector.lastError}.`, 'assertive');
	}
}
