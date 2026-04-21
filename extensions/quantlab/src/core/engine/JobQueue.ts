/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JobRunner } from './JobRunner';

export class JobQueue {
	private readonly jobs = new Map<string, JobRunner>();

	add(jobId: string, runner: JobRunner): void {
		this.jobs.set(jobId, runner);
	}

	remove(jobId: string): void {
		this.jobs.delete(jobId);
	}

	get(jobId: string): JobRunner | undefined {
		return this.jobs.get(jobId);
	}

	has(jobId: string): boolean {
		return this.jobs.has(jobId);
	}

	keys(): string[] {
		return Array.from(this.jobs.keys());
	}
}
