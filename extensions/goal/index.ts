import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "goal-state";
const EVENT_NAME = "goal:changed";

type GoalStatus = "active" | "paused" | "complete";

export interface GoalState {
	objective: string;
	validation: string[];
	status: GoalStatus;
	tokenBudget?: number;
	createdAt: number;
	updatedAt: number;
	activeSince?: number;
	accumulatedActiveMs: number;
	baselinePromptTokens: number;
	completedAt?: number;
}

export interface GoalDisplayState extends GoalState {
	usedTokens: number;
	elapsedMs: number;
}

interface PersistedGoalEntry {
	state?: GoalState;
	cleared?: boolean;
}

function compactNumber(value: number): string {
	const safe = Math.max(0, Math.round(value));
	if (safe < 1_000) return String(safe);
	if (safe < 1_000_000) return `${(safe / 1_000).toFixed(safe < 10_000 ? 1 : 0)}K`;
	if (safe < 1_000_000_000) return `${(safe / 1_000_000).toFixed(safe < 10_000_000 ? 1 : 0)}M`;
	return `${(safe / 1_000_000_000).toFixed(1)}B`;
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

export function parseTokenBudget(value: string): number | undefined {
	const normalized = value.trim().replace(/,/g, "").toLowerCase();
	if (!normalized || normalized === "off" || normalized === "none" || normalized === "unlimited") return undefined;
	const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([kmg])?(?:\s*tokens?)?$/);
	if (!match) throw new Error(`Invalid token budget: ${value}`);
	const multiplier = match[2] === "g" ? 1_000_000_000 : match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
	const parsed = Math.round(Number(match[1]) * multiplier);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid token budget: ${value}`);
	return parsed;
}

export function goalDocument(state?: Partial<GoalState>): string {
	const objective = state?.objective?.trim() || "Describe the outcome that must become true.";
	const budget = state?.tokenBudget ? compactNumber(state.tokenBudget) : "off";
	const validation = state?.validation?.length
		? state.validation.map((item) => `- ${item}`).join("\n")
		: "- Add a concrete acceptance criterion.";
	return `# Goal\n${objective}\n\n## Token budget\n${budget}\n\n## Validation\n${validation}\n`;
}

export function parseGoalDocument(document: string): { objective: string; tokenBudget?: number; validation: string[] } {
	const source = document.replace(/\r\n/g, "\n").trim();
	if (!source) throw new Error("Goal objective must not be empty");
	if (!/^#\s+Goal\s*$/im.test(source)) {
		return { objective: source, validation: [] };
	}
	const goalMatch = source.match(/^#\s+Goal\s*\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/im);
	const objective = goalMatch?.[1]?.trim() ?? "";
	if (!objective) throw new Error("Goal objective must not be empty");
	const budgetMatch = source.match(/^##\s+Token budget\s*\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/im);
	const validationMatch = source.match(/^##\s+Validation\s*\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/im);
	const tokenBudget = budgetMatch ? parseTokenBudget(budgetMatch[1].trim().split("\n", 1)[0]) : undefined;
	const validation = (validationMatch?.[1] ?? "")
		.split("\n")
		.map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
		.filter((line) => line && !/^add a concrete acceptance criterion\.?$/i.test(line));
	return { objective, tokenBudget, validation };
}

function promptTokens(entries: readonly any[]): number {
	let total = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const usage = entry.message.usage;
		if (!usage) continue;
		total += Math.max(0, usage.input ?? 0) + Math.max(0, usage.cacheRead ?? 0) + Math.max(0, usage.cacheWrite ?? 0);
	}
	return total;
}

function elapsedMs(state: GoalState, now = Date.now()): number {
	return state.accumulatedActiveMs + (state.status === "active" && state.activeSince ? Math.max(0, now - state.activeSince) : 0);
}

function displayState(state: GoalState, entries: readonly any[], now = Date.now()): GoalDisplayState {
	return {
		...state,
		usedTokens: Math.max(0, promptTokens(entries) - state.baselinePromptTokens),
		elapsedMs: elapsedMs(state, now),
	};
}

export function buildGoalContext(state: GoalState): string {
	const validation = state.validation.length
		? `\nValidation criteria:\n${state.validation.map((item) => `- ${item}`).join("\n")}`
		: "";
	const budget = state.tokenBudget ? `\nToken budget for this goal: ${state.tokenBudget} additional prompt tokens.` : "";
	return `## Active session goal\nThe durable outcome for this session is:\n${state.objective}${validation}${budget}\n\nUse the execution plan for intermediate steps. Do not mark the goal complete until its validation criteria are satisfied. This goal is informational and does not authorize autonomous continuation or unsafe actions.`;
}

function goalLines(state: GoalDisplayState, theme: any): string[] {
	const statusColor = state.status === "active" ? "success" : state.status === "paused" ? "warning" : "muted";
	const lines = [
		`${theme.fg("accent", theme.bold("Goal"))} ${theme.fg(statusColor, state.status)}`,
		"",
		...state.objective.split("\n"),
		"",
		`${theme.fg("dim", "Active time")}  ${formatDuration(state.elapsedMs)}`,
	];
	if (state.tokenBudget) {
		const percent = Math.min(999, (state.usedTokens / state.tokenBudget) * 100);
		lines.push(`${theme.fg("dim", "Token budget")} ${compactNumber(state.usedTokens)} / ${compactNumber(state.tokenBudget)} · ${percent.toFixed(1)}%`);
	} else {
		lines.push(`${theme.fg("dim", "Tokens used")}  ${compactNumber(state.usedTokens)} since goal creation`);
	}
	if (state.validation.length) {
		lines.push("", theme.fg("accent", theme.bold("Validation")));
		for (const item of state.validation) lines.push(`  ○ ${item}`);
	}
	lines.push("", theme.fg("dim", "Commands: /goal edit · /goal pause|resume · /goal complete · /goal clear"));
	return lines;
}

class GoalViewer {
	private scroll = 0;
	private cachedWidth = 0;
	private cachedLines: string[] = [];

	constructor(
		private readonly state: GoalDisplayState,
		private readonly tui: TUI,
		private readonly theme: any,
		private readonly done: (result?: unknown) => void,
	) {}

	private lines(width: number): string[] {
		if (this.cachedWidth === width) return this.cachedLines;
		const lines: string[] = [];
		for (const source of goalLines(this.state, this.theme)) {
			if (!source) { lines.push(""); continue; }
			lines.push(...wrapTextWithAnsi(source, Math.max(1, width)));
		}
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	render(width: number): string[] {
		const max = Math.max(1, width);
		const height = Math.max(9, Math.min(24, (process.stdout.rows || 24) - 6));
		const bodyHeight = height - 1;
		const lines = this.lines(max);
		const maxScroll = Math.max(0, lines.length - bodyHeight);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visible = lines.slice(this.scroll, this.scroll + bodyHeight).map((line) => truncateToWidth(line, max, "…"));
		while (visible.length < bodyHeight) visible.push("");
		return [...visible, truncateToWidth(this.theme.fg("dim", "↑↓ scroll · q close"), max, "")];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") return this.done(undefined);
		if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, Key.down)) this.scroll += 1;
		else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - 8);
		else if (matchesKey(data, Key.pageDown)) this.scroll += 8;
		this.tui.requestRender();
	}

	invalidate(): void { this.cachedWidth = 0; }
}

export default function (pi: ExtensionAPI) {
	let state: GoalState | undefined;
	let activeCtx: any;

	const persist = () => pi.appendEntry(ENTRY_TYPE, state ? { state } satisfies PersistedGoalEntry : { cleared: true } satisfies PersistedGoalEntry);
	const emit = (ctx: any) => {
		activeCtx = ctx;
		const displayed = state ? displayState(state, ctx.sessionManager.getEntries()) : undefined;
		pi.events.emit(EVENT_NAME, displayed);
		if (!displayed || displayed.status === "complete") {
			ctx.ui.setStatus("goal", undefined);
			return;
		}
		const budget = displayed.tokenBudget
			? ` ${Math.min(999, (displayed.usedTokens / displayed.tokenBudget) * 100).toFixed(0)}%`
			: "";
		ctx.ui.setStatus("goal", ctx.ui.theme.fg(displayed.status === "active" ? "success" : "warning", `goal ${displayed.status}${budget}`));
	};
	const saveAndEmit = (ctx: any) => { persist(); emit(ctx); };
	const pauseClock = (now = Date.now()) => {
		if (!state || state.status !== "active") return;
		state.accumulatedActiveMs = elapsedMs(state, now);
		state.activeSince = undefined;
	};
	const setStatus = (next: GoalStatus, ctx: any) => {
		if (!state) return false;
		const now = Date.now();
		if (state.status === "active" && next !== "active") pauseClock(now);
		if (next === "active" && state.status !== "active") state.activeSince = now;
		state.status = next;
		state.updatedAt = now;
		state.completedAt = next === "complete" ? now : undefined;
		saveAndEmit(ctx);
		return true;
	};
	const editGoal = async (ctx: any, initial?: string) => {
		const source = initial ?? goalDocument(state);
		const edited = await ctx.ui.editor(state ? "Edit session goal" : "Set session goal", source);
		if (edited === undefined) return false;
		let parsed: ReturnType<typeof parseGoalDocument>;
		try { parsed = parseGoalDocument(edited); }
		catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return false;
		}
		const now = Date.now();
		if (state) {
			state = { ...state, ...parsed, updatedAt: now };
		} else {
			state = {
				...parsed,
				status: "active",
				createdAt: now,
				updatedAt: now,
				activeSince: now,
				accumulatedActiveMs: 0,
				baselinePromptTokens: promptTokens(ctx.sessionManager.getEntries()),
			};
		}
		saveAndEmit(ctx);
		return true;
	};
	const showGoal = async (ctx: any) => {
		if (!state) {
			ctx.ui.notify("No session goal. Use /goal set <objective> or /goal edit.", "info");
			return;
		}
		const displayed = displayState(state, ctx.sessionManager.getEntries());
		if (ctx.mode !== "tui") {
			ctx.ui.notify(`${displayed.status}: ${displayed.objective}`, "info");
			return;
		}
		await ctx.ui.custom((tui: TUI, theme: any, _kb: any, done: (result: unknown) => void) =>
			new GoalViewer(displayed, tui, theme, done), {
				overlay: true,
				overlayOptions: { width: "76%", maxHeight: "82%", anchor: "center", margin: 1 },
			});
	};

	pi.registerCommand("goal", {
		description: "Set, inspect, pause, resume, complete, or clear the durable session goal",
		handler: async (args, ctx) => {
			const input = args.trim();
			const [command = "show", ...rest] = input.split(/\s+/);
			const value = rest.join(" ").trim();
			switch (command.toLowerCase()) {
				case "show":
					await showGoal(ctx);
					return;
				case "set":
					if (value) {
						const parsed = parseGoalDocument(value);
						const now = Date.now();
						state = {
							...parsed,
							status: "active",
							createdAt: now,
							updatedAt: now,
							activeSince: now,
							accumulatedActiveMs: 0,
							baselinePromptTokens: promptTokens(ctx.sessionManager.getEntries()),
						};
						saveAndEmit(ctx);
						ctx.ui.notify("Session goal set.", "info");
						return;
					}
					await editGoal(ctx);
					return;
				case "edit":
					await editGoal(ctx);
					return;
				case "pause":
					if (!setStatus("paused", ctx)) ctx.ui.notify("No session goal to pause.", "warning");
					return;
				case "resume":
					if (!setStatus("active", ctx)) ctx.ui.notify("No session goal to resume.", "warning");
					return;
				case "complete":
					if (!setStatus("complete", ctx)) ctx.ui.notify("No session goal to complete.", "warning");
					return;
				case "clear": {
					if (!state) { ctx.ui.notify("No session goal to clear.", "info"); return; }
					const confirmed = await ctx.ui.confirm("Clear session goal?", "The append-only history remains, but the goal will no longer be active or shown.");
					if (!confirmed) return;
					state = undefined;
					saveAndEmit(ctx);
					return;
				}
				default:
					ctx.ui.notify("Usage: /goal [show|set <objective>|edit|pause|resume|complete|clear]", "warning");
			}
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!state || state.status !== "active") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildGoalContext(state)}` };
	});

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		state = undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as PersistedGoalEntry | undefined;
			state = data?.cleared ? undefined : data?.state;
		}
		emit(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => emit(ctx));
	pi.on("session_compact", (_event, ctx) => emit(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (state?.status === "active") {
			pauseClock();
			state.updatedAt = Date.now();
			persist();
		}
		pi.events.emit(EVENT_NAME, undefined);
		ctx.ui.setStatus("goal", undefined);
		activeCtx = undefined;
	});

	// If another extension asks for the current goal after its own reload, answer
	// without requiring a session restart.
	pi.events.on("goal:request", () => {
		if (activeCtx) emit(activeCtx);
	});
}
