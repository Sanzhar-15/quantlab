/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Position } from '../../../../../editor/common/core/position.js';
import type { Location, LocationLink, Definition } from '../../../../../editor/common/languages.js';
import type { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import type { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import type { ToolResultPayload } from '../canonical/types.js';

const MAX_RESULTS = 50;

/**
 * Reference tools (2 tools): get_references, get_definition.
 * Uses VS Code's language feature registries to resolve symbols.
 */
export class ReferenceTools {

	constructor(
		private readonly languageFeaturesService: ILanguageFeaturesService,
		private readonly textModelService: ITextModelService,
		private readonly workspacePath: string,
	) {}

	async getReferences(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const filePath = String(args.path ?? '');
			const line = Number(args.line);
			const column = Number(args.column);

			if (!filePath || !Number.isFinite(line) || !Number.isFinite(column)) {
				return { content: 'Error: path, line, and column are required', isError: true };
			}

			const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(this.workspacePath, filePath);
			const uri = URI.file(resolvedPath);

			// Check if we can resolve this file
			if (!this.textModelService.canHandleResource(uri)) {
				return { content: `Error: Cannot resolve model for ${filePath}. The file may not be open or supported.`, isError: true };
			}

			const modelRef = await this.textModelService.createModelReference(uri);
			try {
				const model = modelRef.object.textEditorModel;
				const pos = new Position(line, column);

				// Get reference providers for this model
				const providers = this.languageFeaturesService.referenceProvider.ordered(model);
				if (providers.length === 0) {
					return { content: `No reference provider available for ${filePath}. Install a language extension for this file type.`, isError: false };
				}

				// Call all providers and merge results
				const allLocations: Location[] = [];
				for (const provider of providers) {
					const refs = await provider.provideReferences(
						model, pos, { includeDeclaration: true }, CancellationToken.None
					);
					if (refs) {
						allLocations.push(...refs);
						if (allLocations.length >= MAX_RESULTS) { break; }
					}
				}

				if (allLocations.length === 0) {
					return { content: `No references found at ${filePath}:${line}:${column}`, isError: false };
				}

				return { content: this.formatLocations(allLocations.slice(0, MAX_RESULTS), 'references'), isError: false };
			} finally {
				modelRef.dispose();
			}
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	async getDefinition(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const filePath = String(args.path ?? '');
			const line = Number(args.line);
			const column = Number(args.column);

			if (!filePath || !Number.isFinite(line) || !Number.isFinite(column)) {
				return { content: 'Error: path, line, and column are required', isError: true };
			}

			const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(this.workspacePath, filePath);
			const uri = URI.file(resolvedPath);

			if (!this.textModelService.canHandleResource(uri)) {
				return { content: `Error: Cannot resolve model for ${filePath}. The file may not be open or supported.`, isError: true };
			}

			const modelRef = await this.textModelService.createModelReference(uri);
			try {
				const model = modelRef.object.textEditorModel;
				const pos = new Position(line, column);

				// Get definition providers for this model
				const providers = this.languageFeaturesService.definitionProvider.ordered(model);
				if (providers.length === 0) {
					return { content: `No definition provider available for ${filePath}. Install a language extension for this file type.`, isError: false };
				}

				// Try providers in order until one succeeds
				for (const provider of providers) {
					const result = await provider.provideDefinition(model, pos, CancellationToken.None);
					if (result) {
						const locations = this.normalizeDefinition(result);
						if (locations.length > 0) {
							return { content: this.formatLocations(locations, 'definition'), isError: false };
						}
					}
				}

				return { content: `No definition found at ${filePath}:${line}:${column}`, isError: false };
			} finally {
				modelRef.dispose();
			}
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	/**
	 * Normalize the Definition type (Location | Location[] | LocationLink[]) to Location[].
	 */
	private normalizeDefinition(def: Definition | LocationLink[]): Location[] {
		if (Array.isArray(def)) {
			return def.map(item => {
				if ('targetSelectionRange' in item || 'originSelectionRange' in item) {
					// LocationLink
					const link = item as LocationLink;
					return { uri: link.uri, range: link.targetSelectionRange ?? link.range };
				}
				return item as Location;
			});
		}
		// Single Location
		return [def as Location];
	}

	/**
	 * Format locations as readable text with file paths and line numbers.
	 */
	private formatLocations(locations: Location[], label: string): string {
		const parts: string[] = [];
		parts.push(`Found ${locations.length} ${label}:\n`);

		// Group by file
		const byFile = new Map<string, Location[]>();
		for (const loc of locations) {
			const filePath = loc.uri.fsPath;
			const relative = filePath.startsWith(this.workspacePath)
				? path.relative(this.workspacePath, filePath)
				: filePath;
			const existing = byFile.get(relative);
			if (existing) {
				existing.push(loc);
			} else {
				byFile.set(relative, [loc]);
			}
		}

		for (const [filePath, locs] of byFile) {
			parts.push(`${filePath}`);
			for (const loc of locs) {
				const startLine = loc.range.startLineNumber;
				const startCol = loc.range.startColumn;
				const endLine = loc.range.endLineNumber;
				const rangeStr = startLine === endLine
					? `L${startLine}:${startCol}`
					: `L${startLine}:${startCol}-L${endLine}`;
				parts.push(`  ${rangeStr}`);
			}
			parts.push('');
		}

		return parts.join('\n');
	}
}
