/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Quantbook engine packaging (QL-QUANTBOOK).
//
// `stage-quantbook-engine` copies what a packaged app needs out of a BUILT quantbook-engine tree
// (the node binding, the relay server, the `quantbook` Python package) and records what it staged.
// `quantbookEngineStream` hands the staged tree to the packaging task at the layout the extension
// resolves in a packaged app: <extension root>/quantbook-engine/, shaped like the engine tree itself
// (extensions/quantlab/src/quantbook/engineRoot.ts), so every path derived from it holds unchanged.
//
// Quantbook ships only where the product authorises it (product.json `quantlab.quantbookEnabled`).
// While that key is false the stream is empty, and says so.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import gulp from 'gulp';
import es from 'event-stream';
import rename from 'gulp-rename';
import * as task from '../lib/task.ts';

const root = path.dirname(path.dirname(import.meta.dirname));
const stageRoot = path.join(root, '.build', 'quantbook-engine');
const stageDir = path.join(stageRoot, 'quantbook-engine');
const recordPath = path.join(stageRoot, 'bundle.json');
const packagedDir = 'extensions/quantlab';
const pythonPackageDir = path.join('crates', 'quantbook-py', 'python');

interface IQuantbookBundleRecord {
	readonly platform: string;
	readonly arch: string;
	/** Staged files that are verified again at packaging time: path relative to the stage root -> sha256. */
	readonly sha256: Record<string, string>;
}

function sha256(file: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The built binaries, relative to the engine tree, for `platform`. */
export function quantbookBinaries(platform: string): { readonly binding: string; readonly relay: string } {
	const release = path.join('target', 'release');
	switch (platform) {
		case 'darwin': return { binding: path.join(release, 'libql_bindings_node.dylib'), relay: path.join(release, 'examples', 'relay-server') };
		case 'linux': return { binding: path.join(release, 'libql_bindings_node.so'), relay: path.join(release, 'examples', 'relay-server') };
		case 'win32': return { binding: path.join(release, 'ql_bindings_node.dll'), relay: path.join(release, 'examples', 'relay-server.exe') };
		default: throw new Error(`[quantbook-engine] no Quantbook engine binaries are defined for platform '${platform}'`);
	}
}

/** product.json's authorisation key, read strictly: anything but a boolean is refused by name. */
export function readQuantbookProductKey(productJsonPath: string): boolean {
	const key = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'))['quantlab.quantbookEnabled'];
	if (typeof key !== 'boolean') {
		throw new Error(`[quantbook-engine] ${productJsonPath}: 'quantlab.quantbookEnabled' must be true or false (got ${JSON.stringify(key)})`);
	}
	return key;
}

export const stageQuantbookEngineTask = task.define('stage-quantbook-engine', async () => {
	const engineRoot = process.env['QUANTBOOK_ENGINE_ROOT'];
	if (!engineRoot) {
		throw new Error('[quantbook-engine] QUANTBOOK_ENGINE_ROOT is not set: name the quantbook-engine directory whose target/release holds the built binding and relay');
	}
	// cargo builds for the machine it runs on; this task stages no cross-built tree.
	const binaries = quantbookBinaries(process.platform);
	const pythonSource = path.join(engineRoot, pythonPackageDir);
	for (const required of [path.join(engineRoot, binaries.binding), path.join(engineRoot, binaries.relay), path.join(pythonSource, 'quantbook')]) {
		if (!fs.existsSync(required)) {
			throw new Error(`[quantbook-engine] ${required} does not exist: build the engine first (cargo build --release --locked -p ql-bindings-node; -p ql-collab-ws --example relay-server)`);
		}
	}

	await fs.promises.rm(stageRoot, { recursive: true, force: true });
	const sums: Record<string, string> = {};
	for (const file of [binaries.binding, binaries.relay]) {
		const target = path.join(stageDir, file);
		await fs.promises.mkdir(path.dirname(target), { recursive: true });
		await fs.promises.copyFile(path.join(engineRoot, file), target);
		await fs.promises.chmod(target, 0o755);
		sums[path.relative(stageRoot, target).replace(/\\/g, '/')] = sha256(target);
	}
	await fs.promises.cp(pythonSource, path.join(stageDir, pythonPackageDir), {
		recursive: true,
		filter: source => path.basename(source) !== '__pycache__' && !source.endsWith('.pyc'),
	});

	const record: IQuantbookBundleRecord = { platform: process.platform, arch: process.arch, sha256: sums };
	await fs.promises.writeFile(recordPath, JSON.stringify(record, undefined, '\t') + '\n');
	for (const [file, sum] of Object.entries(sums)) {
		console.log(`[quantbook-engine] staged ${record.platform}-${record.arch} ${file} sha256 ${sum}`);
	}
});

/**
 * The staged Quantbook engine as packaging sources, placed under `extensions/quantlab/quantbook-engine/`.
 * Product key false: an empty stream, stated. Product key true: the staged tree is required, for this
 * target, with the recorded digests.
 */
export function quantbookEngineStream(platform: string, arch: string): NodeJS.ReadWriteStream {
	if (!readQuantbookProductKey(path.join(root, 'product.json'))) {
		console.log(`[quantbook-engine] product.json quantlab.quantbookEnabled is false: packaging ${platform}-${arch} WITHOUT the Quantbook engine (${packagedDir}/quantbook-engine/ will be absent)`);
		return es.readArray([]);
	}

	if (!fs.existsSync(recordPath)) {
		throw new Error(`[quantbook-engine] product.json authorises Quantbook but there is no staged engine at ${recordPath}: run the gulp task 'stage-quantbook-engine' first`);
	}
	const record: IQuantbookBundleRecord = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
	if (record.platform !== platform || record.arch !== arch) {
		throw new Error(`[quantbook-engine] the staged engine at ${stageRoot} is ${record.platform}-${record.arch}, the packaging target is ${platform}-${arch}`);
	}
	for (const [file, recorded] of Object.entries(record.sha256)) {
		const actual = sha256(path.join(stageRoot, file));
		if (actual !== recorded) {
			throw new Error(`[quantbook-engine] ${file} has sha256 ${actual}, the staging step recorded ${recorded}`);
		}
	}

	return gulp.src('.build/quantbook-engine/quantbook-engine/**', { base: '.build/quantbook-engine', dot: true })
		.pipe(rename(file => { file.dirname = path.posix.join(packagedDir, file.dirname!.replace(/\\/g, '/')); }));
}
