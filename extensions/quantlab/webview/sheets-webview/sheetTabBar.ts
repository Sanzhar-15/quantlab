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
 * so the pure model builders ({@link buildSheetStripModel} / {@link moveIndex}) are unit-tested.
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

export interface SheetTabHandlers {
	switchTo(id: number): void;
	add(): void;
	rename(id: number): void;
	remove(id: number): void;
	moveLeft(id: number): void;
	moveRight(id: number): void;
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
	menu.style.left = String(x) + 'px';
	menu.style.top = String(y) + 'px';
	document.body.appendChild(menu);
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
