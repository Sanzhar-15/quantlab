/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../../../base/common/cancellation.js';
import { StopWatch } from '../../../../../../../base/common/stopwatch.js';
import { isPatternInWord } from '../../../../../../../base/common/filters.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { ResourceSet } from '../../../../../../../base/common/map.js';
import { Schemas } from '../../../../../../../base/common/network.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../../base/common/uuid.js';
import { ICodeEditor, getCodeEditor, isCodeEditor } from '../../../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../../../editor/browser/services/codeEditorService.js';
import { Position } from '../../../../../../../editor/common/core/position.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import { IWordAtPosition, getWordAtText } from '../../../../../../../editor/common/core/wordHelper.js';
import { CompletionContext, CompletionItem, CompletionItemKind, CompletionList, DocumentSymbol, Location, ProviderResult, SymbolKind, SymbolKinds } from '../../../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../../../../editor/common/services/languageFeatures.js';
import { IOutlineModelService } from '../../../../../../../editor/contrib/documentSymbols/browser/outlineModel.js';
import { localize } from '../../../../../../../nls.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { FileKind } from '../../../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../../../platform/label/common/label.js';
import { Registry } from '../../../../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../../../../common/contributions.js';
import { EditorsOrder, isDiffEditorInput } from '../../../../../../common/editor.js';
import { IEditorService } from '../../../../../../services/editor/common/editorService.js';
import { IHistoryService } from '../../../../../../services/history/common/history.js';
import { LifecyclePhase } from '../../../../../../services/lifecycle/common/lifecycle.js';
import { ISearchService } from '../../../../../../services/search/common/search.js';
import { IMcpService } from '../../../../../mcp/common/mcpTypes.js';
import { searchFilesAndFolders } from '../../../../../search/browser/searchChatContext.js';
import { IChatAgentNameService, IChatAgentService } from '../../../../common/participants/chatAgents.js';
import { IChatEditingService } from '../../../../common/editing/chatEditingService.js';
import { chatVariableLeader } from '../../../../common/requestParser/chatParserTypes.js';
import { IChatSlashCommandService } from '../../../../common/participants/chatSlashCommands.js';
import { IDynamicVariable } from '../../../../common/attachments/chatVariables.js';
import { ChatAgentLocation, ChatModeKind, isSupportedChatFileScheme } from '../../../../common/constants.js';
import { IPromptsService } from '../../../../common/promptSyntax/service/promptsService.js';
import { IChatWidget, IChatWidgetService } from '../../../chat.js';

class SlashCommandCompletions extends Disposable {
	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IChatWidgetService chatWidgetService: IChatWidgetService,
		@IChatSlashCommandService chatSlashCommandService: IChatSlashCommandService,
		@IPromptsService promptsService: IPromptsService,
		@IMcpService mcpService: IMcpService,
	) {
		super();
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(SlashCommandCompletions, LifecyclePhase.Eventually);

class AgentCompletions extends Disposable {
	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IChatAgentNameService chatAgentNameService: IChatAgentNameService,
	) {
		super();
	}

}
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(AgentCompletions, LifecyclePhase.Eventually);


class ReferenceArgument {
	constructor(
		readonly widget: IChatWidget,
		readonly variable: IDynamicVariable
	) { }
}

interface IVariableCompletionsDetails {
	model: ITextModel;
	position: Position;
	context: CompletionContext;
	widget: IChatWidget;
	range: IChatCompletionRangeResult;
}

class BuiltinDynamicCompletions extends Disposable {
	private static readonly addReferenceCommand = '_addReferenceCmd';
	private static readonly VariableNameDef = new RegExp(`${chatVariableLeader}[\\w:-]*`, 'g'); // MUST be using `g`-flag


	constructor(
		@IHistoryService private readonly historyService: IHistoryService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISearchService private readonly searchService: ISearchService,
		@ILabelService private readonly labelService: ILabelService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IChatWidgetService chatWidgetService: IChatWidgetService,
		@IChatEditingService private readonly _chatEditingService: IChatEditingService,
		@IOutlineModelService private readonly outlineService: IOutlineModelService,
		@IEditorService private readonly editorService: IEditorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		// File/Folder completions in one go and m
		const fileWordPattern = new RegExp(`${chatVariableLeader}[^\\s]*`, 'g');
		this.registerVariableCompletions('fileAndFolder', async ({ widget, range }, token) => {
			if (!widget.supportsFileReferences) {
				return;
			}

			const result: CompletionList = { suggestions: [] };

			// If locked to an agent that doesn't support file attachments, skip
			if (widget.lockedAgentId) {
				const agent = this.chatAgentService.getAgent(widget.lockedAgentId);
				if (agent && !agent.capabilities?.supportsFileAttachments) {
					return result;
				}
			}
			await this.addFileAndFolderEntries(widget, result, range, token);
			return result;

		}, fileWordPattern);

		// Selection completion
		this.registerVariableCompletions('selection', ({ widget, range }, token) => {
			if (!widget.supportsFileReferences) {
				return;
			}

			if (widget.location === ChatAgentLocation.EditorInline) {
				return;
			}

			const active = this.findActiveCodeEditor();
			if (!isCodeEditor(active)) {
				return;
			}

			const currentResource = active.getModel()?.uri;
			const currentSelection = active.getSelection();
			if (!currentSelection || !currentResource || currentSelection.isEmpty()) {
				return;
			}

			const basename = this.labelService.getUriBasenameLabel(currentResource);
			const text = `${chatVariableLeader}file:${basename}:${currentSelection.startLineNumber}-${currentSelection.endLineNumber}`;
			const fullRangeText = `:${currentSelection.startLineNumber}:${currentSelection.startColumn}-${currentSelection.endLineNumber}:${currentSelection.endColumn}`;
			const description = this.labelService.getUriLabel(currentResource, { relative: true }) + fullRangeText;

			const result: CompletionList = { suggestions: [] };
			result.suggestions.push({
				label: { label: `${chatVariableLeader}selection`, description },
				filterText: `${chatVariableLeader}selection`,
				insertText: range.varWord?.endColumn === range.replace.endColumn ? `${text} ` : text,
				range,
				kind: CompletionItemKind.Text,
				sortText: 'z',
				command: {
					id: BuiltinDynamicCompletions.addReferenceCommand, title: '', arguments: [new ReferenceArgument(widget, {
						id: 'vscode.selection',
						isFile: true,
						range: { startLineNumber: range.replace.startLineNumber, startColumn: range.replace.startColumn, endLineNumber: range.replace.endLineNumber, endColumn: range.replace.startColumn + text.length },
						data: { range: currentSelection, uri: currentResource } satisfies Location
					})]
				}
			});
			return result;
		});

		// Symbol completions
		this.registerVariableCompletions('symbol', ({ widget, range, position, model }, token) => {
			if (!widget.supportsFileReferences) {
				return null;
			}

			const result: CompletionList = { suggestions: [] };
			const range2 = computeCompletionRanges(model, position, new RegExp(`${chatVariableLeader}[^\\s]*`, 'g'), true);
			if (range2) {
				this.addSymbolEntries(widget, result, range2, token);
			}

			return result;
		});
	}

	private findActiveCodeEditor(): ICodeEditor | undefined {
		const codeEditor = this.codeEditorService.getActiveCodeEditor();
		if (codeEditor) {
			const model = codeEditor.getModel();
			if (model?.uri.scheme === Schemas.vscodeNotebookCell) {
				return undefined;
			}

			if (model) {
				return codeEditor;
			}
		}
		for (const codeOrDiffEditor of this.editorService.getVisibleTextEditorControls(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
			const codeEditor = getCodeEditor(codeOrDiffEditor);
			if (!codeEditor) {
				continue;
			}

			const model = codeEditor.getModel();
			if (model) {
				return codeEditor;
			}
		}
		return undefined;
	}

	private registerVariableCompletions(debugName: string, provider: (details: IVariableCompletionsDetails, token: CancellationToken) => ProviderResult<CompletionList>, wordPattern: RegExp = BuiltinDynamicCompletions.VariableNameDef) {
	}

	private cacheKey?: { key: string; time: number };

	private async addFileAndFolderEntries(widget: IChatWidget, result: CompletionList, info: { insert: Range; replace: Range; varWord: IWordAtPosition | null }, token: CancellationToken) {

		const makeCompletionItem = (resource: URI, kind: FileKind, description?: string, boostPriority?: boolean): CompletionItem => {
			const basename = this.labelService.getUriBasenameLabel(resource);
			const text = `${chatVariableLeader}file:${basename}`;
			const uriLabel = this.labelService.getUriLabel(resource, { relative: true });
			const labelDescription = description
				? localize('fileEntryDescription', '{0} ({1})', uriLabel, description)
				: uriLabel;
			// keep files above other completions
			const sortText = boostPriority ? ' ' : '!';

			return {
				label: { label: basename, description: labelDescription },
				filterText: `${chatVariableLeader}${basename}`,
				insertText: info.varWord?.endColumn === info.replace.endColumn ? `${text} ` : text,
				range: info,
				kind: kind === FileKind.FILE ? CompletionItemKind.File : CompletionItemKind.Folder,
				sortText,
				command: {
					id: BuiltinDynamicCompletions.addReferenceCommand, title: '', arguments: [new ReferenceArgument(widget, {
						id: resource.toString(),
						isFile: kind === FileKind.FILE,
						isDirectory: kind === FileKind.FOLDER,
						range: { startLineNumber: info.replace.startLineNumber, startColumn: info.replace.startColumn, endLineNumber: info.replace.endLineNumber, endColumn: info.replace.startColumn + text.length },
						data: resource
					})]
				}
			};
		};

		let pattern: string | undefined;
		if (info.varWord?.word && info.varWord.word.startsWith(chatVariableLeader)) {
			pattern = info.varWord.word.toLowerCase().slice(1); // remove leading #
		}

		const seen = new ResourceSet();
		const len = result.suggestions.length;

		// HISTORY
		// always take the last N items
		for (const [i, item] of this.historyService.getHistory().entries()) {
			const resource = isDiffEditorInput(item) ? item.modified.resource : item.resource;
			if (!resource || seen.has(resource) || !this.instantiationService.invokeFunction(accessor => isSupportedChatFileScheme(accessor, resource.scheme))) {
				// ignore editors without a resource
				continue;
			}

			if (pattern) {
				// use pattern if available
				const basename = this.labelService.getUriBasenameLabel(resource).toLowerCase();
				if (!isPatternInWord(pattern, 0, pattern.length, basename, 0, basename.length)) {
					continue;
				}
			}

			seen.add(resource);
			const newLen = result.suggestions.push(makeCompletionItem(resource, FileKind.FILE, i === 0 ? localize('activeFile', 'Active file') : undefined, i === 0));
			if (newLen - len >= 5) {
				break;
			}
		}

		// RELATED FILES
		if (widget.input.currentModeKind !== ChatModeKind.Ask && widget.viewModel && widget.viewModel.model.editingSession) {
			const relatedFiles = (await raceTimeout(this._chatEditingService.getRelatedFiles(widget.viewModel.sessionResource, widget.getInput(), widget.attachmentModel.fileAttachments, token), 200)) ?? [];
			for (const relatedFileGroup of relatedFiles) {
				for (const relatedFile of relatedFileGroup.files) {
					if (!seen.has(relatedFile.uri)) {
						seen.add(relatedFile.uri);
						result.suggestions.push(makeCompletionItem(relatedFile.uri, FileKind.FILE, relatedFile.description));
					}
				}
			}
		}

		// SEARCH
		// use file search when having a pattern
		if (pattern) {

			const cacheKey = this.updateCacheKey();
			const workspaces = this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri);

			for (const workspace of workspaces) {
				const { folders, files } = await searchFilesAndFolders(workspace, pattern, true, token, cacheKey.key, this.configurationService, this.searchService);
				for (const file of files) {
					if (!seen.has(file)) {
						result.suggestions.push(makeCompletionItem(file, FileKind.FILE));
						seen.add(file);
					}
				}
				for (const folder of folders) {
					if (!seen.has(folder)) {
						result.suggestions.push(makeCompletionItem(folder, FileKind.FOLDER));
						seen.add(folder);
					}
				}
			}
		}

		// mark results as incomplete because further typing might yield
		// in more search results
		result.incomplete = true;
	}

	private addSymbolEntries(widget: IChatWidget, result: CompletionList, info: { insert: Range; replace: Range; varWord: IWordAtPosition | null }, token: CancellationToken) {
		const timeoutMs = 100;
		const stopwatch = new StopWatch();

		const makeSymbolCompletionItem = (symbolItem: { name: string; location: Location; kind: SymbolKind }, pattern: string): CompletionItem => {
			const text = `${chatVariableLeader}sym:${symbolItem.name}`;
			const resource = symbolItem.location.uri;
			const uriLabel = this.labelService.getUriLabel(resource, { relative: true });
			const sortText = pattern ? '{' /* after z */ : '|' /* after { */;

			return {
				label: { label: symbolItem.name, description: uriLabel },
				filterText: `${chatVariableLeader}${symbolItem.name}`,
				insertText: info.varWord?.endColumn === info.replace.endColumn ? `${text} ` : text,
				range: info,
				kind: SymbolKinds.toCompletionKind(symbolItem.kind),
				sortText,
				command: {
					id: BuiltinDynamicCompletions.addReferenceCommand, title: '', arguments: [new ReferenceArgument(widget, {
						id: `vscode.symbol/${JSON.stringify(symbolItem.location)}`,
						fullName: symbolItem.name,
						range: { startLineNumber: info.replace.startLineNumber, startColumn: info.replace.startColumn, endLineNumber: info.replace.endLineNumber, endColumn: info.replace.startColumn + text.length },
						data: symbolItem.location,
						icon: SymbolKinds.toIcon(symbolItem.kind)
					})]
				}
			};
		};

		let pattern: string | undefined;
		if (info.varWord?.word && info.varWord.word.startsWith(chatVariableLeader)) {
			pattern = info.varWord.word.toLowerCase().slice(1); // remove leading #
		}

		const symbolsToAdd: { symbol: DocumentSymbol; uri: URI }[] = [];
		for (const outlineModel of this.outlineService.getCachedModels()) {
			const symbols = outlineModel.asListOfDocumentSymbols();
			for (const symbol of symbols) {
				symbolsToAdd.push({ symbol, uri: outlineModel.uri });
			}
		}

		let timedOut = false;

		for (const symbol of symbolsToAdd) {
			if (stopwatch.elapsed() > timeoutMs || token.isCancellationRequested) {
				timedOut = true;
				break;
			}
			result.suggestions.push(makeSymbolCompletionItem({ ...symbol.symbol, location: { uri: symbol.uri, range: symbol.symbol.range } }, pattern ?? ''));
		}

		result.incomplete = !!pattern || timedOut;
	}

	private updateCacheKey() {
		if (this.cacheKey && Date.now() - this.cacheKey.time > 60000) {
			this.searchService.clearCache(this.cacheKey.key);
			this.cacheKey = undefined;
		}

		if (!this.cacheKey) {
			this.cacheKey = {
				key: generateUuid(),
				time: Date.now()
			};
		}

		this.cacheKey.time = Date.now();

		return this.cacheKey;
	}

}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(BuiltinDynamicCompletions, LifecyclePhase.Eventually);

export interface IChatCompletionRangeResult {
	insert: Range;
	replace: Range;
	varWord: IWordAtPosition | null;
}

export function computeCompletionRanges(model: ITextModel, position: Position, reg: RegExp, onlyOnWordStart = false): IChatCompletionRangeResult | undefined {
	const varWord = getWordAtText(position.column, reg, model.getLineContent(position.lineNumber), 0);
	if (!varWord && model.getWordUntilPosition(position).word) {
		// inside a "normal" word
		return;
	}

	if (!varWord && position.column > 1) {
		const textBefore = model.getValueInRange(new Range(position.lineNumber, position.column - 1, position.lineNumber, position.column));
		if (textBefore !== ' ') {
			return;
		}
	}

	if (varWord && onlyOnWordStart) {
		const wordBefore = model.getWordUntilPosition({ lineNumber: position.lineNumber, column: varWord.startColumn });
		if (wordBefore.word) {
			// inside a word
			return;
		}
	}

	let insert: Range;
	let replace: Range;
	if (!varWord) {
		insert = replace = Range.fromPositions(position);
	} else {
		insert = new Range(position.lineNumber, varWord.startColumn, position.lineNumber, position.column);
		replace = new Range(position.lineNumber, varWord.startColumn, position.lineNumber, varWord.endColumn);
	}

	return { insert, replace, varWord };
}


class ToolCompletions extends Disposable {


	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IChatWidgetService chatWidgetService: IChatWidgetService,
		@IChatAgentService chatAgentService: IChatAgentService,
	) {
		super();
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(ToolCompletions, LifecyclePhase.Eventually);
