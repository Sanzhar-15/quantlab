/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5: Diff View - Virtual Document Provider
 * Prompt 05-02
 *
 * Provides virtual document content for QIC diff views, allowing the diff editor
 * to show original and modified content without writing to temporary files.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ITextModelService, ITextModelContentProvider } from '../../../../editor/common/services/resolverService.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IQicStateService } from '../common/state/qicStateService.js';
import type { FileChange } from '../common/changes.js';

export const QIC_ORIGINAL_SCHEME = 'qic-original';
export const QIC_MODIFIED_SCHEME = 'qic-modified';

/**
 * Provides virtual document content for QIC diff views.
 * Registers content providers for qic-original:// and qic-modified:// URI schemes.
 */
export class QicDiffDocumentProvider extends Disposable implements ITextModelContentProvider {

	constructor(
		@ITextModelService private readonly textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IQicStateService private readonly stateService: IQicStateService,
	) {
		super();

		// Register content providers for our schemes
		this._register(
			this.textModelService.registerTextModelContentProvider(QIC_ORIGINAL_SCHEME, this)
		);
		this._register(
			this.textModelService.registerTextModelContentProvider(QIC_MODIFIED_SCHEME, this)
		);
	}

	/**
	 * Provide content for virtual documents.
	 * Called when VS Code's diff editor needs content for a qic-original:// or qic-modified:// URI.
	 */
	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const changeId = resource.path.substring(1); // Remove leading /
		const change = this.getChange(changeId);

		// Handle empty document for new/deleted files
		const isEmpty = resource.query === 'empty=true';

		let content: string;

		if (isEmpty) {
			content = '';
		} else if (!change) {
			// Change not found - return empty content with error message
			content = `// Change not found: ${changeId}`;
		} else if (resource.scheme === QIC_ORIGINAL_SCHEME) {
			// Original content (before change)
			content = change.originalContent || '';
		} else {
			// Modified content (after change)
			content = change.newContent || '';
		}

		// Get language from file extension
		const filePath = change?.path || 'file.txt';
		const languageId = this.getLanguageId(filePath);

		// Create and return the model
		const existingModel = this.modelService.getModel(resource);
		if (existingModel) {
			// Update existing model
			existingModel.setValue(content);
			return existingModel;
		}

		// Create new model
		const languageSelection = this.languageService.createById(languageId);
		const model = this.modelService.createModel(content, languageSelection, resource);

		return model;
	}

	/**
	 * Find a change by ID across all change sets.
	 */
	private getChange(changeId: string): FileChange | undefined {
		// Try to get from state service
		const state = this.stateService.state as any;

		// Check conversation.pendingChanges
		const pendingChanges = state.conversation?.pendingChanges?.changes;
		if (pendingChanges && Array.isArray(pendingChanges)) {
			const found = pendingChanges.find((c: FileChange) => c.id === changeId);
			if (found) return found;
		}

		// Check changeSets array if it exists
		const changeSets = state.changeSets;
		if (changeSets && Array.isArray(changeSets)) {
			for (const changeSet of changeSets) {
				const change = changeSet.changes?.find((c: FileChange) => c.id === changeId);
				if (change) return change;
			}
		}

		return undefined;
	}

	/**
	 * Get VS Code language ID from file extension.
	 */
	private getLanguageId(path: string): string {
		const ext = path.split('.').pop()?.toLowerCase() || '';
		const languageMap: Record<string, string> = {
			ts: 'typescript',
			tsx: 'typescriptreact',
			js: 'javascript',
			jsx: 'javascriptreact',
			mjs: 'javascript',
			cjs: 'javascript',
			py: 'python',
			rb: 'ruby',
			go: 'go',
			rs: 'rust',
			java: 'java',
			cs: 'csharp',
			cpp: 'cpp',
			cc: 'cpp',
			c: 'c',
			h: 'c',
			hpp: 'cpp',
			swift: 'swift',
			kt: 'kotlin',
			kts: 'kotlin',
			json: 'json',
			jsonc: 'jsonc',
			yaml: 'yaml',
			yml: 'yaml',
			xml: 'xml',
			html: 'html',
			htm: 'html',
			css: 'css',
			scss: 'scss',
			sass: 'sass',
			less: 'less',
			md: 'markdown',
			sql: 'sql',
			sh: 'shellscript',
			bash: 'shellscript',
			zsh: 'shellscript',
			ps1: 'powershell',
			dockerfile: 'dockerfile',
			makefile: 'makefile',
			vue: 'vue',
			svelte: 'svelte',
			graphql: 'graphql',
			gql: 'graphql',
			toml: 'toml',
			ini: 'ini',
			cfg: 'ini',
			conf: 'ini',
		};
		return languageMap[ext] || 'plaintext';
	}
}
