/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC Strategy Warning
 * Phase 5 - Prompt 05-07
 *
 * Analyzes proposed changes and displays warnings for potentially risky operations.
 * Helps users understand the impact of changes before approving them.
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// Risk Patterns
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Patterns that indicate potentially risky files/operations.
	 */
	const RISK_PATTERNS = {
		// High-risk configuration files
		configFiles: [
			/^\.env/i,
			/^\.gitignore$/i,
			/^package\.json$/i,
			/^package-lock\.json$/i,
			/^yarn\.lock$/i,
			/^tsconfig\.json$/i,
			/^webpack\.config\./i,
			/^vite\.config\./i,
			/^docker-compose\./i,
			/^Dockerfile$/i,
			/^\.github\//i,
			/^\.gitlab-ci\.yml$/i,
			/^Makefile$/i,
			/^CMakeLists\.txt$/i,
		],

		// Sensitive directories
		sensitiveDirectories: [
			/^\.git\//i,
			/^node_modules\//i,
			/^\.vscode\//i,
			/^\.idea\//i,
			/^dist\//i,
			/^build\//i,
			/^__pycache__\//i,
		],

		// Files that may contain secrets
		secretFiles: [
			/\.env$/i,
			/\.env\./i,
			/secrets?\./i,
			/credentials?\./i,
			/\.pem$/i,
			/\.key$/i,
			/\.crt$/i,
			/\.p12$/i,
			/id_rsa/i,
			/id_ed25519/i,
		],

		// Critical system files
		criticalFiles: [
			/^index\.(ts|js|tsx|jsx)$/i,
			/^main\.(ts|js|tsx|jsx)$/i,
			/^app\.(ts|js|tsx|jsx)$/i,
			/^server\.(ts|js|tsx|jsx)$/i,
		],
	};

	/**
	 * Warning severity levels.
	 */
	const SEVERITY = {
		INFO: 'info',
		WARNING: 'warning',
		CRITICAL: 'critical',
	};

	// ═══════════════════════════════════════════════════════════════════
	// Analysis Functions
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Analyze a change set and generate warnings.
	 * @param {object} changeSet - The change set to analyze
	 * @returns {Array<object>} - Array of warnings
	 */
	function analyzeChangeSet(changeSet) {
		if (!changeSet?.changes || !Array.isArray(changeSet.changes)) {
			return [];
		}

		const warnings = [];

		// Analyze each change
		changeSet.changes.forEach(change => {
			const changeWarnings = analyzeChange(change);
			warnings.push(...changeWarnings);
		});

		// Add aggregate warnings
		const aggregateWarnings = analyzeAggregate(changeSet.changes);
		warnings.push(...aggregateWarnings);

		return warnings;
	}

	/**
	 * Analyze a single change for risks.
	 * @param {object} change - The change to analyze
	 * @returns {Array<object>} - Array of warnings
	 */
	function analyzeChange(change) {
		const warnings = [];
		const path = change.path || '';
		const filename = path.split('/').pop() || path;

		// Check for deletion of important files
		if (change.type === 'delete') {
			warnings.push({
				changeId: change.id,
				severity: SEVERITY.WARNING,
				title: 'File Deletion',
				message: `This will permanently delete: ${path}`,
				suggestion: 'Consider using version control to preserve history',
			});

			// Extra warning for config files
			if (isConfigFile(path)) {
				warnings.push({
					changeId: change.id,
					severity: SEVERITY.CRITICAL,
					title: 'Configuration File Deletion',
					message: `Deleting configuration file: ${filename}`,
					suggestion: 'Make sure this file is not required by your build or deployment',
				});
			}
		}

		// Check for modifications to config files
		if (change.type === 'modify' && isConfigFile(path)) {
			warnings.push({
				changeId: change.id,
				severity: SEVERITY.WARNING,
				title: 'Configuration Change',
				message: `Modifying configuration file: ${filename}`,
				suggestion: 'Review changes carefully - this may affect builds or deployments',
			});
		}

		// Check for sensitive file operations
		if (isSensitiveFile(path)) {
			warnings.push({
				changeId: change.id,
				severity: SEVERITY.CRITICAL,
				title: 'Sensitive File',
				message: `Operation on potentially sensitive file: ${filename}`,
				suggestion: 'Ensure no secrets or credentials are exposed',
			});
		}

		// Check for operations in sensitive directories
		if (isInSensitiveDirectory(path)) {
			warnings.push({
				changeId: change.id,
				severity: SEVERITY.WARNING,
				title: 'Sensitive Directory',
				message: `Operating in sensitive directory: ${path.split('/')[0]}`,
				suggestion: 'These directories often contain generated or system files',
			});
		}

		// Check for large deletions
		if (change.type === 'modify' && change.deletions > 50) {
			warnings.push({
				changeId: change.id,
				severity: SEVERITY.INFO,
				title: 'Large Deletion',
				message: `Removing ${change.deletions} lines from ${filename}`,
				suggestion: 'Consider reviewing the diff to ensure important code is not removed',
			});
		}

		// Check for entry point modifications
		if (isCriticalFile(path)) {
			warnings.push({
				changeId: change.id,
				severity: SEVERITY.WARNING,
				title: 'Entry Point Change',
				message: `Modifying application entry point: ${filename}`,
				suggestion: 'Changes here affect the entire application',
			});
		}

		return warnings;
	}

	/**
	 * Analyze aggregate risks across all changes.
	 * @param {Array<object>} changes - Array of changes
	 * @returns {Array<object>} - Array of warnings
	 */
	function analyzeAggregate(changes) {
		const warnings = [];

		// Count deletions
		const deletions = changes.filter(c => c.type === 'delete');
		if (deletions.length > 3) {
			warnings.push({
				changeId: null,
				severity: SEVERITY.WARNING,
				title: 'Multiple Deletions',
				message: `${deletions.length} files will be deleted`,
				suggestion: 'Review each deletion carefully',
			});
		}

		// Check total lines changed
		const totalDeletions = changes.reduce((sum, c) => sum + (c.deletions || 0), 0);
		const totalAdditions = changes.reduce((sum, c) => sum + (c.additions || 0), 0);

		if (totalDeletions > 200) {
			warnings.push({
				changeId: null,
				severity: SEVERITY.INFO,
				title: 'Large Refactoring',
				message: `Total: +${totalAdditions} -${totalDeletions} lines across ${changes.length} files`,
				suggestion: 'Consider applying changes incrementally',
			});
		}

		// Check for cross-cutting changes
		const directories = new Set(changes.map(c => (c.path || '').split('/')[0]));
		if (directories.size > 5 && changes.length > 10) {
			warnings.push({
				changeId: null,
				severity: SEVERITY.INFO,
				title: 'Widespread Changes',
				message: `Changes span ${directories.size} directories`,
				suggestion: 'Large refactorings may benefit from review mode',
			});
		}

		return warnings;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Pattern Matching Helpers
	// ═══════════════════════════════════════════════════════════════════

	function isConfigFile(path) {
		return RISK_PATTERNS.configFiles.some(pattern => pattern.test(path));
	}

	function isSensitiveFile(path) {
		return RISK_PATTERNS.secretFiles.some(pattern => pattern.test(path));
	}

	function isInSensitiveDirectory(path) {
		return RISK_PATTERNS.sensitiveDirectories.some(pattern => pattern.test(path));
	}

	function isCriticalFile(path) {
		const filename = path.split('/').pop() || '';
		return RISK_PATTERNS.criticalFiles.some(pattern => pattern.test(filename));
	}

	// ═══════════════════════════════════════════════════════════════════
	// UI Rendering
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Render warnings in the UI.
	 * @param {Array<object>} warnings - Warnings to display
	 * @param {HTMLElement} container - Container element
	 */
	function renderWarnings(warnings, container) {
		if (!container || warnings.length === 0) return;

		// Group by severity
		const critical = warnings.filter(w => w.severity === SEVERITY.CRITICAL);
		const warning = warnings.filter(w => w.severity === SEVERITY.WARNING);
		const info = warnings.filter(w => w.severity === SEVERITY.INFO);

		// Clear existing
		container.innerHTML = '';

		// Render critical first
		if (critical.length > 0) {
			const section = createWarningSection('Critical', 'codicon-warning', critical);
			section.classList.add('warning-section-critical');
			container.appendChild(section);
		}

		// Then warnings
		if (warning.length > 0) {
			const section = createWarningSection('Warnings', 'codicon-info', warning);
			section.classList.add('warning-section-warning');
			container.appendChild(section);
		}

		// Then info (collapsed by default)
		if (info.length > 0) {
			const section = createWarningSection('Info', 'codicon-lightbulb', info, true);
			section.classList.add('warning-section-info');
			container.appendChild(section);
		}
	}

	/**
	 * Create a warning section element.
	 * @param {string} title - Section title
	 * @param {string} icon - Codicon class
	 * @param {Array<object>} warnings - Warnings in this section
	 * @param {boolean} collapsed - Whether to collapse by default
	 * @returns {HTMLElement}
	 */
	function createWarningSection(title, icon, warnings, collapsed = false) {
		const section = document.createElement('div');
		section.className = 'strategy-warning-section';

		const header = document.createElement('div');
		header.className = 'strategy-warning-header';
		header.innerHTML = `
			<span class="codicon ${icon}"></span>
			<span class="warning-title">${title} (${warnings.length})</span>
			<span class="codicon codicon-chevron-${collapsed ? 'right' : 'down'} toggle-icon"></span>
		`;

		const content = document.createElement('div');
		content.className = 'strategy-warning-content';
		if (collapsed) content.classList.add('collapsed');

		warnings.forEach(warning => {
			const item = createWarningItem(warning);
			content.appendChild(item);
		});

		header.addEventListener('click', () => {
			content.classList.toggle('collapsed');
			const toggleIcon = header.querySelector('.toggle-icon');
			if (toggleIcon) {
				toggleIcon.classList.toggle('codicon-chevron-right');
				toggleIcon.classList.toggle('codicon-chevron-down');
			}
		});

		section.appendChild(header);
		section.appendChild(content);

		return section;
	}

	/**
	 * Create a single warning item element.
	 * @param {object} warning - Warning data
	 * @returns {HTMLElement}
	 */
	function createWarningItem(warning) {
		const item = document.createElement('div');
		item.className = `strategy-warning-item severity-${warning.severity}`;
		if (warning.changeId) {
			item.dataset.changeId = warning.changeId;
		}

		item.innerHTML = `
			<div class="warning-item-title">${escapeHtml(warning.title)}</div>
			<div class="warning-item-message">${escapeHtml(warning.message)}</div>
			${warning.suggestion ? `<div class="warning-item-suggestion">${escapeHtml(warning.suggestion)}</div>` : ''}
		`;

		// Highlight related change on hover
		if (warning.changeId) {
			item.addEventListener('mouseenter', () => {
				const card = document.querySelector(`[data-change-id="${warning.changeId}"]`);
				if (card) card.classList.add('warning-highlight');
			});
			item.addEventListener('mouseleave', () => {
				const card = document.querySelector(`[data-change-id="${warning.changeId}"]`);
				if (card) card.classList.remove('warning-highlight');
			});
		}

		return item;
	}

	// Use shared escapeHtml from qicUtils
	const escapeHtml = window.qicUtils.escapeHtml;

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	/**
	 * Handle incoming messages.
	 * @param {object} msg - Message from host
	 * @returns {boolean} - true if handled
	 */
	function handleMessage(msg) {
		switch (msg.type) {
			case 'changes:pending':
			case 'diff-preview':
				if (msg.payload) {
					const warnings = analyzeChangeSet(msg.payload);
					if (warnings.length > 0) {
						const container = document.getElementById('strategy-warnings');
						if (container) {
							renderWarnings(warnings, container);
							container.style.display = 'block';
						}
					}
				}
				return true;

			case 'changes:resolved':
				// Hide warnings when all changes resolved
				const container = document.getElementById('strategy-warnings');
				if (container) {
					container.style.display = 'none';
					container.innerHTML = '';
				}
				return true;

			default:
				return false;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Export
	// ═══════════════════════════════════════════════════════════════════

	window.QicStrategyWarning = {
		analyzeChangeSet,
		analyzeChange,
		renderWarnings,
		handleMessage,

		// Constants for external use
		SEVERITY,
		RISK_PATTERNS,
	};

})();
