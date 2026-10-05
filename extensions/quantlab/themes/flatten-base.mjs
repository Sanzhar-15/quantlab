// One-time tool (kept as a record): flattens the pre-C1 theme files' `include` chains into the
// syntax-token base layer used by generate.mjs.
//
//   node flatten-base.mjs <dir-with-original-theme-files>
//
// The originals are the theme-defaults/themes/*.json files of fork commit 0d4e21dc13936957a905167eee06bb0b58789f19
// (the parent of the C1 commit); after C1 they no longer exist in the tree, so extract them first with
// `git show 0d4e21dc13:extensions/theme-defaults/themes/<file>` into a scratch directory.
//
// Flatten rule (same as VS Code's theme loader): the included file is applied first, the including file
// overrides; `tokenColors` are concatenated in include order, `colors` and `semanticTokenColors` are merged,
// `semanticHighlighting` is taken from the last file that sets it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = process.argv[2];
if (!srcDir) {
	console.error('flatten-base.mjs: usage: node flatten-base.mjs <dir-with-original-theme-files>');
	process.exit(2);
}

// Theme files are JSONC: remove // and /* */ comments (outside strings) and trailing commas, then JSON.parse.
function parseJsonc(text, label) {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (text[j] !== '"') {
				if (j >= text.length) {
					throw new Error(`${label}: unterminated string`);
				}
				j += text[j] === '\\' ? 2 : 1;
			}
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') {
				i++;
			}
		} else if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			if (end < 0) {
				throw new Error(`${label}: unterminated block comment`);
			}
			i = end + 2;
		} else {
			out += c;
			i++;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function load(file) {
	const full = path.resolve(srcDir, file);
	return { full, json: parseJsonc(fs.readFileSync(full, 'utf8'), full) };
}

function flatten(file, seen = []) {
	if (seen.includes(file)) {
		throw new Error(`include cycle at ${file}`);
	}
	const { json } = load(file);
	let out = { colors: {}, tokenColors: [], semanticTokenColors: {} };
	if (json.include !== undefined) {
		out = flatten(json.include.replace(/^\.\//, ''), [...seen, file]);
	}
	if (json.colors !== undefined) {
		out.colors = { ...out.colors, ...json.colors };
	}
	if (json.tokenColors !== undefined) {
		if (!Array.isArray(json.tokenColors)) {
			throw new Error(`${file}: tokenColors is not an inline array`);
		}
		out.tokenColors = out.tokenColors.concat(json.tokenColors);
	}
	if (json.semanticTokenColors !== undefined) {
		out.semanticTokenColors = { ...out.semanticTokenColors, ...json.semanticTokenColors };
	}
	if (json.semanticHighlighting !== undefined) {
		out.semanticHighlighting = json.semanticHighlighting;
	}
	return out;
}

const targets = { dark: 'quantlab_dark.json', light: 'quantlab_light.json', hc: 'hc_black.json' };
for (const [name, file] of Object.entries(targets)) {
	const flat = flatten(file);
	const ordered = {};
	if (flat.semanticHighlighting !== undefined) {
		ordered.semanticHighlighting = flat.semanticHighlighting;
	}
	ordered.semanticTokenColors = flat.semanticTokenColors;
	ordered.colors = flat.colors;
	ordered.tokenColors = flat.tokenColors;
	const dest = path.join(here, 'base', `${name}.json`);
	fs.writeFileSync(dest, JSON.stringify(ordered, null, '\t') + '\n');
	console.log(`${dest}: ${Object.keys(flat.colors).length} colors, ${flat.tokenColors.length} tokenColors, ${Object.keys(flat.semanticTokenColors).length} semanticTokenColors`);
}
