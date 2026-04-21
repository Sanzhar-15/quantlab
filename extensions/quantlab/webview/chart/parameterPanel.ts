/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ParameterDefinition {
	id: string;
	default: unknown;
	min?: number;
	max?: number;
	step?: number;
	choices?: unknown[];
	name?: string;
	group?: string;
	description?: string;
	format?: 'percent' | 'currency' | 'number';
}

export class ParameterPanel {
	private parameters: ParameterDefinition[] = [];
	private overrides: Record<string, unknown> = {};
	private resetButton?: HTMLButtonElement;
	private applyButton?: HTMLButtonElement;
	private pendingChanges = new Map<string, number>();

	constructor(
		private readonly container: HTMLElement,
		private readonly onChange: (id: string, value: unknown) => void,
		private readonly onReset: () => void,
		private readonly onApply: () => void
	) { }

	render(parameters: ParameterDefinition[], overrides: Record<string, unknown>): void {
		this.clearPendingChanges();
		const scrollTop = this.container.scrollTop;
		const openGroups = new Map<string, boolean>();
		for (const details of Array.from(this.container.querySelectorAll<HTMLDetailsElement>('details.param-group'))) {
			const key = details.dataset.group ?? details.querySelector('summary')?.textContent ?? '';
			if (key) {
				openGroups.set(key, details.open);
			}
		}
		this.parameters = parameters;
		this.overrides = overrides;
		this.container.innerHTML = '';

		const groups = new Map<string, ParameterDefinition[]>();
		for (const param of parameters) {
			const group = (param.group ?? '').trim() || 'General';
			const list = groups.get(group);
			if (list) {
				list.push(param);
			} else {
				groups.set(group, [param]);
			}
		}

		for (const [groupName, groupParams] of groups) {
			const details = document.createElement('details');
			details.className = 'param-group';
			details.dataset.group = groupName;
			details.open = openGroups.get(groupName) ?? true;

			const summary = document.createElement('summary');
			summary.textContent = groupName;

			const list = document.createElement('div');
			list.className = 'param-group-list';
			for (const param of groupParams) {
				list.appendChild(this.renderParam(param));
			}

			details.append(summary, list);
			this.container.appendChild(details);
		}

		this.updateActionState();
		const restoreScroll = () => {
			this.container.scrollTop = Math.min(scrollTop, this.container.scrollHeight);
		};
		if (typeof requestAnimationFrame === 'function') {
			requestAnimationFrame(restoreScroll);
		} else {
			restoreScroll();
		}
	}

	setOverrides(overrides: Record<string, unknown>): void {
		this.overrides = overrides;
		this.render(this.parameters, overrides);
	}

	private renderParam(param: ParameterDefinition): HTMLElement {
		const row = document.createElement('div');
		row.className = 'param-row';
		row.dataset.paramId = param.id;

		const label = document.createElement('label');
		label.textContent = param.name ?? param.id;
		if (param.description) {
			label.title = param.description;
		}
		row.appendChild(label);

		const value = this.getParamValue(param);

		const valueDisplay = document.createElement('div');
		valueDisplay.className = 'value';
		valueDisplay.textContent = this.formatValue(value, param);

		const updateRow = (nextValue: unknown, immediate = true) => {
			valueDisplay.textContent = this.formatValue(nextValue, param);
			row.classList.toggle('param-row--dirty', !this.isDefaultValue(param, nextValue));
			this.updateOverrideState(param, nextValue);
			this.scheduleChange(param.id, nextValue, immediate);
		};

		const control = this.buildControl(param, value, updateRow);
		row.append(control, valueDisplay);

		row.classList.toggle('param-row--dirty', !this.isDefaultValue(param, value));
		return row;
	}

	private getParamValue(param: ParameterDefinition): unknown {
		const override = this.overrides[param.id];
		return override === undefined ? param.default : override;
	}

	private buildControl(
		param: ParameterDefinition,
		value: unknown,
		onValueChange: (nextValue: unknown, immediate?: boolean) => void
	): HTMLElement {
		if (Array.isArray(param.choices)) {
			const select = document.createElement('select');
			for (const choice of param.choices) {
				const option = document.createElement('option');
				option.value = String(choice);
				option.textContent = String(choice);
				if (choice === value) {
					option.selected = true;
				}
				select.appendChild(option);
			}
			select.addEventListener('change', () => onValueChange(select.value, true));
			return select;
		}

		if (typeof param.default === 'boolean') {
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = Boolean(value);
			checkbox.addEventListener('change', () => onValueChange(checkbox.checked, true));
			return checkbox;
		}

		if (typeof param.default === 'number' && param.min !== undefined && param.max !== undefined) {
			const wrapper = document.createElement('div');
			wrapper.className = 'param-range';

			const range = document.createElement('input');
			range.type = 'range';
			range.min = String(param.min);
			range.max = String(param.max);
			range.step = String(param.step ?? 1);
			range.value = String(value ?? param.default);

			const numeric = document.createElement('input');
			numeric.type = 'number';
			numeric.min = String(param.min);
			numeric.max = String(param.max);
			numeric.step = String(param.step ?? 1);
			numeric.value = String(value ?? param.default);

			range.addEventListener('input', () => {
				numeric.value = range.value;
				onValueChange(Number(range.value), false);
			});

			numeric.addEventListener('change', () => {
				range.value = numeric.value;
				onValueChange(Number(numeric.value), true);
			});

			wrapper.appendChild(range);
			wrapper.appendChild(numeric);
			return wrapper;
		}

		const input = document.createElement('input');
		input.type = 'text';
		input.value = value === undefined || value === null ? '' : String(value);
		input.addEventListener('change', () => onValueChange(input.value, true));
		return input;
	}

	private updateOverrideState(param: ParameterDefinition, value: unknown): void {
		if (this.isDefaultValue(param, value)) {
			if (Object.prototype.hasOwnProperty.call(this.overrides, param.id)) {
				const { [param.id]: _, ...rest } = this.overrides;
				this.overrides = rest;
			}
		} else {
			this.overrides = { ...this.overrides, [param.id]: value };
		}
		this.updateActionState();
	}

	private updateActionState(): void {
		const isDirty = this.parameters.some(param => !this.isDefaultValue(param, this.getParamValue(param)));
		if (this.applyButton) {
			this.applyButton.disabled = !isDirty;
			this.applyButton.title = isDirty ? '' : 'No pending parameter changes';
		}
		if (this.resetButton) {
			this.resetButton.disabled = !isDirty;
		}
	}

	private scheduleChange(id: string, value: unknown, immediate: boolean): void {
		const existing = this.pendingChanges.get(id);
		if (existing !== undefined) {
			window.clearTimeout(existing);
			this.pendingChanges.delete(id);
		}

		if (immediate) {
			this.onChange(id, value);
			return;
		}

		const handle = window.setTimeout(() => {
			this.pendingChanges.delete(id);
			this.onChange(id, value);
		}, 180);
		this.pendingChanges.set(id, handle);
	}

	private clearPendingChanges(): void {
		for (const handle of this.pendingChanges.values()) {
			window.clearTimeout(handle);
		}
		this.pendingChanges.clear();
	}

	private isDefaultValue(param: ParameterDefinition, value: unknown): boolean {
		const normalized = this.normalizeValue(param, value);
		const normalizedDefault = this.normalizeValue(param, param.default);
		return normalized === normalizedDefault;
	}

	private normalizeValue(param: ParameterDefinition, value: unknown): unknown {
		if (value === undefined || value === null || value === '') {
			return param.default;
		}

		if (typeof param.default === 'number') {
			const numeric = Number(value);
			return Number.isFinite(numeric) ? numeric : param.default;
		}

		if (typeof param.default === 'boolean') {
			if (value === 'true') {
				return true;
			}
			if (value === 'false') {
				return false;
			}
			return Boolean(value);
		}

		return value;
	}

	private formatValue(value: unknown, param: ParameterDefinition): string {
		if (value === null || value === undefined || value === '') {
			return '-';
		}

		if (typeof value === 'number') {
			if (param.format === 'percent') {
				return `${value}%`;
			}
			if (param.format === 'currency') {
				return `$${value}`;
			}
			return String(value);
		}

		if (typeof value === 'boolean') {
			return value ? 'On' : 'Off';
		}

		return String(value);
	}

	attachActions(resetButton: HTMLButtonElement, applyButton: HTMLButtonElement): void {
		this.resetButton = resetButton;
		this.applyButton = applyButton;
		resetButton.addEventListener('click', () => {
			this.clearPendingChanges();
			this.onReset();
		});
		applyButton.addEventListener('click', () => this.onApply());
		this.updateActionState();
	}
}
