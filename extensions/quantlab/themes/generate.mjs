// Generates the three Delta Plus colour themes of extensions/theme-defaults from the design tokens.
//
//   node generate.mjs          write the three theme files
//   node generate.mjs --check  regenerate in memory; exit 0 only if the shipped files are byte-equal
//
// Inputs (all committed beside this file): tokens/variables.css.template (byte copy of the recorded git blob),
// tokens/SOURCE.json (client commit + blob sha), base/{dark,light,hc}.json (syntax-token layer),
// mapping.json (VS Code colour id -> token expression). No dependencies, no network.
// Any problem is a hard error that names the offender: there are no fallback values.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../theme-defaults/themes');
const GENERATOR_PATH = 'extensions/quantlab/themes/generate.mjs';

class GenError extends Error {
	constructor(code, message) {
		super(`${code}: ${message}`);
	}
}

// ---------------------------------------------------------------- inputs

function readJson(rel) {
	const file = path.join(here, rel);
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function gitBlobSha(bytes) {
	const h = crypto.createHash('sha1');
	h.update(`blob ${bytes.length}\0`);
	h.update(bytes);
	return h.digest('hex');
}

function loadSource() {
	const source = readJson('tokens/SOURCE.json');
	for (const field of ['clientCommit', 'path', 'blob']) {
		if (typeof source[field] !== 'string') {
			throw new GenError('SOURCE-INVALID', `tokens/SOURCE.json has no string field "${field}"`);
		}
	}
	if (!/^[0-9a-f]{40}$/.test(source.clientCommit)) {
		throw new GenError('SOURCE-INVALID', `tokens/SOURCE.json clientCommit "${source.clientCommit}" is not a full 40-hex sha`);
	}
	if (!/^[0-9a-f]{40}$/.test(source.blob)) {
		throw new GenError('SOURCE-INVALID', `tokens/SOURCE.json blob "${source.blob}" is not a full 40-hex sha`);
	}
	const bytes = fs.readFileSync(path.join(here, 'tokens/variables.css.template'));
	const actual = gitBlobSha(bytes);
	if (actual !== source.blob) {
		throw new GenError('BLOB-MISMATCH', `tokens/variables.css.template has git blob sha ${actual} but tokens/SOURCE.json records ${source.blob}`);
	}
	return { source, css: bytes.toString('utf8') };
}

// ---------------------------------------------------------------- CSS custom properties

function stripComments(css) {
	return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Top-level rules only: [{ selectors: string[], body: string }]. Nested blocks (@keyframes) stay inside `body`.
function topLevelRules(css) {
	const rules = [];
	let depth = 0;
	let start = 0;
	let selector = '';
	let bodyStart = 0;
	for (let i = 0; i < css.length; i++) {
		const c = css[i];
		if (c === '{') {
			if (depth === 0) {
				selector = css.slice(start, i).trim();
				bodyStart = i + 1;
			}
			depth++;
		} else if (c === '}') {
			depth--;
			if (depth < 0) {
				throw new GenError('CSS-PARSE', `unbalanced "}" at offset ${i}`);
			}
			if (depth === 0) {
				rules.push({ selectors: selector.split(',').map(s => s.replace(/\s+/g, ' ').trim()), body: css.slice(bodyStart, i) });
				start = i + 1;
			}
		}
	}
	if (depth !== 0) {
		throw new GenError('CSS-PARSE', 'unbalanced "{" at end of file');
	}
	return rules;
}

function customProperties(body) {
	const props = new Map();
	for (const decl of body.split(';')) {
		const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]*?)\s*$/.exec(decl);
		if (m) {
			props.set(m[1], m[2]); // later declaration wins, as in CSS
		}
	}
	return props;
}

function singleRule(rules, selector) {
	const found = rules.filter(r => r.selectors.includes(selector));
	if (found.length !== 1) {
		throw new GenError('CSS-PARSE', `expected exactly one top-level rule whose selector list contains \`${selector}\`, found ${found.length}`);
	}
	return found[0];
}

function scopes(css) {
	const rules = topLevelRules(stripComments(css));
	const dark = customProperties(singleRule(rules, ':root').body);
	const lightOverrides = customProperties(singleRule(rules, '[data-theme="light"]').body);
	const light = new Map([...dark, ...lightOverrides]);
	return { dark, light };
}

// ---------------------------------------------------------------- colour resolution

function resolveText(name, scope, stack) {
	if (stack.includes(name)) {
		throw new GenError('TOKEN-CYCLE', `${[...stack, name].join(' -> ')}`);
	}
	if (!scope.has(name)) {
		throw new GenError('TOKEN-MISSING', `${name} is not defined${stack.length ? ` (referenced by ${stack[stack.length - 1]})` : ''}`);
	}
	const raw = scope.get(name);
	const substituted = raw.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, ref) => resolveText(ref, scope, [...stack, name]));
	if (substituted.includes('var(')) {
		throw new GenError('TOKEN-UNSUPPORTED', `${name} uses var() with a fallback or other unsupported form: ${raw}`);
	}
	return substituted;
}

const num = '(\\d*\\.?\\d+)';
const alphaPart = `(\\d*\\.?\\d+%?)`;
const RGB_COMMA = new RegExp(`^rgba?\\(\\s*${num}\\s*,\\s*${num}\\s*,\\s*${num}\\s*(?:,\\s*${alphaPart}\\s*)?\\)$`);
const RGB_SPACE = new RegExp(`^rgba?\\(\\s*${num}\\s+${num}\\s+${num}\\s*(?:/\\s*${alphaPart}\\s*)?\\)$`);

function alphaValue(text, name) {
	const a = text.endsWith('%') ? parseFloat(text) / 100 : parseFloat(text);
	if (!(a >= 0 && a <= 1)) {
		throw new GenError('TOKEN-NOT-COLOUR', `${name} has alpha ${text} outside 0..1`);
	}
	return a;
}

function channel(text, name) {
	const v = parseFloat(text);
	if (!(v >= 0 && v <= 255)) {
		throw new GenError('TOKEN-NOT-COLOUR', `${name} has channel ${text} outside 0..255`);
	}
	return Math.round(v);
}

// -> [r, g, b, a] (a in 0..1)
function parseColour(text, name) {
	const t = text.trim();
	if (t === 'transparent') {
		return [0, 0, 0, 0];
	}
	let m = /^#([0-9a-fA-F]+)$/.exec(t);
	if (m) {
		let h = m[1];
		if (h.length === 3 || h.length === 4) {
			h = [...h].map(c => c + c).join('');
		}
		if (h.length !== 6 && h.length !== 8) {
			throw new GenError('TOKEN-NOT-COLOUR', `${name} has a hex colour of invalid length: ${t}`);
		}
		const byte = i => parseInt(h.slice(i, i + 2), 16);
		return [byte(0), byte(2), byte(4), h.length === 8 ? byte(6) / 255 : 1];
	}
	m = RGB_COMMA.exec(t) ?? RGB_SPACE.exec(t);
	if (m) {
		return [channel(m[1], name), channel(m[2], name), channel(m[3], name), m[4] === undefined ? 1 : alphaValue(m[4], name)];
	}
	throw new GenError('TOKEN-NOT-COLOUR', `${name} does not resolve to a supported colour (hex, rgb(), rgba(), transparent): "${t}"`);
}

function tokenColour(name, scope) {
	return parseColour(resolveText(name, scope, []), name);
}

function toHex([r, g, b, a]) {
	const two = n => n.toString(16).toUpperCase().padStart(2, '0');
	const alphaByte = Math.round(a * 255);
	return `#${two(r)}${two(g)}${two(b)}${alphaByte === 255 ? '' : two(alphaByte)}`;
}

// ---------------------------------------------------------------- mapping

function evaluate(key, expr, scope, themeName) {
	const where = `mapping.json ${themeName} "${key}"`;
	if (typeof expr === 'string') {
		return toHex(tokenColour(expr, scope));
	}
	if (expr !== null && typeof expr === 'object') {
		if (typeof expr.literal === 'string') {
			if (typeof expr.reason !== 'string' || expr.reason.length === 0) {
				throw new GenError('MAPPING-INVALID', `${where}: a literal needs a non-empty "reason"`);
			}
			if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(expr.literal)) {
				throw new GenError('MAPPING-INVALID', `${where}: literal ${expr.literal} is not #rrggbb or #rrggbbaa`);
			}
			return expr.literal.toUpperCase();
		}
		if (typeof expr.token === 'string') {
			const colour = tokenColour(expr.token, scope);
			if (expr.alpha !== undefined) {
				if (typeof expr.alpha !== 'number' || !(expr.alpha >= 0 && expr.alpha <= 1)) {
					throw new GenError('MAPPING-INVALID', `${where}: alpha must be a number in 0..1`);
				}
				colour[3] *= expr.alpha;
			}
			return toHex(colour);
		}
	}
	throw new GenError('MAPPING-INVALID', `${where}: expression must be "--token", { token, alpha? } or { literal, reason }`);
}

// ---------------------------------------------------------------- themes

const THEMES = [
	{ key: 'dark', scope: 'dark', name: 'Delta Plus Dark', file: 'delta_plus_dark.json' },
	{ key: 'light', scope: 'light', name: 'Delta Plus Light', file: 'delta_plus_light.json' },
	{ key: 'hc', scope: 'dark', name: 'Delta Plus High Contrast', file: 'delta_plus_hc.json' },
];

function build(theme, scopeMaps, mapping, source) {
	const base = readJson(`base/${theme.key}.json`);
	const themeMapping = mapping[theme.key];
	if (themeMapping === null || typeof themeMapping !== 'object') {
		throw new GenError('MAPPING-INVALID', `mapping.json has no object for "${theme.key}"`);
	}
	const scope = scopeMaps[theme.scope];
	const colors = { ...base.colors };
	for (const [key, expr] of Object.entries(themeMapping)) {
		colors[key] = evaluate(key, expr, scope, theme.key);
	}
	const sorted = {};
	for (const key of Object.keys(colors).sort()) {
		if (typeof colors[key] !== 'string' || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(colors[key])) {
			throw new GenError('COLOUR-INVALID', `${theme.file} colors["${key}"] = ${JSON.stringify(colors[key])} is not #rrggbb or #rrggbbaa`);
		}
		sorted[key] = colors[key];
	}
	const out = { $schema: 'vscode://schemas/color-theme', name: theme.name };
	if (base.semanticHighlighting !== undefined) {
		out.semanticHighlighting = base.semanticHighlighting;
	}
	out.semanticTokenColors = base.semanticTokenColors;
	out.colors = sorted;
	out.tokenColors = base.tokenColors;
	const header = `// Generated by ${GENERATOR_PATH} from client commit ${source.clientCommit}, token blob ${source.blob} (${source.path}). Do not edit: change the tokens or mapping.json and regenerate.\n`;
	return header + JSON.stringify(out, null, '\t') + '\n';
}

function generateAll() {
	const { source, css } = loadSource();
	const scopeMaps = scopes(css);
	const mapping = readJson('mapping.json');
	return THEMES.map(theme => ({ file: theme.file, text: build(theme, scopeMaps, mapping, source) }));
}

function main() {
	const flags = process.argv.slice(2);
	const unknown = flags.filter(f => f !== '--check');
	if (unknown.length) {
		throw new GenError('USAGE', `unknown argument ${unknown.join(' ')}; usage: generate.mjs [--check]`);
	}
	const generated = generateAll();
	if (flags.includes('--check')) {
		let bad = 0;
		for (const { file, text } of generated) {
			const target = path.join(outDir, file);
			if (!fs.existsSync(target)) {
				console.error(`generate.mjs: CHECK-FAILED: ${target} does not exist`);
				bad++;
			} else if (!fs.readFileSync(target).equals(Buffer.from(text, 'utf8'))) {
				console.error(`generate.mjs: CHECK-FAILED: ${target} differs from regeneration`);
				bad++;
			}
		}
		if (bad) {
			process.exit(1);
		}
		console.log(`generate.mjs: --check ok: ${generated.length} files byte-equal to regeneration`);
		return;
	}
	fs.mkdirSync(outDir, { recursive: true });
	for (const { file, text } of generated) {
		fs.writeFileSync(path.join(outDir, file), text);
		console.log(`generate.mjs: wrote ${path.join(outDir, file)}`);
	}
}

try {
	main();
} catch (e) {
	if (e instanceof GenError) {
		console.error(`generate.mjs: ERROR ${e.message}`);
		process.exit(1);
	}
	throw e;
}
