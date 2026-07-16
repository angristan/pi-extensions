export const TITLE_STATE_TYPE = "auto-session-title-state-v2";
export const MAX_TITLE_CONTEXT_CHARS = 8_000;
export const MAX_CURRENT_USER_CHARS = 2_000;
export const MAX_CURRENT_ASSISTANT_CHARS = 2_000;
export const MAX_FOCUS_SUMMARY_CHARS = 600;
export const MAX_TURN_SUMMARY_CHARS = 300;
export const MAX_RECENT_TURN_SUMMARIES = 8;
export const MAX_BOOTSTRAP_PRIOR_TURNS = 2;
export const MAX_BOOTSTRAP_MESSAGE_CHARS = 700;

export interface TitleState {
	version: 2;
	turnSummary: string;
	focusSummary: string;
	title: string;
	basedOnLeafId?: string;
	createdAt: string;
}

export interface BootstrapTurn {
	userRequest: string;
	assistantOutcome: string;
}

export interface TitleContext {
	previousFocus?: string;
	recentTurnSummaries: string[];
	bootstrapPriorTurns: BootstrapTurn[];
	currentUserRequest?: string;
	currentAssistantOutcome?: string;
}

export interface TitleModelResponse {
	turnSummary?: string;
	focusSummary?: string;
	title?: string;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function clip(value: string | undefined, maxChars: number): string | undefined {
	if (!value) return undefined;
	const normalized = oneLine(value);
	if (!normalized) return undefined;
	if (normalized.length <= maxChars) return normalized;
	const separator = " … ";
	const headChars = Math.ceil((maxChars - separator.length) * 0.6);
	const tailChars = maxChars - separator.length - headChars;
	return `${normalized.slice(0, headChars).trimEnd()}${separator}${normalized.slice(-tailChars).trimStart()}`;
}

export function messageText(message: any): string | undefined {
	if (typeof message?.content === "string") return message.content.trim() || undefined;
	if (!Array.isArray(message?.content)) return undefined;
	const text = message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
	return text || undefined;
}

function stateFromEntry(entry: any): TitleState | undefined {
	if (entry?.type !== "custom" || entry.customType !== TITLE_STATE_TYPE) return undefined;
	const data = entry.data;
	if (
		data?.version !== 2
		|| typeof data.turnSummary !== "string"
		|| typeof data.focusSummary !== "string"
		|| typeof data.title !== "string"
	) return undefined;
	const turnSummary = clip(data.turnSummary, MAX_TURN_SUMMARY_CHARS);
	const focusSummary = clip(data.focusSummary, MAX_FOCUS_SUMMARY_CHARS);
	const title = oneLine(data.title);
	if (!turnSummary || !focusSummary || !title) return undefined;
	return {
		version: 2,
		turnSummary,
		focusSummary,
		title,
		basedOnLeafId: typeof data.basedOnLeafId === "string" ? data.basedOnLeafId : undefined,
		createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
	};
}

export function titleStates(entries: readonly any[]): TitleState[] {
	return entries.map(stateFromEntry).filter((state): state is TitleState => Boolean(state));
}

export function latestTitleState(entries: readonly any[]): TitleState | undefined {
	return titleStates(entries).at(-1);
}

function completedTurns(entries: readonly any[]): BootstrapTurn[] {
	const turns: BootstrapTurn[] = [];
	let userRequests: string[] = [];
	let assistantOutcomes: string[] = [];
	const flush = () => {
		if (userRequests.length > 0 && assistantOutcomes.length > 0) {
			turns.push({
				userRequest: userRequests.join("\n"),
				assistantOutcome: assistantOutcomes.at(-1)!,
			});
		}
		userRequests = [];
		assistantOutcomes = [];
	};

	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const text = messageText(entry.message);
		if (!text) continue;
		if (entry.message?.role === "user") {
			if (userRequests.length > 0 && assistantOutcomes.length > 0) flush();
			userRequests.push(text);
		} else if (entry.message?.role === "assistant" && userRequests.length > 0) {
			assistantOutcomes.push(text);
		}
	}
	flush();
	return turns;
}

export function buildTitleContext(entries: readonly any[], provisionalUser?: string): TitleContext {
	const states = titleStates(entries);
	let latestStateIndex = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (stateFromEntry(entries[index])) {
			latestStateIndex = index;
			break;
		}
	}

	const messages = entries.slice(latestStateIndex + 1).filter((entry) => entry?.type === "message");
	const userTexts = messages
		.filter((entry) => entry.message?.role === "user")
		.map((entry) => messageText(entry.message))
		.filter((text): text is string => Boolean(text));
	const assistantTexts = messages
		.filter((entry) => entry.message?.role === "assistant")
		.map((entry) => messageText(entry.message))
		.filter((text): text is string => Boolean(text));
	const latestState = states.at(-1);
	const bootstrapTurns = latestState || provisionalUser ? [] : completedTurns(messages).slice(-(MAX_BOOTSTRAP_PRIOR_TURNS + 1));
	const latestBootstrapTurn = bootstrapTurns.at(-1);
	const bootstrapPriorTurns = bootstrapTurns.slice(0, -1).map((turn) => ({
		userRequest: clip(turn.userRequest, MAX_BOOTSTRAP_MESSAGE_CHARS)!,
		assistantOutcome: clip(turn.assistantOutcome, MAX_BOOTSTRAP_MESSAGE_CHARS)!,
	}));

	return {
		previousFocus: clip(latestState?.focusSummary, MAX_FOCUS_SUMMARY_CHARS),
		recentTurnSummaries: states
			.slice(-MAX_RECENT_TURN_SUMMARIES)
			.map((state) => clip(state.turnSummary, MAX_TURN_SUMMARY_CHARS)!)
			.filter(Boolean),
		bootstrapPriorTurns,
		currentUserRequest: clip(
			provisionalUser ?? (latestState ? userTexts.join("\n") : latestBootstrapTurn?.userRequest ?? userTexts.at(-1)),
			MAX_CURRENT_USER_CHARS,
		),
		currentAssistantOutcome: provisionalUser
			? undefined
			: clip(latestState ? assistantTexts.at(-1) : latestBootstrapTurn?.assistantOutcome ?? assistantTexts.at(-1), MAX_CURRENT_ASSISTANT_CHARS),
	};
}

export function titleContextHasContent(context: TitleContext): boolean {
	return Boolean(
		context.currentUserRequest
		|| context.currentAssistantOutcome
		|| context.previousFocus
		|| context.recentTurnSummaries.length > 0
		|| context.bootstrapPriorTurns.length > 0
	);
}

export function buildTitlePrompt(project: string, previousTitle: string | undefined, context: TitleContext): string {
	const prompt = JSON.stringify({
		project: clip(project, 200),
		previous_session_title: clip(previousTitle, 72) ?? null,
		previous_focus: context.previousFocus ?? null,
		recent_turn_summaries: context.recentTurnSummaries,
		bootstrap_prior_turns: context.bootstrapPriorTurns,
		current_user_request: context.currentUserRequest ?? null,
		current_assistant_outcome: context.currentAssistantOutcome ?? null,
	});
	if (prompt.length > MAX_TITLE_CONTEXT_CHARS) throw new Error(`Title context exceeded ${MAX_TITLE_CONTEXT_CHARS} characters.`);
	return prompt;
}

export function parseTitleModelResponse(raw: string): TitleModelResponse {
	const trimmed = raw.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed;
	try {
		const parsed = JSON.parse(fenced);
		if (!parsed || typeof parsed !== "object") return {};
		const turnSummary = parsed.turn_summary ?? parsed.turnSummary;
		const focusSummary = parsed.focus_summary ?? parsed.focusSummary;
		return {
			turnSummary: typeof turnSummary === "string" ? clip(turnSummary, MAX_TURN_SUMMARY_CHARS) : undefined,
			focusSummary: typeof focusSummary === "string" ? clip(focusSummary, MAX_FOCUS_SUMMARY_CHARS) : undefined,
			title: typeof parsed.title === "string" ? oneLine(parsed.title) : undefined,
		};
	} catch {
		// Accept legacy plain-title responses during rollout.
		return { title: oneLine(trimmed) || undefined };
	}
}

export function createTitleState(
	response: Required<Pick<TitleModelResponse, "turnSummary" | "focusSummary" | "title">>,
	basedOnLeafId?: string,
): TitleState {
	return {
		version: 2,
		turnSummary: clip(response.turnSummary, MAX_TURN_SUMMARY_CHARS)!,
		focusSummary: clip(response.focusSummary, MAX_FOCUS_SUMMARY_CHARS)!,
		title: oneLine(response.title),
		basedOnLeafId,
		createdAt: new Date().toISOString(),
	};
}
