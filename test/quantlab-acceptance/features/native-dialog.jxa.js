/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// JXA, run by native-dialog.mjs as: osascript -l JavaScript native-dialog.jxa.js <app pid> <required button titles JSON> <message fragment> <title to click | @@none@@>
// Reads the macOS accessibility tree of ONE process (System Events, `unix id` = pid) and finds native dialogs in it: every sheet (AXSheet child of a
// window: Electron's dialog.showMessageBox(window, ...) is a sheet) and every window that is not an AXStandardWindow (a modal alert window)
// whose buttons include ALL the required titles. A standard window is read one level deep only (its Chromium web content is never entered).
// With a title to click: clicks that button ONLY when exactly one dialog matches, its static texts contain the message fragment and exactly one
// button carries that title; otherwise it clicks nothing and says why in `refusal`.
// Output: ONE line on stdout, `QLNATIVE <json>` (written through NSFileHandle, so it does not depend on which stream osascript echoes a return
// value to). Any error is thrown and stays an error: osascript exits non-zero and its stderr carries the text (assistive-access refusals
// included). An attribute an element does not have (AppleScript "Can't get ...", never a permission text) is recorded in `absent`, not an error.

ObjC.import('Foundation');

function emit(text) {
	$.NSFileHandle.fileHandleWithStandardOutput.writeData($(text + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
}

function run(argv) {
	if (argv.length !== 4) {
		throw new Error('native-dialog.jxa.js needs 4 arguments (pid, required titles JSON, message fragment, title to click or @@none@@), got ' + argv.length);
	}
	const pid = Number(argv[0]);
	if (!Number.isInteger(pid) || pid <= 0) {
		throw new Error('native-dialog.jxa.js: bad pid ' + JSON.stringify(argv[0]));
	}
	const required = JSON.parse(argv[1]);
	if (!Array.isArray(required) || required.length === 0) {
		throw new Error('native-dialog.jxa.js: the required titles must be a non-empty JSON array, got ' + argv[1]);
	}
	const fragment = argv[2];
	if (fragment === '') {
		throw new Error('native-dialog.jxa.js: the message fragment is empty');
	}
	const clickTitle = argv[3] === '@@none@@' ? null : argv[3];

	const absent = [];
	// A permission text is never read as "attribute absent": it is rethrown whatever number it carries (-1728, -1719, -25211, -1743).
	const PERMISSION = /assistive|not allowed|not authori[sz]ed|-25211|-1743|-1719/i;
	const attr = (el, label, name) => {
		try {
			const v = el[name]();
			return v === undefined ? null : v;
		} catch (e) {
			const text = String(e && e.message !== undefined ? e.message : e);
			if (!PERMISSION.test(text) && /Can.t get|-1728/.test(text)) {
				absent.push(label + '.' + name);
				return null;
			}
			throw e;
		}
	};
	const describe = (el, label) => {
		const node = { role: attr(el, label, 'role'), subrole: attr(el, label, 'subrole'), name: attr(el, label, 'name'), title: attr(el, label, 'title'), description: attr(el, label, 'description'), value: null };
		if (node.role === 'AXStaticText' || node.role === 'AXTextField') {
			node.value = attr(el, label, 'value');
		}
		return node;
	};
	const labelOf = (node) => (node.title !== null ? node.title : node.name);
	const textOf = (node) => (node.value !== null ? node.value : node.name);

	// `depth` levels below `el`; sink gets {node, el} for each element in document order.
	const walk = (el, label, depth, path, sink) => {
		const children = el.uiElements();
		children.forEach((child, i) => {
			const p = path + '/' + (i + 1);
			const node = describe(child, label + p);
			node.path = p;
			sink.push({ node, el: child });
			if (depth > 1) {
				walk(child, label, depth - 1, p, sink);
			}
		});
	};

	const se = Application('System Events');
	const procs = se.processes.whose({ unixId: pid })();
	const out = { pid, procCount: procs.length, procName: null, windows: [], matches: [], clicked: null, refusal: null, absent };
	if (procs.length !== 1) {
		emit('QLNATIVE ' + JSON.stringify(out));
		return;
	}
	const proc = procs[0];
	out.procName = attr(proc, 'process', 'name');

	const matched = []; // {info, nodes} per matching container; `info` is what goes to the output
	const containerInfo = (kind, wi, path, nodes) => {
		const buttons = nodes.filter((n) => n.node.role === 'AXButton').map((n) => labelOf(n.node));
		const texts = nodes.filter((n) => n.node.role === 'AXStaticText').map((n) => textOf(n.node));
		const info = { kind, window: wi, path, buttons, texts, message: texts.join(' | ') };
		if (required.every((t) => buttons.includes(t))) {
			matched.push({ info, nodes });
		}
		return info;
	};

	proc.windows().forEach((w, i) => {
		const wi = i + 1;
		const label = 'window ' + wi;
		const winInfo = Object.assign({ index: wi }, describe(w, label));
		const direct = [];
		walk(w, label, 1, '', direct);
		winInfo.children = direct.map((d) => ({ path: d.node.path, role: d.node.role, subrole: d.node.subrole, name: d.node.name, title: d.node.title }));
		winInfo.containers = [];
		let ownNodes = direct;
		if (winInfo.subrole !== 'AXStandardWindow') {
			ownNodes = [];
			walk(w, label, 3, '', ownNodes);
		}
		winInfo.containers.push(containerInfo('window', wi, '', ownNodes));
		direct.filter((d) => d.node.role === 'AXSheet').forEach((sheet) => {
			const nodes = [];
			walk(sheet.el, label + sheet.node.path, 3, '', nodes);
			winInfo.containers.push(containerInfo('sheet', wi, sheet.node.path, nodes));
		});
		out.windows.push(winInfo);
	});
	out.matches = matched.map((m) => m.info);

	if (clickTitle !== null) {
		if (matched.length !== 1) {
			out.refusal = 'click refused: ' + matched.length + ' dialogs match (exactly 1 needed); nothing clicked';
		} else if (!matched[0].info.message.includes(fragment)) {
			out.refusal = 'click refused: the one matching dialog has the static texts ' + JSON.stringify(matched[0].info.texts) + ', none containing ' + JSON.stringify(fragment) + '; nothing clicked';
		} else {
			const candidates = matched[0].nodes.filter((n) => n.node.role === 'AXButton' && labelOf(n.node) === clickTitle);
			if (candidates.length !== 1) {
				out.refusal = 'click refused: ' + candidates.length + ' buttons titled ' + JSON.stringify(clickTitle) + ' in the matching dialog (exactly 1 needed); nothing clicked';
			} else {
				candidates[0].el.click();
				out.clicked = { title: clickTitle, container: matched[0].info.kind, window: matched[0].info.window, path: matched[0].info.path + candidates[0].node.path };
			}
		}
	}
	emit('QLNATIVE ' + JSON.stringify(out));
}
