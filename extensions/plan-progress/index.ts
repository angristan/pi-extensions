import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

type Status = "pending" | "in_progress" | "completed";
interface PlanItem { step: string; status: Status; depth?: number }
interface DraftPlanItem { step: string; status?: Status; depth?: number }
interface PlanState { explanation?: string; items: PlanItem[] }
const LEGACY_OVERLAY_HOST_KEY = "plan-overlay-host";
const LEGACY_WIDGET_KEY = "plan";
const OVERLAY_WIDTH = 58;
const MAX_EXPLANATION_ROWS = 3;
const MAX_PLAN_DEPTH = 8;
const ANSI_RESET = "\x1b[0m";

import { registerOverlayCard } from "../overlay-stack/index.js";

const parameters = {
	type: "object",
	properties: {
		explanation: { type: "string", description: "Optional short explanation for this plan update" },
		plan: {
			type: "array",
			description: "Complete current plan; replace the previous plan with this list",
			items: {
				type: "object",
				properties: {
					step: { type: "string" },
					status: {
						type: "string",
						enum: ["pending", "in_progress", "completed"],
						description: "Required for leaf tasks; omit for parent rows because their status is derived",
					},
					depth: {
						type: "integer",
						minimum: 0,
						maximum: MAX_PLAN_DEPTH,
						description: "Optional nesting depth; defaults to 0 and may increase by at most one per row",
					},
				},
				required: ["step"],
				additionalProperties: false,
			},
		},
	},
	required: ["plan"],
	additionalProperties: false,
} as any;

const VALID_STATUSES: readonly Status[] = ["pending", "in_progress", "completed"];
const VALID_STATUS_SET = new Set<string>(VALID_STATUSES);
const PLAN_GUARD_MARKER = "TODO guard:";

const PROMPT_GUIDELINES = [
	"Use update_plan for meaningful multi-step work. Pass the complete current plan on every update; do not send partial patches.",
	"For nested update_plan lists, order parent rows before their children and set each child's depth to one more than its parent. Omit status on parent rows; parent status and progress are derived from leaf tasks.",
	"Keep exactly one leaf update_plan step in_progress while work remains. Before finalizing, call update_plan so completed work is marked completed; if anything remains pending/in_progress, explain that it is blocked, canceled, or deferred.",
];

function assertNoExtraKeys(value: Record<string, unknown>, allowed: readonly string[], where: string) {
	const allowedSet = new Set(allowed);
	const extras = Object.keys(value).filter((key) => !allowedSet.has(key));
	if (extras.length) throw new Error(`Invalid update_plan payload: unknown ${where} field(s): ${extras.join(", ")}.`);
}

function itemDepth(item: { depth?: number }): number {
	return item.depth ?? 0;
}

function hasChildren(items: Array<{ depth?: number }>, index: number): boolean {
	return index + 1 < items.length && itemDepth(items[index + 1]!) > itemDepth(items[index]!);
}

function subtreeEnd(items: Array<{ depth?: number }>, index: number): number {
	const depth = itemDepth(items[index]!);
	let end = index + 1;
	while (end < items.length && itemDepth(items[end]!) > depth) end++;
	return end;
}

function descendantLeaves(items: PlanItem[], index: number): PlanItem[] {
	const leaves: PlanItem[] = [];
	for (let child = index + 1; child < subtreeEnd(items, index); child++) {
		if (!hasChildren(items, child)) leaves.push(items[child]!);
	}
	return leaves;
}

function derivedStatus(items: PlanItem[], index: number): Status {
	const leaves = descendantLeaves(items, index);
	if (leaves.every((item) => item.status === "completed")) return "completed";
	if (leaves.some((item) => item.status === "in_progress")) return "in_progress";
	return "pending";
}

function normalizePlanItems(rawPlan: unknown): PlanItem[] {
	if (!Array.isArray(rawPlan)) throw new Error("update_plan expects plan to be an array");
	const drafts = rawPlan.map((rawItem, index): DraftPlanItem => {
		if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
			throw new Error(`Invalid update_plan step ${index + 1}: expected an object with step, optional status, and optional depth.`);
		}
		const item = rawItem as Record<string, unknown>;
		assertNoExtraKeys(item, ["step", "status", "depth"], `step ${index + 1}`);
		const step = typeof item.step === "string" ? item.step.trim() : "";
		if (!step) throw new Error(`Invalid update_plan step ${index + 1}: step must be a non-empty string.`);

		const depth = item.depth === undefined ? 0 : item.depth;
		if (!Number.isInteger(depth) || (depth as number) < 0 || (depth as number) > MAX_PLAN_DEPTH) {
			throw new Error(`Invalid update_plan depth for step ${index + 1}: expected an integer from 0 to ${MAX_PLAN_DEPTH}.`);
		}
		if (index === 0 && depth !== 0) {
			throw new Error("Invalid update_plan depth for step 1: the first step must have depth 0.");
		}
		const previousDepth = index > 0 ? itemDepth(rawPlan[index - 1] as { depth?: number }) : 0;
		if ((depth as number) > previousDepth + 1) {
			throw new Error(`Invalid update_plan depth for step ${index + 1}: depth may increase by at most one.`);
		}

		let status: Status | undefined;
		if (item.status !== undefined) {
			if (typeof item.status !== "string" || !VALID_STATUS_SET.has(item.status)) {
				throw new Error(`Invalid update_plan status for step ${index + 1}: ${JSON.stringify(item.status)}. Expected pending, in_progress, or completed.`);
			}
			status = item.status as Status;
		}
		return { step, status, ...(depth === 0 ? {} : { depth: depth as number }) };
	});

	for (let index = 0; index < drafts.length; index++) {
		if (!hasChildren(drafts, index) && !drafts[index]!.status) {
			throw new Error(`Invalid update_plan step ${index + 1}: leaf tasks require a status.`);
		}
	}

	const items = drafts.map((item): PlanItem => ({ ...item, status: item.status ?? "pending" }));
	for (let index = items.length - 1; index >= 0; index--) {
		if (hasChildren(items, index)) items[index]!.status = derivedStatus(items, index);
	}
	return items;
}

function normalizePlanUpdate(params: unknown): PlanState {
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new Error("update_plan expects an object with a plan array.");
	}
	const payload = params as Record<string, unknown>;
	assertNoExtraKeys(payload, ["explanation", "plan"], "top-level");
	const explanation = payload.explanation === undefined
		? undefined
		: typeof payload.explanation === "string"
			? payload.explanation.trim() || undefined
			: (() => { throw new Error("Invalid update_plan payload: explanation must be a string when provided."); })();
	const items = normalizePlanItems(payload.plan);
	validatePlanItems(items, explanation);
	return { explanation, items };
}

function explainsInactiveWork(explanation?: string): boolean {
	return Boolean(explanation && /\b(blocked|deferred|deferring|cancell?ed|cancelled|paused|waiting|needs user|needs approval|cannot proceed|no longer relevant)\b/i.test(explanation));
}

function validatePlanItems(items: PlanItem[], explanation?: string) {
	const stats = planStats(items);
	if (stats.inProgress > 1) throw new Error("Invalid update_plan: only one plan step may be in_progress.");
	if (stats.incomplete > 0 && stats.inProgress === 0 && !explainsInactiveWork(explanation)) {
		throw new Error("Invalid update_plan: unfinished plans must have exactly one in_progress step, unless the explanation says the remaining work is blocked, canceled, paused, or deferred.");
	}
}

function restorePlanState(data: any): PlanState | undefined {
	if (!data || typeof data !== "object" || !Array.isArray(data.items)) return undefined;
	try {
		return {
			explanation: typeof data.explanation === "string" ? data.explanation : undefined,
			items: normalizePlanItems(data.items),
		};
	} catch {
		return undefined;
	}
}

function leafItems(items: PlanItem[]): PlanItem[] {
	return items.filter((_item, index) => !hasChildren(items, index));
}

function planStats(items: PlanItem[]) {
	const tasks = leafItems(items);
	const completed = tasks.filter((item) => item.status === "completed").length;
	const inProgress = tasks.filter((item) => item.status === "in_progress").length;
	const pending = tasks.filter((item) => item.status === "pending").length;
	return { completed, inProgress, pending, total: tasks.length, incomplete: tasks.length - completed };
}

function groupStats(items: PlanItem[], index: number) {
	const tasks = descendantLeaves(items, index);
	const completed = tasks.filter((item) => item.status === "completed").length;
	const inProgress = tasks.filter((item) => item.status === "in_progress").length;
	const pending = tasks.filter((item) => item.status === "pending").length;
	return { completed, inProgress, pending, total: tasks.length, incomplete: tasks.length - completed };
}

function itemPath(items: PlanItem[], index: number): string {
	const path = [items[index]!.step];
	let targetDepth = itemDepth(items[index]!) - 1;
	for (let candidate = index - 1; candidate >= 0 && targetDepth >= 0; candidate--) {
		if (itemDepth(items[candidate]!) !== targetDepth) continue;
		path.unshift(items[candidate]!.step);
		targetDepth--;
	}
	return path.join(" › ");
}

function planGuardText(plan: PlanState): string {
	const stats = planStats(plan.items);
	const examples = plan.items
		.map((item, index) => ({ item, index }))
		.filter(({ item, index }) => !hasChildren(plan.items, index) && item.status !== "completed")
		.slice(0, 3)
		.map(({ item, index }) => `${item.status}: ${itemPath(plan.items, index)}`);
	const suffix = examples.length ? ` Open: ${examples.join("; ")}${stats.incomplete > examples.length ? "; …" : ""}` : "";
	return `${PLAN_GUARD_MARKER} update_plan still has ${stats.incomplete}/${stats.total} unfinished item(s) (${stats.completed}/${stats.total} completed).${suffix} Update the plan before finalizing, or explicitly say why the remaining work is blocked, canceled, or deferred.`;
}

function modelPlanLines(plan: PlanState): string[] {
	const stats = planStats(plan.items);
	const lines = [`Plan updated: ${stats.completed}/${stats.total} tasks completed.`];
	if (plan.explanation?.trim()) lines.push(`Explanation: ${plan.explanation.trim()}`);
	const currentIndex = plan.items.findIndex((item, index) => !hasChildren(plan.items, index) && item.status === "in_progress");
	if (currentIndex >= 0) lines.push(`Current step: ${itemPath(plan.items, currentIndex)}`);
	if (plan.items.length) {
		lines.push("Current plan:");
		for (let index = 0; index < plan.items.length; index++) {
			const item = plan.items[index]!;
			const marker = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]";
			const progress = hasChildren(plan.items, index)
				? (() => { const group = groupStats(plan.items, index); return ` (${group.completed}/${group.total})`; })()
				: "";
			lines.push(`${"  ".repeat(itemDepth(item))}- ${marker} ${item.step}${progress}`);
		}
	} else {
		lines.push("Current plan is empty.");
	}
	if (stats.incomplete === 0) {
		lines.push("All plan steps are complete; the final response can summarize the outcome.");
	} else {
		lines.push("Before finalizing, call update_plan again so completed work is marked completed. If remaining work is blocked, canceled, or deferred, include that in the explanation.");
	}
	return lines;
}

function modelPlanText(plan: PlanState): string {
	return modelPlanLines(plan).join("\n");
}

function planIsFinalizable(plan: PlanState): boolean {
	const stats = planStats(plan.items);
	return stats.incomplete === 0 || explainsInactiveWork(plan.explanation);
}

function assistantText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n");
}

function assistantHasToolCall(message: any): boolean {
	return Array.isArray(message?.content) && message.content.some((block: any) => block?.type === "toolCall");
}

function hasLaterSibling(items: PlanItem[], index: number): boolean {
	const depth = itemDepth(items[index]!);
	for (let candidate = index + 1; candidate < items.length; candidate++) {
		const candidateDepth = itemDepth(items[candidate]!);
		if (candidateDepth < depth) return false;
		if (candidateDepth === depth) return true;
	}
	return false;
}

function ancestorIndexAtDepth(items: PlanItem[], index: number, depth: number): number {
	for (let candidate = index - 1; candidate >= 0; candidate--) {
		if (itemDepth(items[candidate]!) === depth) return candidate;
	}
	return -1;
}

function treePrefixes(items: PlanItem[], index: number): { first: string; continuation: string } {
	const depth = itemDepth(items[index]!);
	let ancestors = "";
	for (let ancestorDepth = 0; ancestorDepth < depth; ancestorDepth++) {
		const ancestorIndex = ancestorIndexAtDepth(items, index, ancestorDepth);
		ancestors += ancestorIndex >= 0 && hasLaterSibling(items, ancestorIndex) ? "│  " : "   ";
	}
	const laterSibling = hasLaterSibling(items, index);
	return {
		first: `  ${ancestors}${laterSibling ? "├─ " : "└─ "}`,
		continuation: `  ${ancestors}${laterSibling ? "│  " : "   "}`,
	};
}

function styledItem(items: PlanItem[], index: number, theme: any): { marker: string; text: string } {
	const item = items[index]!;
	const group = hasChildren(items, index);
	const progress = group
		? (() => { const stats = groupStats(items, index); return theme.fg("dim", ` · ${stats.completed}/${stats.total}`); })()
		: "";
	if (item.status === "completed") {
		return {
			marker: theme.fg("muted", "✓ "),
			text: `${theme.fg("muted", theme.strikethrough(item.step))}${progress}`,
		};
	}
	if (item.status === "in_progress") {
		return {
			marker: theme.fg("accent", theme.bold(group ? "◆ " : "● ")),
			text: `${theme.fg("accent", theme.bold(item.step))}${progress}`,
		};
	}
	return {
		marker: theme.fg("dim", group ? "◇ " : "○ "),
		text: `${theme.fg("muted", item.step)}${progress}`,
	};
}

function planLines(state: PlanState, theme: any): string[] {
	const lines = [`${theme.fg("muted", "•")} ${theme.bold("Updated Plan")}`];
	if (state.explanation?.trim()) lines.push(`  ${theme.fg("dim", theme.italic(state.explanation.trim()))}`);
	for (let index = 0; index < state.items.length; index++) {
		const { first } = treePrefixes(state.items, index);
		const { marker, text } = styledItem(state.items, index, theme);
		lines.push(`${first}${marker}${text}`);
	}
	if (!state.items.length) lines.push(`  └─ ${theme.fg("dim", "(no steps)")}`);
	return lines;
}

function indentedWrap(content: string, width: number, firstPrefix: string, continuationPrefix = firstPrefix): string[] {
	const maxWidth = Math.max(1, width);
	const contentWidth = Math.max(1, maxWidth - visibleWidth(firstPrefix));
	return wrapTextWithAnsi(content, contentWidth).map((line, index) =>
		truncateToWidth(`${index === 0 ? firstPrefix : continuationPrefix}${line}`, maxWidth, ""),
	);
}

function renderedPlanLines(state: PlanState, theme: any, width: number): string[] {
	const maxWidth = Math.max(1, width);
	const lines = [truncateToWidth(`${theme.fg("muted", "•")} ${theme.bold("Updated Plan")}`, maxWidth, "")];
	if (state.explanation?.trim()) {
		lines.push(...indentedWrap(theme.fg("dim", theme.italic(state.explanation.trim())), maxWidth, "  "));
	}
	for (let index = 0; index < state.items.length; index++) {
		const { first, continuation } = treePrefixes(state.items, index);
		const { marker, text } = styledItem(state.items, index, theme);
		lines.push(...indentedWrap(text, maxWidth, `${first}${marker}`, `${continuation}  `));
	}
	if (!state.items.length) lines.push(...indentedWrap(theme.fg("dim", "(no steps)"), maxWidth, "  └─ ", "     "));
	return lines;
}

function sealAnsiLine(line: string, width: number): string {
	if (!line.includes("\x1b") || visibleWidth(line) >= width) return line;
	// Pi's overlay compositor drops trailing ANSI-only resets when extracting a
	// short base line. A neutral cell forces the reset to land before its padding.
	return `${line}${ANSI_RESET} `;
}

class PlanResult implements Component {
	constructor(private readonly state: PlanState, private readonly theme: any) {}

	render(width: number): string[] {
		return renderedPlanLines(this.state, this.theme, width).map((line) => sealAnsiLine(line, width));
	}

	invalidate(): void {}
}

function boundedWrap(content: string, width: number, maxRows: number, theme: any): string[] {
	const wrapped = wrapTextWithAnsi(content, Math.max(1, width));
	if (wrapped.length <= maxRows) return wrapped;
	const visible = wrapped.slice(0, maxRows);
	const last = visible.at(-1) ?? "";
	visible[visible.length - 1] = `${truncateToWidth(last, Math.max(0, width - 1), "")}${theme.fg("dim", "…")}`;
	return visible;
}

function itemRows(items: PlanItem[], index: number, contentWidth: number, theme: any): string[] {
	const { first, continuation } = treePrefixes(items, index);
	const { marker, text } = styledItem(items, index, theme);
	return indentedWrap(text, contentWidth, `${first}${marker}`, `${continuation}  `);
}

function isInsideInactiveGroup(items: PlanItem[], index: number): boolean {
	let targetDepth = itemDepth(items[index]!) - 1;
	for (let candidate = index - 1; candidate >= 0 && targetDepth >= 0; candidate--) {
		if (itemDepth(items[candidate]!) !== targetDepth) continue;
		if (items[candidate]!.status !== "in_progress") return true;
		targetDepth--;
	}
	return false;
}

function renderPlanBody(
	state: PlanState,
	theme: any,
	width: number,
	maxRows: number,
): string[] {
	const contentWidth = Math.max(1, width);
	const body: string[] = [];
	if (state.explanation?.trim()) {
		body.push(...boundedWrap(
			theme.fg("dim", theme.italic(state.explanation.trim())),
			contentWidth,
			MAX_EXPLANATION_ROWS,
			theme,
		));
		body.push("");
	}

	for (let index = 0; index < state.items.length; index++) {
		if (!isInsideInactiveGroup(state.items, index)) body.push(...itemRows(state.items, index, contentWidth, theme));
	}
	if (!state.items.length) body.push(theme.fg("dim", "No active TODOs"));

	const hiddenRows = body.length > maxRows ? body.length - Math.max(0, maxRows - 1) : 0;
	const visibleBody = hiddenRows > 0
		? body.slice(0, Math.max(0, maxRows - 1))
		: body;
	if (hiddenRows > 0) visibleBody.push(theme.fg("dim", `… ${hiddenRows} more row${hiddenRows === 1 ? "" : "s"}; /plan-status for full list`));
	return visibleBody.map((line) => truncateToWidth(line, width, ""));
}

interface PlanProgressDependencies {
	registerOverlayCard?: typeof registerOverlayCard;
}

export default function (pi: ExtensionAPI, dependencies: PlanProgressDependencies = {}) {
	let state: PlanState = { items: [] };
	let planOverlayActive = false;

	const overlayCard = (dependencies.registerOverlayCard ?? registerOverlayCard)({
		id: "plan-progress",
		order: 10,
		width: OVERLAY_WIDTH,
		minBodyHeight: 1,
		minTerminalWidth: 90,
		minTerminalHeight: 10,
		visible: () => {
			const stats = planStats(state.items);
			const activePlan = planOverlayActive && state.items.length > 0 && stats.completed < state.items.length;
			return activePlan;
		},
		title: (theme) => {
			const stats = planStats(state.items);
			return theme.bold(` Plan ${stats.completed}/${stats.total} `);
		},
		renderBody: (width, maxHeight, theme) => renderPlanBody(state, theme, width, maxHeight),
	});
	const persist = () => pi.appendEntry("plan-progress", state);
	const clearLegacyUi = (ctx: any) => {
		ctx.ui.setWidget(LEGACY_WIDGET_KEY, undefined);
		ctx.ui.setWidget(LEGACY_OVERLAY_HOST_KEY, undefined);
	};
	const updateUi = (ctx: any) => {
		clearLegacyUi(ctx);
		overlayCard.invalidate();
		// Keep TODO state visible in the overlay only; the footer is too easy to
		// confuse with a finalization guard and tends to linger visually.
		ctx.ui.setStatus("plan", undefined);
	};

	pi.registerTool({
		name: "update_plan",
		label: "Update Plan",
		description: "Create or update a flat or nested execution plan and mark leaf tasks pending, in progress, or completed.",
		parameters,
		promptGuidelines: PROMPT_GUIDELINES,
		executionMode: "sequential",
		async execute(_id: string, params: any, _signal: AbortSignal, _update: any, ctx: any) {
			state = normalizePlanUpdate(params);
			planOverlayActive = planStats(state.items).incomplete > 0;
			persist();
			updateUi(ctx);
			return {
				content: [{ type: "text", text: modelPlanText(state) }],
				details: state,
			};
		},
		renderCall: () => new Text("", 0, 0),
		renderResult: (result: any, _options: any, theme: any) => {
			const details = restorePlanState(result.details);
			return new PlanResult(details ?? { items: [] }, theme);
		},
		renderShell: "self",
	});

	pi.registerCommand("plan-status", {
		description: "Show the current plan",
		handler: async (_args, ctx) => ctx.ui.notify(state.items.length ? planLines(state, ctx.ui.theme).join("\n") : "No active plan.", "info"),
	});
	pi.registerCommand("plan-clear", {
		description: "Clear the current plan",
		handler: async (_args, ctx) => { state = { items: [] }; planOverlayActive = false; persist(); updateUi(ctx); },
	});

	pi.on("message_end", (event: any, _ctx: any) => {
		// The plan overlay + /plan-status already surface unfinished work; a loud
		// warning notification here was noisy, so the guard is silent now.
		if (event.message?.role !== "assistant") return;
		if (event.message.stopReason === "toolUse" || assistantHasToolCall(event.message)) return;
		if (planIsFinalizable(state)) return;
		if (assistantText(event.message).includes(PLAN_GUARD_MARKER)) return;

		// No visible notification — plan state is shown via the overlay.
	});

	pi.on("agent_settled", (_event: any, ctx: any) => {
		// Keep the canonical plan state for /plan-status and persisted history,
		// but close the active overlay once Pi is no longer working. This mirrors
		// Lifecycle distinction between the plan item and the live widget.
		planOverlayActive = false;
		updateUi(ctx);
	});

	const restoreState = (ctx: any) => {
		clearLegacyUi(ctx);
		state = { items: [] };
		planOverlayActive = false;
		const entries = typeof ctx.sessionManager.getBranch === "function"
			? ctx.sessionManager.getBranch()
			: ctx.sessionManager.getEntries();
		const saved = entries.filter((entry: any) => entry.type === "custom" && entry.customType === "plan-progress").pop() as any;
		const restored = restorePlanState(saved?.data);
		if (restored) state = restored;
		pi.events.emit("goal:request", undefined);
		updateUi(ctx);
	};

	pi.on("session_start", (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", (_event, ctx) => restoreState(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		clearLegacyUi(ctx);
		ctx.ui.setStatus("plan", undefined);
		planOverlayActive = false;
		overlayCard.unregister();
	});
}
