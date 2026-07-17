import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerOverlayCard } from "../overlay-stack/index.js";

// ============================================================================
// Constants
// ============================================================================

const ENTRY_TYPE = "goal-state";
const EVENT_NAME = "goal:changed";
const CONTINUATION_CUSTOM_TYPE = "goal-continuation";

/**
 * Status lifecycle mirrors a persistent-objective goal system:
 * active → (pause) → paused → (resume) → active
 * active → (complete, evidence-backed) → complete
 * active → (interrupted by user) → paused
 */
type GoalStatus = "active" | "paused" | "complete";

export interface GoalState {
	objective: string;
	validation: string[];
	/** Optional shell command that must exit 0 before the goal can be completed. */
	verify?: string;
	status: GoalStatus;
	createdAt: number;
	updatedAt: number;
	activeSince?: number;
	accumulatedActiveMs: number;
	completedAt?: number;
	/** Continuation accounting for the auto-loop. */
	continuations: number;
	lastContinuationAt?: number;
}

export interface GoalDisplayState extends GoalState {
	elapsedMs: number;
}

interface PersistedGoalEntry {
	state?: GoalState;
	cleared?: boolean;
}

// ============================================================================
// Formatting helpers
// ============================================================================

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

// ============================================================================
// Goal document (markdown) — schema extended with `## Verify`
// ============================================================================

export function goalDocument(state?: Partial<GoalState>): string {
	const objective = state?.objective?.trim() || "Describe the outcome that must become true.";
	const verify = state?.verify?.trim() || "off";
	const validation = state?.validation?.length
		? state.validation.map((item) => `- ${item}`).join("\n")
		: "- Add a concrete acceptance criterion.";
	return `# Goal\n${objective}\n\n## Verify\n${verify}\n\n## Validation\n${validation}\n`;
}

export interface ParsedGoalDocument {
	objective: string;
	verify?: string;
	validation: string[];
}

export function parseGoalDocument(document: string): ParsedGoalDocument {
	const source = document.replace(/\r\n/g, "\n").trim();
	if (!source) throw new Error("Goal objective must not be empty");
	if (!/^#\s+Goal\s*$/im.test(source)) {
		return { objective: source, validation: [] };
	}
	const goalMatch = source.match(/^#\s+Goal\s*\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/im);
	const objective = goalMatch?.[1]?.trim() ?? "";
	if (!objective) throw new Error("Goal objective must not be empty");
	const section = (header: string) =>
		source.match(new RegExp(`^##\\s+${header}\\s*\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "im"))?.[1] ?? "";
	const verifyRaw = section("Verify").trim().split("\n", 1)[0];
	const verify = verifyRaw && !/^off$/i.test(verifyRaw) ? verifyRaw : undefined;
	const validation = (section("Validation"))
		.split("\n")
		.map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
		.filter((line) => line && !/^add a concrete acceptance criterion\.?$/i.test(line));
	return { objective, verify, validation };
}

function elapsedMs(state: GoalState, now = Date.now()): number {
	return state.accumulatedActiveMs + (state.status === "active" && state.activeSince ? Math.max(0, now - state.activeSince) : 0);
}

function displayState(state: GoalState, now = Date.now()): GoalDisplayState {
	return {
		...state,
		elapsedMs: elapsedMs(state, now),
	};
}

function normalizeStatus(status: unknown): GoalStatus {
	if (status === "active" || status === "complete") return status;
	return "paused";
}

// ============================================================================
// System prompt injection: orient the agent around the objective
// ============================================================================

export function buildGoalContext(state: GoalState): string {
	const validation = state.validation.length
		? `\nValidation criteria:\n${state.validation.map((item) => `- ${item}`).join("\n")}`
		: "";
	const verify = state.verify
		? `\nA verification command is configured and MUST exit 0 before this goal can be marked complete:\n  $ ${state.verify}`
		: "";
	return `## Active session goal\nThe durable outcome for this session is:\n${state.objective}${validation}${verify}\n\nUse the execution plan for intermediate steps. Do not mark the goal complete until its validation criteria are satisfied AND verified against concrete evidence (files changed, commands run, tests passed, artifacts produced). If no valid path remains, stop and report the blocker instead of declaring success.`;
}

/**
 * The silent continuation prompt sent at each safe boundary (agent_settled).
 * Re-orients the agent around the objective and requires an evidence audit
 * before completion.
 */
function continuationPrompt(state: GoalState): string {
	const verifyLine = state.verify ? `\nRemember: the verify command \`${state.verify}\` must exit 0 before completion.` : "";
	const validationList = state.validation.length
		? state.validation.map((v, i) => `  ${i + 1}. ${v}`).join("\n")
		: "  - (no explicit criteria — judge against the objective)";
	return `[Goal continuation — turn ${state.continuations + 1}]\nThe active goal is:\n${state.objective}\n\nValidation criteria:\n${validationList}${verifyLine}\n\nContinue working toward this goal. Before declaring it complete, audit it against concrete evidence (files changed, commands run, tests passed, build/benchmark output, generated artifacts). If it is complete and verified, call the \`goal_complete\` tool with per-criterion evidence. If you are blocked or no valid path remains, call \`goal_block\` instead. Do not just summarize — either make progress or report a blocker.`;
}

// ============================================================================
// Overlay rendering (kept compatible with plan-progress subscriber)
// ============================================================================

function statusColor(status: GoalStatus): "success" | "warning" | "muted" {
	return status === "active" ? "success" : status === "paused" ? "warning" : "muted";
}

function goalLines(state: GoalDisplayState, theme: any): string[] {
	const lines = [
		...state.objective.split("\n"),
		"",
		`${theme.fg("dim", "Active time")}  ${formatDuration(state.elapsedMs)}`,
	];
	lines.push(`${theme.fg("dim", "Continuations")}  ${state.continuations}`);
	if (state.verify) lines.push(`${theme.fg("dim", "Verify")}  $ ${state.verify}`);
	if (state.validation.length) {
		lines.push("", theme.fg("accent", theme.bold("Validation")));
		for (const item of state.validation) lines.push(`  ○ ${item}`);
	}
	lines.push("", theme.fg("dim", "/goal [<objective>|clear|edit|pause|resume]"));
	return lines;
}




// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
	let state: GoalState | undefined;
	let activeCtx: any;
	// Did the most recent assistant turn (that we observed via message_end)
	// make at least one tool call? Anti-spin rule: if a continuation turn made
	// no tool call, suppress the next auto-continuation.
	let lastTurnHadToolCall = false;
	// Was the most recent assistant turn the result of a goal continuation
	// prompt we injected? Used by the anti-spin guard.
	let lastTurnWasContinuation = false;

	// Dedicated overlay card so the goal renders as its own box, separate from
	// the plan-progress card. order 5 places it above the plan card (order 10).
	const goalCard = registerOverlayCard({
		id: "goal",
		order: 5,
		width: 58,
		minBodyHeight: 3,
		minTerminalWidth: 90,
		minTerminalHeight: 10,
		visible: () => Boolean(state && state.status !== "complete"),
		title: (theme: any) => {
			if (!state) return "";
			// Goal stays white; only the status word is colored.
			return theme.bold(` Goal ${theme.fg(statusColor(state.status), state.status)} `);
		},
		renderBody: (width: number, maxHeight: number, theme: any) => {
			if (!state) return [];
			const displayed = displayState(state);
			const lines: string[] = [];
			for (const source of goalLines(displayed, theme)) {
				if (!source) { lines.push(""); continue; }
				lines.push(...wrapTextWithAnsi(source, Math.max(1, width)));
			}
			// Size to content — do NOT pad to maxHeight, or the card balloons.
			return lines.map((line) => truncateToWidth(line, width, "…"));
		},
	});

	const branchEntries = (ctx: any): readonly any[] => typeof ctx.sessionManager.getBranch === "function"
		? ctx.sessionManager.getBranch()
		: ctx.sessionManager.getEntries();

	const persist = () => pi.appendEntry(ENTRY_TYPE, state ? { state } satisfies PersistedGoalEntry : { cleared: true } satisfies PersistedGoalEntry);

	const emit = (ctx: any) => {
		activeCtx = ctx;
		goalCard.invalidate();
		const displayed = state ? displayState(state) : undefined;
		pi.events.emit(EVENT_NAME, displayed);
		// The dedicated overlay card is the source of truth for goal status now;
		// keep the footer clear.
		ctx.ui.setStatus("goal", undefined);
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
		let parsed: ParsedGoalDocument;
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
				continuations: 0,
			};
		}
		saveAndEmit(ctx);
		return true;
	};

	const showGoal = async (ctx: any) => {
		if (!state) {
			ctx.ui.notify("Usage: /goal [<objective>|clear|edit|pause|resume]\nNo goal is currently set.", "info");
			return;
		}
		// The always-on overlay card already shows full goal state; /goal just
		// confirms the status briefly so it doesn't open a redundant modal.
		const displayed = displayState(state);
		ctx.ui.notify(`${displayed.status}: ${displayed.objective}`, "info");
	};

	// ------------------------------------------------------------------------
	// Continuation loop primitives
	// ------------------------------------------------------------------------

	/** Send a silent continuation prompt that triggers a new turn. */
	const sendContinuation = (ctx: any, prompt: string) => {
		lastTurnWasContinuation = true;
		pi.sendMessage(
			{ customType: CONTINUATION_CUSTOM_TYPE, content: prompt, display: false, details: { continuation: true } },
			{ triggerTurn: true },
		);
	};

	/**
	 * Decide whether to auto-continue at a safe boundary (agent_settled).
	 * Conservative dispatcher rules:
	 *  - goal must be active
	 *  - thread must be idle (not streaming)
	 *  - no pending user input queued
	 *  - anti-spin: the last continuation turn must have made a tool call
	 *  - the previous turn must not have been aborted (interruption → pause)
	 */
	const maybeContinue = (ctx: any): boolean => {
		if (!state || state.status !== "active") return false;
		if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return false;
		if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) return false;

		// Interruption → pause: if the last assistant turn was aborted, the user
		// interrupted us. Pause the goal so it doesn't immediately resume.
		// (agent_settled already implies the run is over; this catches Esc-aborts.)
		// The abort detection is done in message_end below; if we got here with
		// lastTurnWasContinuation true but lastTurnHadToolCall false, it's a spin.

		// Anti-spin: a continuation turn that produced no tool call means the
		// model has nothing actionable to do — stop the loop.
		if (lastTurnWasContinuation && !lastTurnHadToolCall) {
			ctx.ui.notify("Goal: last continuation made no tool call — pausing auto-continuation. Use /goal resume to continue.", "warning");
			setStatus("paused", ctx);
			return false;
		}

		state.continuations += 1;
		state.lastContinuationAt = Date.now();
		saveAndEmit(ctx);
		sendContinuation(ctx, continuationPrompt(state));
		return true;
	};

	// ------------------------------------------------------------------------
	// Commands
	// ------------------------------------------------------------------------

	pi.registerCommand("goal", {
		description: "Set, inspect, pause, resume, complete, or clear the durable session goal. Usage: /goal [<objective>|clear|edit|pause|resume|complete]",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) { await showGoal(ctx); return; }
			const [command = ""] = input.split(/\s+/);
			const sub = command.toLowerCase();
			// Subcommands with fixed meaning.
			switch (sub) {
				case "pause":
					if (!setStatus("paused", ctx)) ctx.ui.notify("No session goal to pause.", "warning");
					return;
				case "resume":
					if (!setStatus("active", ctx)) ctx.ui.notify("No session goal to resume.", "warning");
					else {
						// Reset anti-spin flags so a fresh resume isn't immediately
						// re-paused by the stale "last turn had no tool call" state.
						lastTurnWasContinuation = false;
						lastTurnHadToolCall = false;
						maybeContinue(ctx);
					}
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
				case "edit":
					await editGoal(ctx);
					// If we just created the goal via the editor, kick the loop.
					if (state && state.status === "active" && state.continuations === 0) {
						maybeContinue(ctx);
					}
					return;
			}
			// Default: treat the whole input as the objective: `/goal <objective>`.
			const parsed = parseGoalDocument(input);
			const now = Date.now();
			state = {
				...parsed,
				status: "active",
				createdAt: now,
				updatedAt: now,
				activeSince: now,
				accumulatedActiveMs: 0,
				continuations: 0,
			};
			saveAndEmit(ctx);
			ctx.ui.notify("Session goal set. Auto-continuation is active.", "info");
			// Kick the first continuation turn immediately.
			maybeContinue(ctx);
		},
	});

	// ------------------------------------------------------------------------
	// System prompt injection
	// ------------------------------------------------------------------------

	pi.on("before_agent_start", (event) => {
		if (!state || state.status !== "active") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildGoalContext(state)}` };
	});

	// ------------------------------------------------------------------------
	// Loop event wiring
	// ------------------------------------------------------------------------

	// Track tool-call activity per turn for the anti-spin rule.
	pi.on("tool_execution_end", () => { lastTurnHadToolCall = true; });

	pi.on("message_end", (event, _ctx) => {
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		// Detect interruption → pause the goal (interruption pauses the loop).
		if (msg.stopReason === "aborted" && state && state.status === "active") {
			// Defer to avoid mutating state mid-emit; use a microtask.
			queueMicrotask(() => {
				if (state && state.status === "active") {
					setStatus("paused", activeCtx);
					activeCtx?.ui?.notify("Goal paused: agent run was interrupted.", "warning");
				}
			});
		}
	});

	// The safe-boundary continuation point: agent fully settled, no retry,
	// no compaction, no queued work will run.
	pi.on("agent_settled", (_event, ctx) => {
		maybeContinue(ctx);
	});

	// If compaction runs, re-emit so the overlay stays accurate.
	pi.on("session_compact", (_event, ctx) => emit(ctx));

	// ------------------------------------------------------------------------
	// State persistence / restore
	// ------------------------------------------------------------------------

	const restoreState = (ctx: any) => {
		activeCtx = ctx;
		state = undefined;
		lastTurnHadToolCall = false;
		lastTurnWasContinuation = false;
		for (const entry of branchEntries(ctx)) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as PersistedGoalEntry | undefined;
			if (data?.cleared || !data?.state) {
				state = undefined;
				continue;
			}
			const restored = data.state as GoalState & Record<string, unknown>;
			state = {
				objective: typeof restored.objective === "string" ? restored.objective : "",
				validation: Array.isArray(restored.validation) ? [...restored.validation] : [],
				verify: typeof restored.verify === "string" ? restored.verify : undefined,
				status: normalizeStatus(restored.status),
				createdAt: typeof restored.createdAt === "number" ? restored.createdAt : Date.now(),
				updatedAt: typeof restored.updatedAt === "number" ? restored.updatedAt : Date.now(),
				activeSince: typeof restored.activeSince === "number" ? restored.activeSince : undefined,
				accumulatedActiveMs: typeof restored.accumulatedActiveMs === "number" ? restored.accumulatedActiveMs : 0,
				completedAt: typeof restored.completedAt === "number" ? restored.completedAt : undefined,
				continuations: typeof restored.continuations === "number" ? restored.continuations : 0,
				lastContinuationAt: typeof restored.lastContinuationAt === "number" ? restored.lastContinuationAt : undefined,
			};
		}
		emit(ctx);
	};

	pi.on("session_start", (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", (_event, ctx) => restoreState(ctx));
	pi.on("agent_settled", (_event, ctx) => emit(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (state?.status === "active") {
			pauseClock();
			state.updatedAt = Date.now();
			persist();
		}
		pi.events.emit(EVENT_NAME, undefined);
		ctx.ui.setStatus("goal", undefined);
		activeCtx = undefined;
		goalCard.unregister();
	});

	// If another extension asks for the current goal after its own reload, answer
	// without requiring a session restart.
	pi.events.on("goal:request", () => {
		if (activeCtx) emit(activeCtx);
	});

	// ------------------------------------------------------------------------
	// goal_complete / goal_block tools (evidence-based completion)
	// ------------------------------------------------------------------------

	const evidenceSchema = Type.Object({
		criterion: Type.String({ description: "The validation criterion being evidenced (copy the exact text)." }),
		evidence: Type.String({ description: "Concrete evidence: files changed, commands run, test/benchmark output, artifact path. Be specific." }),
	});

	pi.registerTool({
		name: "goal_complete",
		label: "Complete Goal",
		description:
			"Mark the active session goal as complete. Only call this when the objective is fully satisfied AND every validation criterion has concrete evidence. If a verify command is configured, it will be run and MUST exit 0. Do not call this speculatively.",
		parameters: Type.Object({
			evidence: Type.Array(evidenceSchema, {
				description: "One evidence entry per validation criterion. If there are no validation criteria, provide one entry summarizing the evidence for the objective.",
			}),
			summary: Type.String({ description: "One-line summary of what was accomplished." }),
		}),
		renderCall: () => new Text("", 0, 0),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state) {
				return { content: [{ type: "text", text: "No active session goal." }], details: { ok: false } };
			}
			if (state.status !== "active") {
				return { content: [{ type: "text", text: `Goal is ${state.status}, not active. Resume it before completing.` }], details: { ok: false } };
			}
			// Evidence audit: require one entry per validation criterion.
			const criteria = state.validation.length ? state.validation : ["(objective)"];
			const provided = Array.isArray(params.evidence) ? params.evidence : [];
			const missing = criteria.filter((c) => !provided.some((p: any) => p.criterion && c.trim().toLowerCase().includes(p.criterion.trim().toLowerCase()) || p.criterion?.trim().toLowerCase() === c.trim().toLowerCase()));
			if (missing.length) {
				return {
					content: [{ type: "text", text: `Evidence audit failed. Missing evidence for:\n${missing.map((m) => `- ${m}`).join("\n")}\n\nProvide one evidence entry per validation criterion (copy the exact criterion text).` }],
					details: { ok: false, missing },
				};
			}
			// Hard gate: run the verify command if configured.
			if (state.verify) {
				ctx.ui.notify(`Goal: running verify command: $ ${state.verify}`, "info");
				try {
					const result = await pi.exec("sh", ["-c", state.verify], { cwd: ctx.cwd, timeout: 5 * 60_000 });
					if (result.code !== 0) {
						setStatus("paused", ctx);
						return {
							content: [{ type: "text", text: `Verify command FAILED (exit ${result.code}):\n$ ${state.verify}\n\n--- stdout ---\n${result.stdout.slice(-2000)}\n--- stderr ---\n${result.stderr.slice(-2000)}\n\nGoal NOT completed. Fix the failure and call goal_complete again, or call goal_block if blocked.` }],
							details: { ok: false, verifyCode: result.code },
						};
					}
				} catch (err) {
					setStatus("paused", ctx);
					return {
						content: [{ type: "text", text: `Verify command failed to run: ${err instanceof Error ? err.message : String(err)}\n\nGoal NOT completed.` }],
						details: { ok: false, error: String(err) },
					};
				}
			}
			setStatus("complete", ctx);
			ctx.ui.notify(`Goal complete: ${params.summary ?? state.objective}`, "info");
			return {
				content: [{ type: "text", text: `Goal marked complete.\nObjective: ${state.objective}\nSummary: ${params.summary ?? "(none)"}\nEvidence:\n${provided.map((p: any) => `- ${p.criterion}: ${p.evidence}`).join("\n")}` }],
				details: { ok: true },
			};
		},
	});

	pi.registerTool({
		name: "goal_block",
		label: "Report Goal Blocked",
		description:
			"Report that the active goal cannot be completed and no valid path remains under current limits. Stops the auto-continuation loop and pauses the goal. Use when blocked by missing data, failing dependencies, or unreachable conditions.",
		parameters: Type.Object({
			blocker: Type.String({ description: "What is preventing completion." }),
			attempted: Type.String({ description: "What was attempted." }),
			evidence: Type.String({ description: "Concrete evidence of the blocker (error output, missing file, failing test, etc.)." }),
			next_input: Type.String({ description: "What input or change would unlock progress." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state) {
				return { content: [{ type: "text", text: "No active session goal." }], details: { ok: false } };
			}
			setStatus("paused", ctx);
			ctx.ui.notify("Goal paused: blocked. See tool result for details.", "warning");
			return {
				content: [{ type: "text", text: `Goal blocked and paused.\n\nBlocker: ${params.blocker}\nAttempted: ${params.attempted}\nEvidence: ${params.evidence}\nNext input needed: ${params.next_input}\n\nResume with /goal resume once unblocked.` }],
				details: { ok: true, blocked: true },
			};
		},
	});
}
