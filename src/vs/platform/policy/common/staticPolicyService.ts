/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStringDictionary } from '../../../base/common/collections.js';
import { PolicyName } from '../../../base/common/policy.js';
import { AbstractPolicyService, IPolicyService, PolicyDefinition, PolicyValue } from './policy.js';

/**
 * QuantLab host (U7): a policy source with a fixed set of values, given at construction and never changing (the values come from a
 * file inside the app bundle, read once by the caller; the bundle does not change while the app runs, so there is nothing to
 * watch). A value is reported only for a policy some consumer has defined, like every other policy service. Nothing is read or
 * defaulted here: a value whose type does not match its definition throws.
 */
export class StaticPolicyService extends AbstractPolicyService implements IPolicyService {

	constructor(private readonly values: ReadonlyMap<PolicyName, PolicyValue>) {
		super();
	}

	protected async _updatePolicyDefinitions(policyDefinitions: IStringDictionary<PolicyDefinition>): Promise<void> {
		const changed: PolicyName[] = [];

		for (const [name, value] of this.values) {
			const definition = policyDefinitions[name];
			if (!definition) {
				continue;
			}

			if (typeof value !== definition.type) {
				throw new Error(`StaticPolicyService: policy ${name} is defined as ${definition.type} but its value ${JSON.stringify(value)} is a ${typeof value}`);
			}

			if (!this.policies.has(name)) {
				this.policies.set(name, value);
				changed.push(name);
			}
		}

		if (changed.length > 0) {
			this._onDidChange.fire(changed);
		}
	}
}
