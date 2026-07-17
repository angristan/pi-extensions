import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

type Status = "pending" | "in_progress" | "completed";
interface PlanItem { step: string; status: Status }
interface PlanState { explanation?: string; items: PlanItem[] }
const LEGACY_OVERLAY_HOST_KEY = "plan-overlay-host";
const LEGACY_WIDGET_KEY = "plan";
const OVERLAY_WIDTH = 58;
const MAX_EXPLANATION_ROWS = 3;

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
					status: { type: "string", enum: ["pending", "in_progress", "completed"] },
				},
				required: ["step", "status"],
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
	"Keep exactly one update_plan step in_progress while work remains. Before finalizing, call update_plan so completed work is marked completed; if anything remains pending/in_progress, explain that it is blocked, canceled, or deferred.",
];

function assertNoExtraKeys(value: Record<string, unknown>, allowed: readonly string[], where: string) {
	const allowedSet = new Set(allowed);
	const extras = Object.keys(value).filter((key) => !allowedSet.has(key));
	if (extras.length) throw new Error(`Invalid update_plan payload: unknown ${where} field(s): ${extras.join(", ")}.`);
}

function normalizePlanItems(rawPlan: unknown): PlanItem[] {
	if (!Array.isArray(rawPlan)) throw new Error("update_plan expects plan to be an array");
	return rawPlan.map((rawItem, index): PlanItem => {
		if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
			throw new Error(`Invalid update_plan step ${index + 1}: expected an object with step and status.`);
		}
		const item = rawItem as Record<string, unknown>;
		assertNoExtraKeys(item, ["step", "status"], `step ${index + 1}`);
		const step = typeof item.step === "string" ? item.step.trim() : "";
		if (!step) throw new Error(`Invalid update_plan step ${index + 1}: step must be a non-empty string.`);
		const status = typeof item.status === "string" ? item.status : "";
		if (!VALID_STATUS_SET.has(status)) {
			throw new Error(`Invalid update_plan status for step ${index + 1}: ${JSON.stringify(item.status)}. Expected pending, in_progress, or completed.`);
		}
		return { step, status: status as Status };
	});
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
	const items = data.items.flatMap((rawItem: any): PlanItem[] => {
		if (!rawItem || typeof rawItem !== "object") return [];
		const step = String(rawItem.step ?? "").trim();
		const status = String(rawItem.status ?? "");
		if (!step || !VALID_STATUS_SET.has(status)) return [];
		return [{ step, status: status as Status }];
	});
	return {
		explanation: typeof data.explanation === "string" ? data.explanation : undefined,
		items,
	};
}

function planStats(items: PlanItem[]) {
	const completed = items.filter((item) => item.status === "completed").length;
	const inProgress = items.filter((item) => item.status === "in_progress").length;
	const pending = items.filter((item) => item.status === "pending").length;
	return { completed, inProgress, pending, total: items.length, incomplete: items.length - completed };
}

function planGuardText(plan: PlanState): string {
	const stats = planStats(plan.items);
	const examples = plan.items
		.filter((item) => item.status !== "completed")
		.slice(0, 3)
		.map((item) => `${item.status}: ${item.step}`);
	const suffix = examples.length ? ` Open: ${examples.join("; ")}${stats.incomplete > examples.length ? "; …" : ""}` : "";
	return `${PLAN_GUARD_MARKER} update_plan still has ${stats.incomplete}/${stats.total} unfinished item(s) (${stats.completed}/${stats.total} completed).${suffix} Update the plan before finalizing, or explicitly say why the remaining work is blocked, canceled, or deferred.`;
}

function modelPlanLines(plan: PlanState): string[] {
	const stats = planStats(plan.items);
	const lines = [`Plan updated: ${stats.completed}/${stats.total} completed.`];
	if (plan.explanation?.trim()) lines.push(`Explanation: ${plan.explanation.trim()}`);
	const current = plan.items.find((item) => item.status === "in_progress");
	if (current) lines.push(`Current step: ${current.step}`);
	if (plan.items.length) {
		lines.push("Current plan:");
		for (const item of plan.items) {
			const marker = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]";
			lines.push(`- ${marker} ${item.step}`);
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

function systemPlanContext(plan: PlanState): string | undefined {
	if (!plan.items.length || planIsFinalizable(plan)) return undefined;
	return `Current update_plan state from the previous active plan:\n${modelPlanLines(plan).join("\n")}\nIf this plan is no longer relevant, call update_plan with an empty or completed plan and explain why.`;
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

function planLines(state: PlanState, theme: any): string[] {
	const lines = [`${theme.fg("muted", "•")} ${theme.bold("Updated Plan")}`];
	if (state.explanation?.trim()) lines.push(`  ${theme.fg("dim", theme.italic(state.explanation.trim()))}`);
	for (const item of state.items) {
		if (item.status === "completed") {
			lines.push(`  └ ${theme.fg("muted", "✓ ")}${theme.fg("muted", theme.strikethrough(item.step))}`);
		} else if (item.status === "in_progress") {
			lines.push(`  └ ${theme.fg("accent", theme.bold("● "))}${theme.fg("accent", theme.bold(item.step))}`);
		} else {
			lines.push(`  └ ${theme.fg("dim", "○ ")}${theme.fg("muted", item.step)}`);
		}
	}
	if (!state.items.length) lines.push(`  └ ${theme.fg("dim", "(no steps)")}`);
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
	for (const item of state.items) {
		let marker: string;
		let step: string;
		if (item.status === "completed") {
			marker = theme.fg("muted", "✓ ");
			step = theme.fg("muted", theme.strikethrough(item.step));
		} else if (item.status === "in_progress") {
			marker = theme.fg("accent", theme.bold("● "));
			step = theme.fg("accent", theme.bold(item.step));
		} else {
			marker = theme.fg("dim", "○ ");
			step = theme.fg("muted", item.step);
		}
		lines.push(...indentedWrap(step, maxWidth, `  └ ${marker}`, "      "));
	}
	if (!state.items.length) lines.push(...indentedWrap(theme.fg("dim", "(no steps)"), maxWidth, "  └ ", "    "));
	return lines;
}

class PlanResult implements Component {
	constructor(private readonly state: PlanState, private readonly theme: any) {}

	render(width: number): string[] {
		return renderedPlanLines(this.state, this.theme, width);
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

function itemRows(item: PlanItem, contentWidth: number, theme: any): string[] {
	let marker: string;
	let step: string;
	if (item.status === "completed") {
		marker = theme.fg("muted", "✓ ");
		step = theme.fg("muted", theme.strikethrough(item.step));
	} else if (item.status === "in_progress") {
		marker = theme.fg("accent", theme.bold("● "));
		step = theme.fg("accent", theme.bold(item.step));
	} else {
		marker = theme.fg("dim", "○ ");
		step = theme.fg("muted", item.step);
	}
	const wrapped = wrapTextWithAnsi(step, Math.max(1, contentWidth - 2));
	return wrapped.map((line, index) => `${index === 0 ? marker : "  "}${line}`);
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

	for (const item of state.items) body.push(...itemRows(item, contentWidth, theme));
	if (!state.items.length) body.push(theme.fg("dim", "No active TODOs"));

	const hiddenRows = Math.max(0, body.length - maxRows);
	const visibleBody = hiddenRows > 0
		? body.slice(0, Math.max(0, maxRows - 1))
		: body;
	if (hiddenRows > 0) visibleBody.push(theme.fg("dim", `… ${hiddenRows} more row${hiddenRows === 1 ? "" : "s"}; /plan-status for full list`));
	return visibleBody.map((line) => truncateToWidth(line, width, ""));
}

export default function (pi: ExtensionAPI) {
	let state: PlanState = { items: [] };
	let activeCtx: any;
	let planOverlayActive = false;

	const overlayCard = registerOverlayCard({
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
			return theme.bold(` Plan ${stats.completed}/${state.items.length} `);
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
		description: "Create or update the current execution plan and mark steps pending, in progress, or completed.",
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

	pi.on("before_agent_start", (event: any) => {
		const context = systemPlanContext(state);
		if (!context) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
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
		// Keep the canonical plan state for /plan-status and future model context,
		// but close the active overlay once Pi is no longer working. This mirrors
		// Lifecycle distinction between the plan item and the live widget.
		planOverlayActive = false;
		updateUi(ctx);
	});

	const restoreState = (ctx: any) => {
		activeCtx = ctx;
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
		activeCtx = undefined;
		planOverlayActive = false;
		overlayCard.unregister();
	});
}
