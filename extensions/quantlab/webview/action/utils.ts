/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function formatRunType(value: string): string {
	if (!value) {
		return '';
	}
	return value.charAt(0).toUpperCase() + value.slice(1);
}

export function formatActionLabel(value: string): string {
	switch (value) {
		case 'monteCarlo':
			return 'Monte Carlo';
		case 'wfa':
			return 'WFA';
		default:
			return formatRunType(value);
	}
}

export function formatDuration(ms?: number): string {
	if (ms === undefined || Number.isNaN(ms)) {
		return '';
	}
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);

	if (hours > 0) {
		return `${hours}h ${minutes}m ${seconds}s`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

export function formatRelativeTime(value?: string | number | Date): string {
	const date = coerceDate(value);
	if (!date) {
		return '';
	}

	const now = Date.now();
	const diffMs = Math.max(0, now - date.getTime());
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) {
		return 'Just now';
	}
	if (diffMins < 60) {
		return `${diffMins} min ago`;
	}
	if (diffHours < 24) {
		return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`;
	}
	if (diffDays === 1) {
		return 'Yesterday';
	}
	return `${diffDays} days ago`;
}

export function coerceDate(value?: string | number | Date): Date | undefined {
	if (!value) {
		return undefined;
	}
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? undefined : value;
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

export function pickMetric(metrics?: Record<string, number>): { label: string; value: number } | undefined {
	if (!metrics) {
		return undefined;
	}
	const preferred = ['Sharpe', 'sharpe', 'Return', 'return'];
	for (const key of preferred) {
		if (metrics[key] !== undefined) {
			return { label: key, value: metrics[key] };
		}
	}
	const entry = Object.entries(metrics)[0];
	if (!entry) {
		return undefined;
	}
	return { label: entry[0], value: entry[1] };
}
