/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
// Secure markdown renderer (Audit XI-SV5).
// Strict HTML tag allowlist, href validation. NO external dependencies.

const ALLOWED_TAGS = new Set([
	'p', 'br', 'strong', 'em', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'ul', 'ol', 'li', 'blockquote', 'a', 'span', 'div',
	'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

const ALLOWED_HREF_PREFIXES = ['https://', 'http://', '#'];
const BLOCKED_HREF_PREFIXES = ['javascript:', 'data:', 'vbscript:', 'blob:', 'file:'];

/**
 * Render markdown to sanitized HTML.
 * @param {string} text
 * @returns {string}
 */
function renderMarkdown(text) {
	if (!text) { return ''; }

	let html = escapeHtml(text);

	// Code blocks (must be before inline code)
	html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_match, lang, code) {
		const langAttr = lang ? ' data-lang="' + escapeAttr(lang) + '"' : '';
		return '<pre' + langAttr + '><code>' + code + '</code></pre>';
	});

	// Inline code
	html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

	// Headers
	html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
	html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
	html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
	html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
	html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
	html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

	// Bold and italic
	html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
	html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
	html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

	// Links
	html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_match, text, href) {
		if (isValidHref(href)) {
			return '<a href="' + escapeAttr(href) + '" rel="noopener noreferrer">' + text + '</a>';
		}
		return text;
	});

	// Blockquotes
	html = html.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>');

	// Unordered lists
	html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
	html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

	// Ordered lists
	html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

	// Paragraphs (double newlines)
	html = html.replace(/\n\n/g, '</p><p>');
	html = '<p>' + html + '</p>';

	// Single newlines to <br>
	html = html.replace(/\n/g, '<br>');

	// Clean up empty paragraphs
	html = html.replace(/<p>\s*<\/p>/g, '');

	return html;
}

/**
 * Validate href attribute (XI-SV5).
 * @param {string} href
 * @returns {boolean}
 */
function isValidHref(href) {
	const lower = href.toLowerCase().trim();
	for (const blocked of BLOCKED_HREF_PREFIXES) {
		if (lower.startsWith(blocked)) { return false; }
	}
	for (const allowed of ALLOWED_HREF_PREFIXES) {
		if (lower.startsWith(allowed)) { return true; }
	}
	return false;
}

/**
 * Sanitize HTML, removing any tags not in the allowlist (XI-SV5).
 * @param {string} html
 * @returns {string}
 */
function sanitizeHtml(html) {
	return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, function (match, tag) {
		if (ALLOWED_TAGS.has(tag.toLowerCase())) {
			// Strip event handler attributes (on*) to prevent XSS
			return match.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '');
		}
		return '';
	});
}

function escapeHtml(text) {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function escapeAttr(text) {
	return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Common file extensions to auto-detect (without requiring [[brackets]]).
 */
const FILE_EXTENSIONS = new Set([
	'py', 'pyc', 'pyo', 'pyw', 'pyx', 'pxd',  // Python
	'csv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',  // Data/config
	'txt', 'md', 'rst', 'log',  // Text
	'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs',  // JavaScript/TypeScript
	'html', 'htm', 'css', 'scss', 'sass', 'less',  // Web
	'sql', 'db', 'sqlite',  // Database
	'sh', 'bash', 'zsh', 'bat', 'ps1', 'cmd',  // Shell
	'r', 'rmd', 'ipynb',  // Data science
	'parquet', 'feather', 'pkl', 'pickle', 'h5', 'hdf5', 'npy', 'npz', 'mat',  // Binary data
	'xls', 'xlsx', 'ods',  // Spreadsheets
	'pdf', 'doc', 'docx',  // Documents
	'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'bmp',  // Images
	'c', 'cpp', 'h', 'hpp', 'cc', 'cxx',  // C/C++
	'java', 'kt', 'scala', 'go', 'rs', 'rb', 'php',  // Other languages
	'vue', 'svelte', 'astro',  // Frameworks
	'env', 'gitignore', 'dockerignore',  // Dotfiles (without dot)
]);

/**
 * Check if a string looks like a valid file/folder name (not a URL or random text).
 */
function isValidFileName(name) {
	// Reject if it looks like a URL
	if (/^https?:\/\//i.test(name)) { return false; }
	// Reject if too long (likely not a filename)
	if (name.length > 100) { return false; }
	// Reject if contains URL-like patterns
	if (/\.(com|org|net|io|dev|app)\//i.test(name)) { return false; }
	return true;
}

/**
 * Create a file reference span element.
 */
function createFileRefSpan(path, displayName, isFolder) {
	const className = isFolder ? 'qic-file-ref qic-folder-ref' : 'qic-file-ref';
	return '<span class="' + className + '" data-path="' + escapeAttr(path) + '" title="' + escapeAttr(path) + '">' + escapeHtml(displayName) + '</span>';
}

/**
 * Process file references into styled spans.
 * 1. First processes explicit [[path]] syntax
 * 2. Then auto-detects common file patterns (fallback for LLM inconsistency)
 * Skips content inside <pre> and <code> tags.
 * @param {string} html - HTML after markdown rendering
 * @returns {string}
 */
function processFileReferences(html) {
	if (!html) { return html; }

	// Temporarily extract code blocks, inline code, and existing spans to protect them
	const protected_blocks = [];
	var processed = html.replace(/<(pre|code|span|a)[^>]*>[\s\S]*?<\/\1>/gi, function (match) {
		protected_blocks.push(match);
		return '___PROTECTED_' + (protected_blocks.length - 1) + '___';
	});

	// Also protect HTML attributes (href="...", src="...", etc.)
	processed = processed.replace(/(\w+)="[^"]*"/g, function (match) {
		protected_blocks.push(match);
		return '___PROTECTED_' + (protected_blocks.length - 1) + '___';
	});

	// Track already-processed paths to avoid double-processing
	const processedPaths = new Set();

	// 1. Process explicit [[path]] references (highest priority)
	processed = processed.replace(/\[\[([^\]]+)\]\]/g, function (_match, rawPath) {
		var path = rawPath.trim();
		if (!path) { return '[[]]'; }
		if (!isValidFileName(path)) { return _match; }

		processedPaths.add(path.toLowerCase());
		var isFolder = path.endsWith('/');
		var displayName = path.split('/').pop().replace(/\/$/, '') || path;

		return createFileRefSpan(path, displayName, isFolder);
	});

	// 2. Auto-detect folder patterns ending with /
	// Matches: __pycache__/, src/, data/, .git/, .github/, etc.
	processed = processed.replace(/(^|[\s>])(\.?__[\w.-]+__|\.?[\w][\w.-]*|\.[\w.-]+)\/([\s<,;:)]|$)/gm, function (_match, before, name, after) {
		var path = name + '/';
		if (processedPaths.has(path.toLowerCase())) { return before + path + after; }
		if (!isValidFileName(path)) { return _match; }

		processedPaths.add(path.toLowerCase());
		return before + createFileRefSpan(path, name, true) + '/' + after;
	});

	// 3. Auto-detect dotfiles (.env, .gitignore, .dockerignore, etc.)
	// These don't have name.ext structure, just .name
	var DOTFILES = /^\.(env|gitignore|dockerignore|editorconfig|prettierrc|eslintrc|eslintignore|babelrc|npmrc|yarnrc|nvmrc|python-version|ruby-version|node-version|tool-versions|flake8|pylintrc|coveragerc|pre-commit-config\.yaml)$/i;
	processed = processed.replace(/(^|[\s>])(\.[\w][\w.-]*)([\s<,;:)]|$)/gm, function (_match, before, name, after) {
		if (!DOTFILES.test(name)) { return _match; }

		var path = name;
		if (processedPaths.has(path.toLowerCase())) { return before + path + after; }

		processedPaths.add(path.toLowerCase());
		return before + createFileRefSpan(path, path, false) + after;
	});

	// 4. Auto-detect file patterns with common extensions
	// Matches: file.py, __init__.py, data-file.csv, rsi_strategy.cpython-313.pyc, etc.
	processed = processed.replace(/(^|[\s>])([\w][\w.-]*|__[\w.-]+__)\.([a-zA-Z0-9]+)([\s<,;:)]|$)/gm, function (_match, before, name, ext, after) {
		// Only process if it has a known file extension
		if (!FILE_EXTENSIONS.has(ext.toLowerCase())) { return _match; }

		var path = name + '.' + ext;
		if (processedPaths.has(path.toLowerCase())) { return before + path + after; }
		if (!isValidFileName(path)) { return _match; }

		processedPaths.add(path.toLowerCase());
		return before + createFileRefSpan(path, path, false) + after;
	});

	// Restore protected blocks
	protected_blocks.forEach(function (block, i) {
		processed = processed.replace('___PROTECTED_' + i + '___', block);
	});

	return processed;
}

// Export for use in chat.js
if (typeof window !== 'undefined') {
	window.markdownRenderer = { renderMarkdown, sanitizeHtml, isValidHref, processFileReferences };
}
