/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
/**
 * QIC First-Run Experience Manager
 * Handles the onboarding wizard flow
 * Phase 2 - Prompt 02-10
 */

(function() {
	'use strict';

	// ═══════════════════════════════════════════════════════════════════
	// State
	// ═══════════════════════════════════════════════════════════════════

	let currentStep = 1;
	const totalSteps = 4;

	const selections = {
		provider: null,
		consent: {
			llm: false,
			embeddings: false,
			telemetry: false
		},
		privacyTier: 'anonymous-metrics'
	};

	// ═══════════════════════════════════════════════════════════════════
	// DOM Elements
	// ═══════════════════════════════════════════════════════════════════

	let wizard = null;
	let backBtn = null;
	let nextBtn = null;
	let skipBtn = null;

	// ═══════════════════════════════════════════════════════════════════
	// Public API
	// ═══════════════════════════════════════════════════════════════════

	function show() {
		wizard = document.getElementById('first-run-wizard');
		if (!wizard) {
			// Fall back to old first-run screen if wizard not present
			const oldFirstRun = document.getElementById('first-run');
			if (oldFirstRun) {
				oldFirstRun.style.display = '';
			}
			return;
		}

		wizard.hidden = false;
		currentStep = 1;
		updateUI();

		// Focus first provider option
		const firstOption = wizard.querySelector('.qic-provider-option');
		firstOption?.focus();
	}

	function hide() {
		if (wizard) {
			wizard.hidden = true;
		}

		// Also hide old first-run screen
		const oldFirstRun = document.getElementById('first-run');
		if (oldFirstRun) {
			oldFirstRun.style.display = 'none';
		}
	}

	function isVisible() {
		return wizard && !wizard.hidden;
	}

	// ═══════════════════════════════════════════════════════════════════
	// Navigation
	// ═══════════════════════════════════════════════════════════════════

	function nextStep() {
		if (!validateCurrentStep()) {
			return;
		}

		if (currentStep < totalSteps) {
			currentStep++;
			updateUI();
		} else {
			completeSetup();
		}
	}

	function prevStep() {
		if (currentStep > 1) {
			currentStep--;
			updateUI();
		}
	}

	function skipSetup() {
		// Use defaults
		selections.provider = 'qic-cloud';
		selections.consent.llm = true;
		completeSetup();
	}

	function validateCurrentStep() {
		switch (currentStep) {
			case 1: // Provider
				if (!selections.provider) {
					showError('Please select a provider');
					return false;
				}
				return true;

			case 2: // Consent
				if (!selections.consent.llm && selections.provider !== 'offline') {
					showError('LLM consent is required for AI features');
					return false;
				}
				return true;

			case 3: // Privacy
			case 4: // Ready
				return true;

			default:
				return true;
		}
	}

	function updateUI() {
		if (!wizard) return;

		// Update step visibility
		wizard.querySelectorAll('.qic-first-run-step').forEach(step => {
			const stepNum = parseInt(step.dataset.step, 10);
			step.hidden = stepNum !== currentStep;
		});

		// Update progress
		wizard.querySelectorAll('.qic-first-run-progress .step').forEach(step => {
			const stepNum = parseInt(step.dataset.step, 10);
			step.classList.toggle('active', stepNum === currentStep);
			step.classList.toggle('complete', stepNum < currentStep);
		});

		// Update navigation
		if (backBtn) backBtn.hidden = currentStep === 1;
		if (skipBtn) skipBtn.hidden = currentStep === totalSteps;

		if (nextBtn) {
			if (currentStep === totalSteps) {
				nextBtn.innerHTML = '<span>Get Started</span>';
			} else {
				nextBtn.innerHTML = '<span>Continue</span>';
			}
		}

		// Skip consent step for offline mode
		if (currentStep === 2 && selections.provider === 'offline') {
			nextStep();
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Completion
	// ═══════════════════════════════════════════════════════════════════

	function completeSetup() {
		// Send configuration to host
		vscode.postMessage({
			type: 'first-run:complete',
			payload: {
				provider: selections.provider,
				consent: selections.consent,
				privacyTier: selections.privacyTier
			}
		});

		hide();

		// Show main chat interface
		const chatContainer = document.getElementById('chat-container');
		if (chatContainer) {
			chatContainer.style.display = '';
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Event Handlers
	// ═══════════════════════════════════════════════════════════════════

	function setupEventListeners() {
		wizard = document.getElementById('first-run-wizard');
		if (!wizard) return;

		backBtn = document.getElementById('first-run-back');
		nextBtn = document.getElementById('first-run-next');
		skipBtn = document.getElementById('first-run-skip');

		// Navigation buttons
		nextBtn?.addEventListener('click', nextStep);
		backBtn?.addEventListener('click', prevStep);
		skipBtn?.addEventListener('click', skipSetup);

		// Provider selection
		wizard.querySelectorAll('.qic-provider-option').forEach(option => {
			option.addEventListener('click', () => {
				// Deselect all
				wizard.querySelectorAll('.qic-provider-option').forEach(o => {
					o.setAttribute('aria-checked', 'false');
				});
				// Select clicked
				option.setAttribute('aria-checked', 'true');
				selections.provider = option.dataset.provider;
			});
		});

		// Consent checkboxes
		document.getElementById('consent-llm-first-run')?.addEventListener('change', (e) => {
			selections.consent.llm = e.target.checked;
		});
		document.getElementById('consent-embeddings-first-run')?.addEventListener('change', (e) => {
			selections.consent.embeddings = e.target.checked;
		});
		document.getElementById('consent-telemetry-first-run')?.addEventListener('change', (e) => {
			selections.consent.telemetry = e.target.checked;
		});

		// Privacy tier selection
		wizard.querySelectorAll('.qic-privacy-option').forEach(option => {
			option.addEventListener('click', () => {
				wizard.querySelectorAll('.qic-privacy-option').forEach(o => {
					o.setAttribute('aria-checked', 'false');
					o.classList.remove('selected');
				});
				option.setAttribute('aria-checked', 'true');
				option.classList.add('selected');
				selections.privacyTier = option.dataset.tier;
			});
		});

		// Keyboard navigation
		wizard.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				skipSetup();
			} else if (e.key === 'Enter' && e.target.classList.contains('qic-provider-option')) {
				nextStep();
			}
		});

		// Also handle the old first-run get started button
		const getStartedBtn = document.getElementById('get-started-btn');
		getStartedBtn?.addEventListener('click', () => {
			// Get consent values from old checkboxes
			const llmConsent = document.getElementById('consent-llm');
			const embeddingsConsent = document.getElementById('consent-embeddings');
			const telemetryConsent = document.getElementById('consent-telemetry');

			selections.consent.llm = llmConsent?.checked ?? false;
			selections.consent.embeddings = embeddingsConsent?.checked ?? false;
			selections.consent.telemetry = telemetryConsent?.checked ?? false;
			selections.provider = 'qic-cloud'; // Default

			completeSetup();
		});

		// Enable get started button when LLM consent is checked
		const llmConsentOld = document.getElementById('consent-llm');
		llmConsentOld?.addEventListener('change', (e) => {
			const getStartedBtn = document.getElementById('get-started-btn');
			if (getStartedBtn) {
				getStartedBtn.disabled = !e.target.checked;
			}
		});
	}

	function showError(message) {
		// Use existing notification system
		vscode.postMessage({
			type: 'notification',
			payload: { severity: 'warning', message }
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	function handleMessage(message) {
		switch (message.type) {
			case 'show-first-run':
				show();
				break;
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// Initialize
	// ═══════════════════════════════════════════════════════════════════

	function init() {
		setupEventListeners();
	}

	// Export
	window.QicFirstRun = {
		show,
		hide,
		isVisible,
		handleMessage,
		init
	};

	// Auto-init when DOM ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
