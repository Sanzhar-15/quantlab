/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolDefinition } from './types.js';

/**
 * Canonical tool registry — all 23 tools per QIC Spec v6.3 Appendix A.
 *
 * BYOK Optimization: Tool descriptions include usage guidance to help models
 * use tools efficiently without over-investigation.
 */
export const TOOL_REGISTRY: Record<string, ToolDefinition> = {

	// === File Operations (1-7) ===

	'read_file': {
		name: 'read_file',
		description: `Read file contents with line numbers and metadata header.

Returns content in format: "NNN | line content" with a metadata header showing file name, line count, and size.

Usage tips:
- For large data files (CSV, JSON): Use startLine/endLine to sample rather than reading everything
- To check date ranges in data: Read first 5 lines and last 5 lines
- For code files: Read specific sections if you know what you're looking for
- Large source files (>500 lines) show first 100 + last 50 lines — use startLine/endLine for specific sections
- The tool will return file metadata (size, detected format) for data files`,
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Absolute or workspace-relative file path' },
				startLine: { type: 'number', description: 'Start line (1-based). Use with endLine to read a range.' },
				endLine: { type: 'number', description: 'End line (1-based). Use with startLine to read a range.' },
			},
			required: ['path'],
		},
		hasSideEffects: false,
		permission: { required: false },
	},

	'write_file': {
		name: 'write_file',
		description: `Write content to a file, creating it if it doesn't exist. Overwrites entire content.

Use this for:
- Creating NEW files
- Full file rewrites (replacing all content)

For targeted edits to existing files, use edit_file instead — it's faster and safer.`,
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path to write to' },
				content: { type: 'string', description: 'Complete file content to write' },
			},
			required: ['path', 'content'],
		},
		hasSideEffects: true,
		permission: { required: true, level: 'once' },
	},

	'edit_file': {
		name: 'edit_file',
		description: `Make a targeted edit to a file by replacing an exact string match.

IMPORTANT:
- old_string must match EXACTLY (including whitespace and indentation)
- old_string must be UNIQUE in the file — include enough surrounding lines for uniqueness
- To create a new file, use write_file instead
- To delete content, set new_string to empty string

Workflow: read_file first to see content with line numbers, then edit_file with exact text.`,
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path to edit' },
				old_string: { type: 'string', description: 'Exact text to find and replace (must be unique in the file)' },
				new_string: { type: 'string', description: 'Replacement text' },
			},
			required: ['path', 'old_string', 'new_string'],
		},
		hasSideEffects: true,
		permission: { required: true, level: 'once' },
	},

	'delete_file': {
		name: 'delete_file',
		description: 'Delete a file. Use with caution — this is irreversible.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path to delete' },
			},
			required: ['path'],
		},
		hasSideEffects: true,
		permission: { required: true, level: 'once' },
	},

	'move_file': {
		name: 'move_file',
		description: 'Move or rename a file. Also use this for renaming.',
		parameters: {
			type: 'object',
			properties: {
				source: { type: 'string', description: 'Current file path' },
				destination: { type: 'string', description: 'New file path' },
			},
			required: ['source', 'destination'],
		},
		hasSideEffects: true,
		permission: { required: true, level: 'once' },
	},

	'create_directory': {
		name: 'create_directory',
		description: 'Create a directory. Parent directories are created automatically if needed.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Directory path to create' },
			},
			required: ['path'],
		},
		hasSideEffects: true,
		permission: { required: true, level: 'once' },
	},

	'list_directory': {
		name: 'list_directory',
		description: `List directory contents with file sizes. Returns sorted tree with directories first.

Use this to:
- Discover what files exist in a directory
- Understand project structure (use recursive for full tree, max depth 4)
- Find files before reading them

Common junk directories (node_modules, .git, __pycache__, etc.) are auto-skipped in recursive mode.`,
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Directory path to list' },
				recursive: { type: 'string', description: 'Set to "true" to list subdirectories recursively', enum: ['true', 'false'] },
			},
			required: ['path'],
		},
		hasSideEffects: false,
		permission: { required: false },
	},

	// === Code Intelligence (7-10) ===

	'search_code': {
		name: 'search_code',
		description: `Search for text or regex patterns across workspace files. Returns matched lines with line numbers and context.

Results format: matched lines with 2 lines of context above/below, grouped by file. Lines are prefixed with line numbers. Matched lines are marked with |>.

Use this to:
- Find function/class definitions: "def calculate" or "class MyClass"
- Locate usages of a variable or function
- Find specific patterns: "import.*pandas", "TODO|FIXME"

Tips:
- Use include/exclude globs to narrow scope: include="*.py", exclude="tests/**"
- Regex patterns: "function\\s+myFunc" finds function definitions
- Literal strings also work: "calculateReturn" finds exact matches`,
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search pattern (regex supported)' },
				include: { type: 'string', description: 'Glob pattern to include (e.g., "*.py", "src/**/*.ts")' },
				exclude: { type: 'string', description: 'Glob pattern to exclude (e.g., "node_modules/**")' },
				maxResults: { type: 'number', description: 'Limit results (default: 50)' },
			},
			required: ['query'],
		},
		hasSideEffects: false,
		permission: { required: false },
	},

	'search_files': {
		name: 'search_files',
		description: `Search for files by name or glob pattern. Use this to find files when you know part of the filename.

Examples:
- "*.csv" — find all CSV files
- "*config*" — find files with "config" in the name
- "**/*test*.py" — find Python test files anywhere`,
		parameters: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'Filename or glob pattern' },
				maxResults: { type: 'number', description: 'Limit results (default: 50)' },
			},
			required: ['pattern'],
		},
		hasSideEffects: false,
		permission: { required: false },
	},

	'get_references': {
		name: 'get_references',
		description: 'Find all references to a symbol (variable, function, class) at a specific location. Requires LSP support for the file type.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path containing the symbol' },
				line: { type: 'number', description: 'Line number (1-based)' },
				column: { type: 'number', description: 'Column number (1-based)' },
			},
			required: ['path', 'line', 'column'],
		},
		hasSideEffects: false,
		permission: { required: false },
	},

	'get_definition': {
		name: 'get_definition',
		description: 'Jump to the definition of a symbol. Useful for understanding where a function or class is implemented.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path containing the reference' },
				line: { type: 'number', description: 'Line number (1-based)' },
				column: { type: 'number', description: 'Column number (1-based)' },
			},
			required: ['path', 'line', 'column'],
		},
		hasSideEffects: false,
		permission: { required: false },
	},

	// === Terminal (11-12) ===

	'run_terminal': {
		name: 'run_terminal',
		description: `Execute a command in the terminal. Output is shown to the user but NOT captured/returned.

Use for:
- Running scripts the user wants to see
- Long-running processes
- Interactive commands

Do NOT use if you need to see the output — use run_command instead.`,
		parameters: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'Shell command to execute' },
				cwd: { type: 'string', description: 'Working directory (optional)' },
				timeout: { type: 'number', description: 'Timeout in milliseconds (optional)' },
			},
			required: ['command'],
		},
		hasSideEffects: true,
		permission: { required: true, level: 'once' },
	},

	'run_command': {
		name: 'run_command',
		description: `Execute a command and capture its output. Returns stdout and stderr.

Use for:
- Running scripts and checking results
- Executing tests
- Any command where you need to process the output

Keep commands simple. For complex operations, write a script and run that.`,
		parameters: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'Shell command to execute' },
				cwd: { type: 'string', description: 'Working directory (optional)' },
				timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
			},
			required: ['command'],
		},
		hasSideEffects: true,
		permission: { required: true, level: 'once' },
	},

	// === Network (13-14) ===

	'web_fetch': {
		name: 'web_fetch',
		description: `Fetch content from a URL. Returns the response body.

Blocked:
- Internal/private IPs (10.x, 192.168.x, 127.x, etc.)
- Localhost
- Cloud metadata endpoints

Use for fetching public documentation, APIs, or web content.`,
		parameters: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'URL to fetch (must be public, external)' },
			},
			required: ['url'],
		},
		hasSideEffects: false,
		permission: { required: true, level: 'once' },
	},

	'web_search': {
		name: 'web_search',
		description: `Search the web for information. Returns search results with titles, URLs, and snippets.

Use for:
- Finding documentation
- Researching libraries or APIs
- Looking up error messages

Rate limited to prevent abuse.`,
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search query' },
				maxResults: { type: 'number', description: 'Maximum results (default: 10)' },
			},
			required: ['query'],
		},
		hasSideEffects: false,
		permission: { required: false },
		status: 'active',
	},

	// === Package (15) ===

	'install_package': {
		name: 'install_package',
		description: `Install a package using pip, npm, or conda.

Detects the appropriate package manager from context, or specify explicitly.
Runs in the workspace environment.`,
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Package name (e.g., "pandas", "lodash")' },
				manager: { type: 'string', description: 'Package manager to use', enum: ['pip', 'npm', 'conda'] },
			},
			required: ['name'],
		},
		hasSideEffects: true,
		permission: { required: true, level: 'once' },
	},

	// === LSP (16-18) ===

	'rename_symbol': {
		name: 'rename_symbol',
		description: 'Rename a symbol across the entire workspace using LSP. Safer than find-replace for refactoring.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File containing the symbol' },
				line: { type: 'number', description: 'Line number (1-based)' },
				column: { type: 'number', description: 'Column number (1-based)' },
				newName: { type: 'string', description: 'New name for the symbol' },
			},
			required: ['path', 'line', 'column', 'newName'],
		},
		hasSideEffects: true,
		permission: { required: true, level: 'once' },
		status: 'not-yet-implemented',
	},

	'apply_code_action': {
		name: 'apply_code_action',
		description: 'Apply a suggested code action (quick fix) at a location. Useful for auto-fixes suggested by linters or language servers.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path' },
				line: { type: 'number', description: 'Line number (1-based)' },
				column: { type: 'number', description: 'Column number (1-based)' },
				actionTitle: { type: 'string', description: 'Title of the code action to apply' },
			},
			required: ['path', 'line', 'column'],
		},
		hasSideEffects: true,
		permission: { required: true, level: 'once' },
		status: 'not-yet-implemented',
	},

	'organize_imports': {
		name: 'organize_imports',
		description: 'Sort imports and remove unused imports in a file. Requires LSP support.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path' },
			},
			required: ['path'],
		},
		hasSideEffects: true,
		permission: { required: true, level: 'once' },
		status: 'not-yet-implemented',
	},

	// === Quant Domain (19-21) ===

	'inspect_notebook': {
		name: 'inspect_notebook',
		description: `Inspect a Jupyter notebook (.ipynb). Returns cell contents, outputs, and metadata.

More efficient than read_file for notebooks — parses the JSON structure and presents it cleanly.`,
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Notebook file path (.ipynb)' },
				cellIndex: { type: 'number', description: 'Specific cell index to inspect (0-based). Omit to see all cells.' },
			},
			required: ['path'],
		},
		hasSideEffects: false,
		permission: { required: false },
	},

	'preview_dataframe': {
		name: 'preview_dataframe',
		description: `Preview a pandas DataFrame. Shows shape, columns, dtypes, and sample rows.

Source can be:
- A variable name (if Python kernel is running)
- A file path (CSV, Parquet, etc.)

More informative than reading raw file — includes data analysis.`,
		parameters: {
			type: 'object',
			properties: {
				source: { type: 'string', description: 'Variable name or file path' },
				maxRows: { type: 'number', description: 'Maximum rows to preview (default: 10)' },
			},
			required: ['source'],
		},
		hasSideEffects: false,
		permission: { required: false },
	},

	'analyze_backtest': {
		name: 'analyze_backtest',
		description: `Analyze backtest results and compute performance metrics.

Returns: Sharpe ratio, max drawdown, CAGR, win rate, and other standard quant metrics.

Input: File path to backtest results (CSV with returns or equity curve).`,
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path to backtest results file' },
				benchmark: { type: 'string', description: 'Benchmark to compare against (e.g., "SPY", "BTC")' },
			},
			required: ['path'],
		},
		hasSideEffects: true,
		permission: { required: true, level: 'session' },
	},

	// === Git (22-24) ===

	'git_status': {
		name: 'git_status',
		description: `Show the working tree status (modified, staged, untracked files) and current branch. Uses porcelain v2 format for machine-readable output.`,
		parameters: {
			type: 'object',
			properties: {},
		},
		hasSideEffects: false,
		permission: { required: false },
	},

	'git_diff': {
		name: 'git_diff',
		description: `Show changes in the working tree or staging area. Returns both stat summary and patch output.

Use staged=true to see what's staged for commit. Use path to limit diff to a specific file.`,
		parameters: {
			type: 'object',
			properties: {
				staged: { type: 'string', description: 'Set to "true" to show staged changes', enum: ['true', 'false'] },
				path: { type: 'string', description: 'Limit diff to a specific file path' },
			},
		},
		hasSideEffects: false,
		permission: { required: false },
	},

	'git_log': {
		name: 'git_log',
		description: `Show recent commit history. Returns hash, date, author, and message for each commit.`,
		parameters: {
			type: 'object',
			properties: {
				count: { type: 'number', description: 'Number of commits to show (default: 10, max: 50)' },
				path: { type: 'string', description: 'Show commits affecting a specific file' },
			},
		},
		hasSideEffects: false,
		permission: { required: false },
	},

	// === Checkpoint (25) ===

	'create_checkpoint': {
		name: 'create_checkpoint',
		description: `Create a checkpoint of the current workspace state. Use before making significant changes so you can restore if needed.

Checkpoints are lightweight — they track changed files, not full copies.`,
		parameters: {
			type: 'object',
			properties: {
				label: { type: 'string', description: 'Descriptive label (e.g., "before refactoring auth")' },
			},
		},
		hasSideEffects: true,
		permission: { required: true, level: 'once' },
	},
};
