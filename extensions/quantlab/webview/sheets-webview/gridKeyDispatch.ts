/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-4 keyboard STATE MACHINE -- the pure, vscode-free, DOM-free classifier that turns a keystroke
// (mode + key + modifiers) into a DESCRIPTIVE action. The thin imperative layer in `index.ts` executes
// the action through the EXISTING machinery (jumpActive/beginEdit/commitEdit/clearActiveCell/etc.).
//
// **This is a REFACTOR, not a rewrite.** Every action this module returns maps 1:1 onto a behavior the
// shipped flat switch (the document `keydown`) and `onEditKeydown` already implemented; the imperative
// layer is unchanged for guard ordering and side effects. The dispatcher's ONLY job is the post-guard
// key CLASSIFICATION that used to live inline -- now it is a single, exhaustively unit-tested table.
//
// **What the dispatcher does NOT own (still imperative in `index.ts`, by design):**
//   - the document handler's early-return GUARDS: formula-bar bubble, find-bar key ownership, the
//     `editState !== null` early-return, the completion-dropdown null guard, the fill-drag guard, and the
//     IME (`isComposing` / keyCode 229) guard. Those decide WHETHER a key reaches the dispatcher at all;
//     they are not key-classification and they read live webview state (`editState`, `fillSource`, ...).
//   - the editor handler's IME guard, the `editState`/target match, the completion-dropdown key-steal
//     (Up/Down/Enter/Tab/Esc drive the list), the pending-commit swallow, and the Megaudit-B2
//     known-bad-cell abandon. Those also read live state; the dispatcher classifies only what reaches the
//     plain edit path. F4 (the one NEW edit-mode key) IS classified here so it is covered by the table.
//
// **No-Fallbacks:** an unhandled key returns an explicit `{ kind: 'passthrough' }` action -- never a
// silent default that eats a key. The imperative layer treats `passthrough` as "do nothing, let the
// browser / native input handle it" (i.e. it does NOT preventDefault).

/**
 * The four keyboard modes of the grid.
 *   - `nav`     : a single cell is the focus, no editor open. Arrows move; a printable char begins an edit;
 *                 Delete clears; F2 edits; meta keys do copy/paste/find/undo/redo/jumps; Ctrl-D/R fill.
 *   - `range`   : a MULTI-cell selection exists (an anchor is set) and no editor is open. Identical to
 *                 `nav` for every key EXCEPT the selection-aware ones: a plain arrow collapses + moves
 *                 (handled the same), Escape collapses the range, and Ctrl-D/R fill ACROSS the range
 *                 (vs the single-cell "from the cell above/left" fill in `nav`). The dispatcher returns the
 *                 SAME action kinds for both; the imperative layer reads the live selection to size the fill.
 *   - `edit`    : the in-cell overlay OR the formula bar is the live editor and the value does NOT start
 *                 with `=`. Enter/Tab/Esc/arrows have edit-commit/caret semantics; F4 is a no-op (no ref).
 *   - `formula` : editing a value that starts with `=` (a formula; autocomplete may be active). Same as
 *                 `edit` PLUS F4 cycles the ref at the caret (abs/rel). The autocomplete key-steal is a
 *                 separate imperative guard ABOVE this path (it never reaches the dispatcher).
 */
export type GridMode = 'nav' | 'range' | 'edit' | 'formula';

/** True when `mode` is a nav-style mode (no editor open): `nav` or `range`. */
export function isNavLike(mode: GridMode): boolean {
	return mode === 'nav' || mode === 'range';
}

/** True when `mode` is an editor mode (an editor is open): `edit` or `formula`. */
export function isEditLike(mode: GridMode): boolean {
	return mode === 'edit' || mode === 'formula';
}

/** The modifier flags read off a `KeyboardEvent`. `meta` is the unified Ctrl/Cmd (`ctrlKey || metaKey`) --
 *  the document handler treats them identically (`isMeta`). `shift` and `alt` are the raw flags. */
export interface KeyModifiers {
	readonly meta: boolean;
	readonly shift: boolean;
	readonly alt: boolean;
}

/**
 * A descriptive action the imperative layer executes. Each variant names exactly one shipped behavior:
 *   - `nav`         : move (or, with `extend`, shift-extend) the selection by (dr,dc). The document
 *                     handler's ArrowUp/Down/Left/Right (plain = move, shift = extend) and Enter (move down)
 *                     and Tab (move right, shift-Tab left) and PageUp/PageDown all map here.
 *   - `jump`        : land on an ABSOLUTE target. `target` selects which absolute cell the imperative
 *                     layer resolves (it owns the snapshot extent + the current row): `a1` (Ctrl+Home),
 *                     `usedEnd` (End / Ctrl+End), `rowStart` (plain Home -> column A of the current row).
 *   - `pageMove`    : move by one screenful of rows (PageUp = up, PageDown = down). The imperative layer
 *                     reads `visibleRowSpan()` for the magnitude; `dir` is -1 (up) / +1 (down).
 *   - `collapse`    : collapse a multi-cell range back to the focus cell (Escape in range mode). A no-op
 *                     in nav mode (no anchor) -- the imperative layer guards on `anchor !== null` exactly
 *                     as the shipped Escape arm did.
 *   - `beginEdit`   : open the editor. `char` is the type-to-edit seed (a single printable char), or
 *                     undefined for F2 (open with the prior content selected).
 *   - `clear`       : Delete/Backspace clear of the active cell.
 *   - `copy`/`cut`/`paste` : the Ctrl/Cmd + C / X / V clipboard ops.
 *   - `find`        : Ctrl/Cmd + F -> open the in-sheet find bar.
 *   - `undo`/`redo` : Ctrl/Cmd + Z / Shift+Z / Y.
 *   - `fillDown`/`fillRight` : Ctrl/Cmd + D / R.
 *   - `commitMove`  : (edit/formula) commit the edit and move (Enter = down, Tab = right, Shift+Tab left).
 *   - `editEscape`  : (edit/formula) cancel the edit (Escape).
 *   - `editArrow`   : (edit/formula) an arrow inside the editor -- the imperative layer decides between
 *                     "move the text caret" (a normal edit) and "abandon a known-bad cell + navigate" (the
 *                     Megaudit-B2 contract). The dispatcher only says "this is an editor arrow"; the
 *                     known-bad branch reads live `editState`.
 *   - `cycleRef`    : (formula) F4 -- cycle the ref at the caret abs/rel.
 *   - `passthrough` : NOT handled here -- the imperative layer does NOT preventDefault; the browser / the
 *                     native <input> handles it (typing a char into the editor, a caret Home/End, etc.).
 *                     No-Fallbacks: an unknown key is ALWAYS this explicit variant, never a silent eat.
 */
export type GridAction =
	| { readonly kind: 'nav'; readonly dr: number; readonly dc: number; readonly extend: boolean }
	| { readonly kind: 'jump'; readonly target: 'a1' | 'usedEnd' | 'rowStart' }
	| { readonly kind: 'pageMove'; readonly dir: -1 | 1 }
	| { readonly kind: 'collapse' }
	| { readonly kind: 'beginEdit'; readonly char?: string }
	| { readonly kind: 'clear' }
	| { readonly kind: 'copy' }
	| { readonly kind: 'cut' }
	| { readonly kind: 'paste' }
	| { readonly kind: 'find' }
	| { readonly kind: 'undo' }
	| { readonly kind: 'redo' }
	| { readonly kind: 'fillDown' }
	| { readonly kind: 'fillRight' }
	| { readonly kind: 'commitMove'; readonly dr: number; readonly dc: number }
	| { readonly kind: 'editEscape' }
	| { readonly kind: 'editArrow'; readonly dr: number; readonly dc: number }
	| { readonly kind: 'cycleRef' }
	| { readonly kind: 'passthrough' };

const PASSTHROUGH: GridAction = { kind: 'passthrough' };

/**
 * Classify a META (Ctrl/Cmd) keystroke in a NAV-LIKE mode. Mirrors the document handler's `isMeta` block
 * EXACTLY (the post-guard order): Z/Shift+Z/Y, C/X/V, F, D/R (fill), Ctrl+Home/End. Any other meta combo
 * is `passthrough` (the shipped handler's `return; // leave other meta combos alone`). Case-insensitive on
 * the letter keys (the handler lowercased `ev.key`).
 */
function dispatchNavMeta(key: string, mods: KeyModifiers): GridAction {
	const lower = key.toLowerCase();
	if (lower === 'z' && !mods.shift) {
		return { kind: 'undo' };
	}
	if ((lower === 'z' && mods.shift) || lower === 'y') {
		return { kind: 'redo' };
	}
	if (lower === 'c') {
		return { kind: 'copy' };
	}
	if (lower === 'x') {
		return { kind: 'cut' };
	}
	if (lower === 'v') {
		return { kind: 'paste' };
	}
	if (lower === 'f') {
		return { kind: 'find' };
	}
	// FE-4: Ctrl/Cmd + D fills down, Ctrl/Cmd + R fills right (Excel). New keys; nav/range only.
	if (lower === 'd') {
		return { kind: 'fillDown' };
	}
	if (lower === 'r') {
		return { kind: 'fillRight' };
	}
	// Ctrl/Cmd + Home -> A1; Ctrl/Cmd + End -> the last used cell. `key` is 'Home' / 'End' regardless of meta.
	if (key === 'Home') {
		return { kind: 'jump', target: 'a1' };
	}
	if (key === 'End') {
		return { kind: 'jump', target: 'usedEnd' };
	}
	return PASSTHROUGH; // leave other meta combos alone (the shipped "return" arm)
}

/**
 * Classify a PLAIN (no meta, no alt) keystroke in a NAV-LIKE mode. Mirrors the document handler's plain
 * `switch (ev.key)` + the type-to-edit tail EXACTLY:
 *   - Arrow{Up,Down,Left,Right}: move, or shift-extend (`{kind:'nav', extend: shift}`);
 *   - Enter: move down (NEVER extends -- Excel; the shipped Enter arm calls moveActive(1,0));
 *   - Tab: move right, Shift+Tab left (NEVER extends -- the shipped Tab arm);
 *   - Home: rowStart jump; End: usedEnd jump;
 *   - PageUp/PageDown: pageMove;
 *   - Escape: collapse (a no-op when no range, guarded imperatively);
 *   - F2: beginEdit (no char);
 *   - Delete/Backspace: clear;
 *   - a single printable char: beginEdit with that char (type-to-edit);
 *   - anything else: passthrough.
 * `shift` is consulted ONLY for the arrows (extend) and Tab (reverse). The alt guard is applied by the
 * caller (the shipped handler `return`s on `altKey` before the switch).
 */
function dispatchNavPlain(key: string, mods: KeyModifiers): GridAction {
	switch (key) {
		case 'ArrowUp':
			return { kind: 'nav', dr: -1, dc: 0, extend: mods.shift };
		case 'ArrowDown':
			return { kind: 'nav', dr: 1, dc: 0, extend: mods.shift };
		case 'ArrowLeft':
			return { kind: 'nav', dr: 0, dc: -1, extend: mods.shift };
		case 'ArrowRight':
			return { kind: 'nav', dr: 0, dc: 1, extend: mods.shift };
		case 'Enter':
			return { kind: 'nav', dr: 1, dc: 0, extend: false }; // Excel: Enter on a selected cell moves down
		case 'Tab':
			return { kind: 'nav', dr: 0, dc: mods.shift ? -1 : 1, extend: false };
		case 'Home':
			return { kind: 'jump', target: 'rowStart' };
		case 'End':
			return { kind: 'jump', target: 'usedEnd' };
		case 'PageUp':
			return { kind: 'pageMove', dir: -1 };
		case 'PageDown':
			return { kind: 'pageMove', dir: 1 };
		case 'Escape':
			return { kind: 'collapse' };
		case 'F2':
			return { kind: 'beginEdit' };
		case 'Delete':
		case 'Backspace':
			return { kind: 'clear' };
		default:
			break;
	}
	// Type-to-edit: a single printable char opens the editor pre-filled with it. (The caller has already
	// excluded the active === null case; we classify the key only.)
	if (key.length === 1) {
		return { kind: 'beginEdit', char: key };
	}
	return PASSTHROUGH;
}

/**
 * Classify a keystroke in an EDIT-LIKE mode (`edit` or `formula`). Mirrors `onEditKeydown`'s PLAIN path
 * (post the IME / dropdown-steal / pending-commit / known-bad guards, which stay imperative):
 *   - Escape: `editEscape` (cancel the edit);
 *   - Enter: `commitMove` down; Tab: `commitMove` right, Shift+Tab left (the `navVector` table);
 *   - Arrow{Up,Down,Left,Right}: `editArrow` -- the imperative layer routes between caret-move and the
 *     Megaudit-B2 known-bad abandon (it reads live `editState`); the dispatcher only carries the vector;
 *   - F4 (formula mode only): `cycleRef` -- cycle the ref at the caret. In plain `edit` mode (no leading
 *     `=`) F4 is `passthrough` (nothing to cycle);
 *   - anything else (printable, Home/End, Backspace, ...): `passthrough` -- the <input> edits natively.
 * Meta/alt combos in an editor are `passthrough` (native text editing: Ctrl+A select-all, Ctrl+C copy of
 * selected text, etc. -- the shipped editor handler never intercepted them).
 */
function dispatchEdit(mode: GridMode, key: string, mods: KeyModifiers): GridAction {
	// F4 ref-cycle is the only key the EDITOR handler newly owns; it must beat the meta passthrough below
	// only if F4 is ever sent with a modifier (it is not in practice, but classify defensively: a bare F4).
	if (key === 'F4' && !mods.meta && !mods.alt) {
		return mode === 'formula' ? { kind: 'cycleRef' } : PASSTHROUGH;
	}
	// In an editor, a META/ALT chord is native text editing -- never a grid command. Passthrough.
	if (mods.meta || mods.alt) {
		return PASSTHROUGH;
	}
	switch (key) {
		case 'Escape':
			return { kind: 'editEscape' };
		case 'Enter':
			return { kind: 'commitMove', dr: 1, dc: 0 };
		case 'Tab':
			return { kind: 'commitMove', dr: 0, dc: mods.shift ? -1 : 1 };
		case 'ArrowUp':
			return { kind: 'editArrow', dr: -1, dc: 0 };
		case 'ArrowDown':
			return { kind: 'editArrow', dr: 1, dc: 0 };
		case 'ArrowLeft':
			return { kind: 'editArrow', dr: 0, dc: -1 };
		case 'ArrowRight':
			return { kind: 'editArrow', dr: 0, dc: 1 };
		default:
			return PASSTHROUGH;
	}
}

/**
 * THE dispatcher. Classify a post-guard keystroke into a {@link GridAction} for the given mode. Pure: no
 * DOM, no vscode, no live webview state. The imperative layer in `index.ts` calls this AFTER its early-return
 * guards have decided the key reaches the keyboard core, then executes the returned action.
 *
 * Mode routing:
 *   - `nav` / `range`  -> meta combos via {@link dispatchNavMeta}; alt-combos passthrough; plain keys via
 *     {@link dispatchNavPlain}. (`range` differs from `nav` only in how the imperative layer SIZES a fill
 *     and that `collapse` actually collapses -- the action KINDS are identical, by design.)
 *   - `edit` / `formula` -> {@link dispatchEdit}.
 */
export function gridKeyDispatch(mode: GridMode, key: string, mods: KeyModifiers): GridAction {
	if (isEditLike(mode)) {
		return dispatchEdit(mode, key, mods);
	}
	// nav-like.
	if (mods.meta) {
		return dispatchNavMeta(key, mods);
	}
	if (mods.alt) {
		return PASSTHROUGH; // the shipped handler `return`s on altKey before the plain switch
	}
	return dispatchNavPlain(key, mods);
}
