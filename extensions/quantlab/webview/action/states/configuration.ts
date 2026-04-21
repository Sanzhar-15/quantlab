/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ActionConfigurationState, ConfigField, ConfigSchema, ConfigSection, ResourceMeta } from '../../../src/types/action';
import { escapeHtml, formatActionLabel } from '../utils';

interface ConfigurationContext {
	postMessage: (message: unknown) => void;
}

export function renderConfigurationState(container: HTMLElement, state: ActionConfigurationState, context: ConfigurationContext): void {
	const actionLabel = state.schema.label || formatActionLabel(String(state.action));
	const isResource = Boolean(state.resourceId);
	const meta = state.resourceMeta;

	// Determine the submit button label
	let submitLabel = `Run ${escapeHtml(actionLabel)}`;
	if (state.resourceId === 'offline-stationarity' || state.resourceId === 'offline-normality') {
		submitLabel = 'Run Test';
	} else if (state.resourceId === 'offline-backtest') {
		submitLabel = 'Run Backtest';
	} else if (state.resourceId === 'offline-montecarlo') {
		submitLabel = 'Run Simulation';
	}

	container.innerHTML = `
		<div class="action-page configuration-state">
			<header class="page-header">
				<div>
					<h1>${escapeHtml(actionLabel)}</h1>
					<p class="page-subtitle">${isResource && meta ? escapeHtml(meta.description) : 'Configure the run before execution.'}</p>
				</div>
				<button class="btn btn-ghost" id="action-back">Back</button>
			</header>
			<div class="divider"></div>
			${meta ? renderResourceDescription(state.resourceId!, meta) : ''}
			<form class="config-form" id="action-config-form">
				${state.schema.sections.map(section => renderSection(section, state)).join('')}
				<div class="form-actions">
					<button class="btn btn-primary" type="submit" ${state.validation.isValid ? '' : 'disabled'}>${submitLabel}</button>
				</div>
			</form>
		</div>
	`;

	const backButton = container.querySelector<HTMLButtonElement>('#action-back');
	if (backButton) {
		backButton.addEventListener('click', () => {
			context.postMessage({ type: 'back' });
		});
	}

	const form = container.querySelector<HTMLFormElement>('#action-config-form');
	if (!form) {
		return;
	}

	form.addEventListener('submit', event => {
		event.preventDefault();
		const values = collectFormData(state.schema);
		context.postMessage({ type: 'runAction', actionType: state.action, config: { action: state.action, values } });
	});

	form.addEventListener('change', () => {
		const values = collectFormData(state.schema);
		context.postMessage({ type: 'updateConfig', values });
	});

	// Attach file picker button handlers
	const fileButtons = form.querySelectorAll<HTMLButtonElement>('[data-file-picker]');
	for (const btn of fileButtons) {
		btn.addEventListener('click', () => {
			const fieldId = btn.getAttribute('data-file-picker');
			context.postMessage({ type: 'requestFilePicker', fieldId });
		});
	}
}

export function handleSetFieldValue(container: HTMLElement, fieldId: string, value: string, displayName: string): void {
	// Use getElementById for safer ID lookup (no CSS escaping needed)
	const hiddenInput = container.querySelector<HTMLInputElement>(`#${CSS.escape(fieldId)}`);
	if (hiddenInput) {
		hiddenInput.value = value;
		// Trigger a change event so the form re-validates
		hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
	}

	const displayButton = container.querySelector<HTMLButtonElement>(`[data-file-picker="${CSS.escape(fieldId)}"]`);
	if (displayButton) {
		displayButton.textContent = displayName || 'Select File...';
		displayButton.title = value;
	}
}

function renderSection(section: ConfigSection, state: ActionConfigurationState): string {
	return `
		<section class="config-section">
			<div class="section-header">
				<h2>${escapeHtml(section.label)}</h2>
			</div>
			<div class="section-fields">
				${section.fields.map(field => renderField(field, state)).join('')}
			</div>
		</section>
	`;
}

function renderField(field: ConfigField, state: ActionConfigurationState): string {
	const value = state.values[field.id];
	const safeValue = value === undefined || value === null ? '' : String(value);
	const escapedValue = escapeHtml(safeValue);
	const error = state.validation.errors[field.id];
	const hasError = Boolean(error);

	let input = '';
	const commonAttrs = field.required ? 'required' : '';

	switch (field.type) {
		case 'number':
			input = `<input type="number" id="${escapeHtml(field.id)}" name="${escapeHtml(field.id)}" value="${escapedValue}" ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.max !== undefined ? `max="${field.max}"` : ''} ${field.step !== undefined ? `step="${field.step}"` : ''} ${commonAttrs} />`;
			break;
		case 'select':
			input = `<select id="${escapeHtml(field.id)}" name="${escapeHtml(field.id)}" ${commonAttrs}>
				${(field.options ?? []).map(option => {
					const selected = option.value === value ? 'selected' : '';
					return `<option value="${escapeHtml(option.value)}" ${selected}>${escapeHtml(option.label)}</option>`;
				}).join('')}
			</select>`;
			break;
		case 'checkbox':
			input = `<input type="checkbox" id="${escapeHtml(field.id)}" name="${escapeHtml(field.id)}" ${value ? 'checked' : ''} />`;
			break;
		case 'date':
			input = `<input type="date" id="${escapeHtml(field.id)}" name="${escapeHtml(field.id)}" value="${escapedValue}" ${commonAttrs} />`;
			break;
		case 'file': {
			const fileName = safeValue ? safeValue.split(/[/\\]/).pop() ?? 'Select File...' : 'Select File...';
			input = `<input type="hidden" id="${escapeHtml(field.id)}" name="${escapeHtml(field.id)}" value="${escapedValue}" />
				<button type="button" class="btn btn-file" data-file-picker="${escapeHtml(field.id)}" title="${escapedValue}">${escapeHtml(fileName)}</button>`;
			break;
		}
		case 'text':
		default:
			input = `<input type="text" id="${escapeHtml(field.id)}" name="${escapeHtml(field.id)}" value="${escapedValue}" ${commonAttrs} />`;
			break;
	}

	return `
		<div class="form-field ${hasError ? 'has-error' : ''}">
			<label for="${escapeHtml(field.id)}">
				${escapeHtml(field.label)}${field.required ? '<span class="required">*</span>' : ''}
			</label>
			<div class="field-input">
				${input}
				${field.description ? `<div class="field-help">${escapeHtml(field.description)}</div>` : ''}
				${hasError ? `<div class="field-error">${escapeHtml(error ?? '')}</div>` : ''}
			</div>
		</div>
	`;
}

function renderResourceDescription(resourceId: string, meta: ResourceMeta): string {
	const explanations = meta.testExplanations;
	if (!explanations) {
		return '';
	}

	const items = Object.entries(explanations).map(([key, desc]) =>
		`<li><strong>${escapeHtml(key.toUpperCase())}</strong>: ${escapeHtml(desc)}</li>`
	).join('');

	return `
		<div class="resource-header">
			<p>${escapeHtml(meta.description)}</p>
			${items ? `<ul style="margin: 8px 0 0; padding-left: 18px; font-size: 11px; color: var(--vscode-descriptionForeground);">${items}</ul>` : ''}
		</div>
	`;
}

export function updateColumnOptions(container: HTMLElement, options: Array<{ label: string; value: string }>): void {
	const select = container.querySelector<HTMLSelectElement>('#column');
	if (!select) {
		return;
	}
	select.innerHTML = options.map(o =>
		`<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`
	).join('');
	select.dispatchEvent(new Event('change', { bubbles: true }));
}

function collectFormData(schema: ConfigSchema): Record<string, unknown> {
	const values: Record<string, unknown> = {};

	for (const section of schema.sections) {
		for (const field of section.fields) {
			const element = document.getElementById(field.id) as HTMLInputElement | HTMLSelectElement | null;
			if (!element) {
				continue;
			}

			if (field.type === 'checkbox') {
				values[field.id] = (element as HTMLInputElement).checked;
				continue;
			}

			if (field.type === 'number') {
				const raw = (element as HTMLInputElement).value;
				if (raw === '') {
					values[field.id] = '';
				} else {
					const numeric = Number(raw);
					values[field.id] = Number.isNaN(numeric) ? raw : numeric;
				}
				continue;
			}

			values[field.id] = (element as HTMLInputElement | HTMLSelectElement).value;
		}
	}

	return values;
}
