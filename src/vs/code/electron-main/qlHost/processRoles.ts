/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (DRIVER): TEST BUILDS ONLY, imported only inside `app.ts`'s `if (globalThis.QL_TEST_BUILD)` block (a product
// bundle carries neither this module nor its file name). No run-time imports: `build/qlhost/check-process-roles.mjs` runs it.
//
// The lines of one `ql-test:process-roles` request: which OS process has which role, for the package rows that kill one
// process (A5a-c) and for the per-process egress capture. The OS argv does not tell the fork's utility processes apart, and
// nothing logs a renderer's pid; the main process knows all of them:
//
//   process roles begin
//   process pid=<pid> role=main
//   process pid=<pid> role=renderer:<view name>          one per view of the host window (terminal, workbench, overlay)
//   process gone role=renderer:<view name>               a view whose renderer has no process now (after a kill)
//   process pid=<pid> role=utility:<name>                `UtilityProcess.getAll()`: shared-process, extension-host [<window>], pty-host, ...
//   process pid=<pid> role=chromium:<type>[:<service>]   every other child in `app.getAppMetrics()` (GPU, network service, ...)
//   process roles end count=<number of process lines>
//
// The role is the rest of the line (a utility name can hold a space). Two views in one renderer process are two lines with one
// pid. A child the app does not start through Electron (the engine's python, a pty's shell) is in none of the sources: its
// parent's pid is.

export interface IQlProcessRoleInput {
	readonly mainPid: number;

	/** The host window's views; `pid` is `webContents.getOSProcessId()` (0: no process). */
	readonly views: readonly { readonly name: string; readonly pid: number }[];

	/** `UtilityProcess.getAll()`. */
	readonly utilities: readonly { readonly pid: number; readonly name: string }[];

	/** `app.getAppMetrics()`. */
	readonly metrics: readonly { readonly pid: number; readonly type: string; readonly serviceName?: string; readonly name?: string }[];
}

function requirePid(pid: number, what: string): number {
	if (!Number.isInteger(pid) || pid <= 0) {
		throw new Error(`QuantLab host (DRIVER): process roles: ${what} has pid ${String(pid)}`);
	}

	return pid;
}

function requireName(name: string, what: string): string {
	if (typeof name !== 'string' || name.length === 0 || /[\r\n]/.test(name)) {
		throw new Error(`QuantLab host (DRIVER): process roles: ${what} has the name ${JSON.stringify(name)}`);
	}

	return name;
}

export function qlProcessRoleLines(input: IQlProcessRoleInput): string[] {
	const lines: string[] = [];
	const named = new Set<number>();
	const add = (pid: number, role: string): void => {
		named.add(pid);
		lines.push(`process pid=${pid} role=${role}`);
	};

	add(requirePid(input.mainPid, 'the main process'), 'main');

	for (const view of input.views) {
		const name = requireName(view.name, 'a view');
		if (view.pid === 0) {
			lines.push(`process gone role=renderer:${name}`);
		} else {
			add(requirePid(view.pid, `the view ${name}`), `renderer:${name}`);
		}
	}

	for (const utility of input.utilities) {
		const name = requireName(utility.name, 'a utility process');
		add(requirePid(utility.pid, `the utility process ${name}`), `utility:${name}`);
	}

	for (const metric of input.metrics) {
		const type = requireName(metric.type, 'a process metric');
		const pid = requirePid(metric.pid, `the ${type} process`);
		if (named.has(pid)) {
			continue;
		}

		let role = `chromium:${type}`;
		if (metric.serviceName !== undefined) {
			role = `${role}:${requireName(metric.serviceName, `the ${type} process ${pid}'s service`)}`;
		} else if (metric.name !== undefined) {
			role = `${role}:${requireName(metric.name, `the ${type} process ${pid}`)}`;
		}

		add(pid, role);
	}

	return ['process roles begin', ...lines, `process roles end count=${lines.length}`];
}
