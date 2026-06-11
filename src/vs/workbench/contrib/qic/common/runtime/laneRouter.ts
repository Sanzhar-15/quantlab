/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LaneName } from '../canonical/lanes.js';
import type { ConversationState } from '../state/conversationState.js';

// Explicit user directives
const DIRECTIVE_MAP: Record<string, LaneName> = {
	'/ask': 'chat-ask',
	'/edit': 'chat-act',
	'/plan': 'chat-plan',
	'/gather': 'chat-gather',
	'/apply': 'fast-apply',
	'/fix': 'repair',
};

// Patterns that suggest tool-use lanes (checked BEFORE plan/gather/question patterns)
const TOOL_USE_PATTERNS = [
	// Broad creation verb + "file" anywhere nearby (catches "create a txt file", "create an empty file", etc.)
	/\b(create|write|make|generate|build)\b.{0,40}\bfile\b/i,
	// Specific file/code object after verb -- allows modifiers between article and noun
	/\b(create|write|modify|update|delete|remove|rename|move)\s+(a\s+|an\s+|the\s+)?(\w+\s+)*(file|directory|folder|class|function|method)/i,
	// "write/create/build me a ..." -- imperative creation with indirect object
	/\b(create|write|build|make|generate|implement|develop|code)\s+me\s+(a|an|the|my)\b/i,
	// "write/create a ... in/to my folder/project/src" -- creation targeting a path
	/\b(create|write|build|save|generate|add)\b.{0,60}\b(in|to|into|under|at)\s+(my|the|this)\s+(project|folder|directory|workspace|repo)/i,
	// "write/create a ... .py/.js/.ts" -- creation targeting a file extension
	/\b(create|write|build|generate|make)\b.{0,60}\.(py|js|ts|jsx|tsx|css|html|json|yaml|yml|sql|sh|bash|rb|go|rs|java|cpp|c|h|md|txt|csv|ipynb)\b/i,
	// "write a <thing>" -- imperative creation verb + article + noun (anchored to start)
	/^(create|write|build|make|generate|implement|develop|code|set\s+up)\s+(a|an|the|my)\s+/i,
	// Run/execute commands
	/\b(run|execute)\s+(a\s+|the\s+)?(command|test|script|build)/i,
	// Refactor/implement as standalone verbs
	/\b(refactor|implement)\b/i,
	// Add/fix specific things
	/\b(add|fix)\s+(a\s+|the\s+|this\s+)?(bug|feature|function|method|class|test|endpoint|route|handler|component|import|dependency|style|error|issue|type|interface|validation)/i,
	// Apply changes
	/\bapply\s+(this|the|these)\s+(change|edit|fix)/i,
	// Implicit file creation -- mentions a file extension (e.g. "a txt file", "an empty .py file", "yo.txt")
	/\b(file|script|module|component|page)\s+called\b/i,
	/\.(py|js|ts|jsx|tsx|css|html|json|yaml|yml|sql|sh|bash|rb|go|rs|java|cpp|c|h|md|txt|csv|ipynb)\b/i,
	// Imperative without explicit verb -- "a new file", "an empty file", "empty txt file".
	// Definite-article references ("the new module") are mentions of existing
	// things, not creation requests -- without the lookbehind this pattern
	// hijacked planning messages like "plan the architecture for the new
	// module" into chat-act (the laneRouter.test regression).
	/(?<!\bthe\s+)\b(a|an|empty|new|blank)\s+(empty\s+|new\s+|blank\s+)?(file|script|module|class|component|page|directory|folder)\b/i,
	// "save this/that as", "put this in a file"
	/\b(save|put|store|dump)\s+(this|that|it).{0,30}\b(file|as)\b/i,
	// "change X to Y", "replace X with Y", "set X to Y" -- edit intent
	/\b(change|replace|swap|set)\s+.{1,60}\s+(to|with|from)\b/i,
];

// Question-style patterns
const QUESTION_PATTERNS = [
	/^(what|how|why|where|when|which|who|is|are|can|could|should|would|does|do|did|will|has|have)\b/i,
	/\?$/,
	/\b(explain|describe|tell me|help me understand)\b/i,
];

// Planning patterns -- only match when intent is clearly planning, not creating
const PLAN_PATTERNS = [
	/\b(plan|design|architect|outline|propose)\s+(a|an|the|my|this|how|for)\b/i,
	/\bhow (should|would|could) (I|we)\b/i,
	/\b(what|which)\s+(strategy|approach)\s+(should|would|could|to)\b/i,
];

// Gather patterns
const GATHER_PATTERNS = [
	/\b(find|search|look for|show me|list|where is|locate)\b/i,
	/\b(what files|which files|codebase|repository)\b/i,
];

/**
 * Lane router -- classifies user messages into the 8-lane system (Audit S-2).
 * Priority: explicit directive > tool-use > plan > gather > question > context > default.
 */
export class LaneRouter {

	classify(message: string, conversationState: ConversationState): LaneName {
		const trimmed = message.trim();

		// 1. Explicit user directive (highest priority)
		const firstWord = trimmed.split(/\s+/)[0];
		if (firstWord && DIRECTIVE_MAP[firstWord.toLowerCase()]) {
			const lane = DIRECTIVE_MAP[firstWord.toLowerCase()];
			// allow-any-unicode-next-line
			console.log(`[LaneRouter] Directive match: "${firstWord}" → ${lane}`);
			return lane;
		}

		// 2. Tool-use patterns -> chat-act
		for (let i = 0; i < TOOL_USE_PATTERNS.length; i++) {
			if (TOOL_USE_PATTERNS[i].test(trimmed)) {
				// allow-any-unicode-next-line
				console.log(`[LaneRouter] Tool-use pattern #${i} matched: ${TOOL_USE_PATTERNS[i]} → chat-act | msg="${trimmed.slice(0, 80)}"`);
				return 'chat-act';
			}
		}

		// 3. Planning patterns -> chat-plan
		for (const pattern of PLAN_PATTERNS) {
			if (pattern.test(trimmed)) {
				// allow-any-unicode-next-line
				console.log(`[LaneRouter] Plan pattern matched → chat-plan | msg="${trimmed.slice(0, 80)}"`);
				return 'chat-plan';
			}
		}

		// 4. Gather patterns -> chat-gather
		for (const pattern of GATHER_PATTERNS) {
			if (pattern.test(trimmed)) {
				// allow-any-unicode-next-line
				console.log(`[LaneRouter] Gather pattern matched → chat-gather | msg="${trimmed.slice(0, 80)}"`);
				return 'chat-gather';
			}
		}

		// 5. Question patterns -> chat-ask
		for (const pattern of QUESTION_PATTERNS) {
			if (pattern.test(trimmed)) {
				// allow-any-unicode-next-line
				console.log(`[LaneRouter] Question pattern matched → chat-ask | msg="${trimmed.slice(0, 80)}"`);
				return 'chat-ask';
			}
		}

		// 6. Context-based -- if conversation is in a specific lane, stay in it
		const currentLane = conversationState.getLane();
		if (currentLane && currentLane !== 'completion' && currentLane !== 'summarize') {
			console.log(`[LaneRouter] Context-based: staying in ${currentLane} | msg="${trimmed.slice(0, 80)}"`);
			return currentLane;
		}

		// 7. Default
		// allow-any-unicode-next-line
		console.log(`[LaneRouter] Default → chat-ask | msg="${trimmed.slice(0, 80)}"`);
		return 'chat-ask';
	}
}
