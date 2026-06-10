/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **Sheet-tabs (2026-06-10)** -- the Excel-style bottom tab strip for the Quantbook cell grid.
 *
 * Renders one tab per live sheet (from the host `render` payload's `sheets` + `activeSheet`),
 * highlights the active one, and a trailing `+` to add. Interactions post back to the host via the
 * injected {@link SheetTabHandlers} (index.ts wires them to `vscode.postMessage`): click = switch,
 * double-click = rename, right-click = a small menu (Rename / Delete / Move Left / Move Right),
 * `+` = add. The host owns ALL sheet mutation (this module is presentation only); it is vscode-free
 * so the pure helpers ({@link buildSheetStripModel} / {@link moveIndex} / {@link placeTabContextMenu})
 * are unit-tested.
 */

export interface SheetTabInfo {
	readonly id: number;
	readonly name: string;
}

export interface SheetTabModel extends SheetTabInfo {
	readonly active: boolean;
}

/** Pure: the strip's render model -- the sheets in display order with the active one flagged. */
export function buildSheetStripModel(sheets: ReadonlyArray<SheetTabInfo>, activeId: number): SheetTabModel[] {
	return sheets.map(s => ({ id: s.id, name: s.name, active: s.id === activeId }));
}

/**
 * Pure: the target display index for a ONE-step move of `id` within `order`, or `null` if `id` is
 * absent OR already at the relevant end (`dir = -1` left / `+1` right). Mirrors the host's `moveSheet`
 * one-step math (remove source, insert at idx +/- 1) so a tab "Move Left/Right" and the host agree.
 */
export function moveIndex(order: ReadonlyArray<number>, id: number, dir: -1 | 1): number | null {
	const idx = order.indexOf(id);
	if (idx < 0) {
		return null;
	}
	const target = idx + dir;
	if (target < 0 || target >= order.length) {
		return null;
	}
	return target;
}

/**
 * The strip's outbound commands, injected by index.ts. **Contract (Codex r3 fix-verify HIGH,
 * 2026-06-10): every implementation must resolve any open cell/formula editor BEFORE its post
 * reaches the host** -- index.ts satisfies this by wrapping the five mutating handlers in
 * `runAfterResolvingEdit` and routing `switchTo` through `requestSheetSwitch` (the same resolver,
 * `sheetSwitch` kind). This module stays presentation-only and guard-free BY DESIGN: it is
 * vscode-free so its pure helpers unit-test without the editor state machine, and wrapping at the
 * handler-construction seam covers every call site here ('+' click, double-click rename, and the
 * right-click menu items) in one audited place instead of five.
 */
export interface SheetTabHandlers {
	switchTo(id: number): void;
	add(): void;
	rename(id: number): void;
	remove(id: number): void;
	moveLeft(id: number): void;
	moveRight(id: number): void;
}

/**
 * Pure: viewport-clamped placement for the tab context menu (Codex HIGH, 2026-06-10). The strip sits at
 * the BOTTOM of the window, so the naive `left/top = clientX/clientY` opened the menu DOWNWARD, off-screen
 * below the viewport on every right-click. Geometry (the menu is `position: fixed`, so the click point and
 * the viewport size share the same coordinate frame):
 *   - **Vertical**: open downward (`top = clickY`, the platform-menu default) when the menu FITS below the
 *     click; otherwise FLIP UPWARD, anchoring the menu's BOTTOM just above the cursor (`top = clickY -
 *     menuH`), then clamp to the top edge (a menu taller than the viewport overflows the bottom, never the
 *     top -- the first items stay reachable).
 *   - **Horizontal**: `left = clickX` clamped so the menu's right edge never passes the viewport's
 *     (`viewportW - menuW`), then clamped to the left edge (a menu wider than the viewport pins at 0).
 * No fallbacks hide here: the caller measures the REAL menu via getBoundingClientRect after appending it;
 * this function is total over finite inputs and unit-tested in `test/quantbook-sheet-tabs.test.ts`.
 */
export function placeTabContextMenu(
	clickX: number,
	clickY: number,
	menuW: number,
	menuH: number,
	viewportW: number,
	viewportH: number,
): { left: number; top: number } {
	const left = Math.max(0, Math.min(clickX, viewportW - menuW));
	const top = clickY + menuH > viewportH
		? Math.max(0, clickY - menuH) // flip upward: bottom edge just above the cursor
		: clickY;
	return { left, top };
}

// A single reusable right-click menu element (created lazily). One-at-a-time so a right-click never
// leaks stacked menus; dismissed on any outside pointerdown / Escape / window blur / an action.
let menuEl: HTMLDivElement | null = null;
let dismissWired = false;

function dismissMenu(): void {
	if (menuEl !== null) {
		menuEl.remove();
		menuEl = null;
	}
}

function ensureDismissWiring(): void {
	if (dismissWired) {
		return;
	}
	dismissWired = true;
	// Capture-phase pointerdown so a click anywhere outside the menu closes it before it acts.
	document.addEventListener('pointerdown', (e) => {
		if (menuEl !== null && e.target instanceof Node && !menuEl.contains(e.target)) {
			dismissMenu();
		}
	}, true);
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			dismissMenu();
		}
	});
	window.addEventListener('blur', dismissMenu);
}

function openContextMenu(x: number, y: number, id: number, handlers: SheetTabHandlers): void {
	dismissMenu();
	const menu = document.createElement('div');
	menu.className = 'cell-grid-tab-menu';
	menu.setAttribute('role', 'menu');
	const items: Array<{ label: string; run: () => void }> = [
		{ label: 'Rename', run: () => handlers.rename(id) },
		{ label: 'Delete', run: () => handlers.remove(id) },
		{ label: 'Move Left', run: () => handlers.moveLeft(id) },
		{ label: 'Move Right', run: () => handlers.moveRight(id) },
	];
	for (const it of items) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'cell-grid-tab-menu-item';
		b.setAttribute('role', 'menuitem');
		b.textContent = it.label;
		b.addEventListener('click', (e) => {
			e.stopPropagation();
			dismissMenu();
			it.run();
		});
		menu.appendChild(b);
	}
	// Codex HIGH (2026-06-10): position AFTER appending. The menu must be in the document for
	// getBoundingClientRect to yield its real laid-out size (the CSS min-width + the item labels decide
	// it; hardcoding a guess would drift the moment the menu items change). Appended hidden so the
	// measure can never flash an unpositioned menu at the viewport origin, then placed via the pure
	// clamp ({@link placeTabContextMenu}) -- near the bottom edge (the strip's home) it flips UPWARD,
	// and it never overflows the right edge. Dismiss wiring is untouched: the capture-phase
	// pointerdown / Escape / blur handlers key off `menuEl`, set below exactly as before.
	menu.style.visibility = 'hidden';
	document.body.appendChild(menu);
	const rect = menu.getBoundingClientRect();
	const pos = placeTabContextMenu(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight);
	menu.style.left = String(pos.left) + 'px';
	menu.style.top = String(pos.top) + 'px';
	menu.style.visibility = '';
	menuEl = menu;
}

/**
 * Render the tab strip into `container` from the host's sheet list + active id, wiring each tab's
 * interactions to `handlers`. Idempotent -- clears + rebuilds the strip on every render (the host
 * sends the live sheet list on every `render`, so the strip always reflects the current workbook).
 */
export function renderSheetTabs(
	container: HTMLElement,
	sheets: ReadonlyArray<SheetTabInfo>,
	activeId: number,
	handlers: SheetTabHandlers,
): void {
	ensureDismissWiring();
	dismissMenu();
	const model = buildSheetStripModel(sheets, activeId);
	container.textContent = '';
	for (const tab of model) {
		const el = document.createElement('button');
		el.type = 'button';
		el.className = tab.active ? 'cell-grid-tab is-active' : 'cell-grid-tab';
		el.setAttribute('role', 'tab');
		el.setAttribute('aria-selected', tab.active ? 'true' : 'false');
		const label = tab.name !== '' ? tab.name : 'Sheet ' + String(tab.id);
		el.textContent = label;
		el.title = label;
		el.addEventListener('click', () => handlers.switchTo(tab.id));
		el.addEventListener('dblclick', (e) => {
			e.preventDefault();
			handlers.rename(tab.id);
		});
		el.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			openContextMenu(e.clientX, e.clientY, tab.id, handlers);
		});
		container.appendChild(el);
	}
	const addBtn = document.createElement('button');
	addBtn.type = 'button';
	addBtn.className = 'cell-grid-tab-add';
	addBtn.textContent = '+';
	addBtn.title = 'Add sheet';
	addBtn.setAttribute('aria-label', 'Add sheet');
	addBtn.addEventListener('click', () => handlers.add());
	container.appendChild(addBtn);
}
