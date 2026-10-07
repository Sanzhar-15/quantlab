/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStringDictionary } from '../../../base/common/collections.js';
import { Event } from '../../../base/common/event.js';
import { PolicyName } from '../../../base/common/policy.js';
import { ILogService } from '../../log/common/log.js';
import { AbstractPolicyService, IPolicyService, PolicyDefinition, PolicyValue } from './policy.js';

/**
 * QuantLab host (U7): one policy service over an ordered list of policy services, FIRST wins.
 *
 *  - a policy's value is the first member's value that has one; a later member's value for the same policy is passed over (and
 *    logged once when it differs), a policy no earlier member has passes through from the later member unchanged;
 *  - `policyDefinitions` are forwarded to every member;
 *  - `onDidChange` fires with the names whose combined value changed, after any member's change (a change that a first member's
 *    value hides does not fire);
 *  - a member that fails to take the definitions fails `updatePolicyDefinitions`: nothing is caught here.
 *
 * Members are not owned: whoever created them disposes them.
 */
export class CombinedPolicyService extends AbstractPolicyService implements IPolicyService {

	private readonly loggedShadowed = new Set<PolicyName>();

	constructor(
		private readonly members: ReadonlyArray<IPolicyService>,
		private readonly logService: ILogService
	) {
		super();

		if (members.length === 0) {
			throw new Error('CombinedPolicyService: no member policy services');
		}

		this._register(Event.any(...members.map(member => member.onDidChange))(() => this.refresh()));
	}

	protected async _updatePolicyDefinitions(policyDefinitions: IStringDictionary<PolicyDefinition>): Promise<void> {
		await Promise.all(this.members.map(member => member.updatePolicyDefinitions(policyDefinitions)));
		this.refresh();
	}

	private refresh(): void {
		const next = new Map<PolicyName, PolicyValue>();

		for (const name of Object.keys(this.policyDefinitions)) {
			for (const member of this.members) {
				const value = member.getPolicyValue(name);
				if (value === undefined) {
					continue;
				}

				if (next.has(name)) {
					if (next.get(name) !== value && !this.loggedShadowed.has(name)) {
						this.loggedShadowed.add(name);
						this.logService.warn(`CombinedPolicyService: policy ${name} is set by more than one source with different values; the first source's value ${JSON.stringify(next.get(name))} wins over ${JSON.stringify(value)}`);
					}
				} else {
					next.set(name, value);
				}
			}
		}

		const changed: PolicyName[] = [];
		for (const name of new Set([...this.policies.keys(), ...next.keys()])) {
			if (this.policies.get(name) !== next.get(name)) {
				changed.push(name);
			}
		}

		this.policies = next;

		if (changed.length > 0) {
			this._onDidChange.fire(changed);
		}
	}
}
