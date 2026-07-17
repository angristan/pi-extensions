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
const BLOCKED_AUDIT_THRESHOLD = 3;

/**
 * Status lifecycle mirrors a persistent-objective goal system:
 * active → (pause) → paused → (resume) → active
 * active → (blocked audit threshold) → blocked → (resume) → active
 * active → (complete, evidence-backed) → complete
 * active → (interrupted by user) → paused
 */
type GoalStatus = "active" | "paused" | "blocked" | "complete";

interface BlockedAudit {
	fingerprint: string;
	count: number;
	blocker: string;
	attempted: string;
	evidence: string;
	nextInput: string;
	lastReportedAt: number;
}

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
	blockedAt?: number;
	blockedAudit?: BlockedAudit;
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
	if (status === "active" || status === "blocked" || status === "complete") return status;
	return "paused";
}

function normalizeBlockerText(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function blockerFingerprint(blocker: string, nextInput: string): string {
	return `${normalizeBlockerText(blocker)}\n${normalizeBlockerText(nextInput)}`;
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
	return `## Active session goal\nThe durable outcome for this session is:\n${state.objective}${validation}${verify}\n\nUse the execution plan for intermediate steps. Do not mark the goal complete until its validation criteria are satisfied AND verified against concrete evidence (files changed, commands run, tests passed, artifacts produced). If no valid path remains, use goal_block only after the same blocking condition has recurred across the blocked audit threshold; do not declare the goal blocked merely because the work is hard, slow, uncertain, or would benefit from clarification.`;
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
	return `[Goal continuation — turn ${state.continuations + 1}]\nThe active goal is:\n${state.objective}\n\nValidation criteria:\n${validationList}${verifyLine}\n\nContinuation behavior:\n- Keep the full objective intact; do not redefine success around a smaller or easier task.\n- Use the current worktree and external state as authoritative; inspect current state before relying on memory.\n- If update_plan is available and the next work is meaningfully multi-step, keep the plan tied to the real objective.\n\nCompletion audit:\nBefore declaring the goal complete, audit it against concrete evidence (files changed, commands run, tests passed, build/benchmark output, generated artifacts). If it is complete and verified, call \`goal_complete\` with per-criterion evidence.\n\nBlocked audit:\n- Do not call \`goal_block\` the first time a blocker appears.\n- Call \`goal_block\` only when the same blocking condition has repeated for at least ${BLOCKED_AUDIT_THRESHOLD} consecutive goal turns and no meaningful progress is possible without user input or an external-state change.\n- Never use blocked merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.\n\nDo not just summarize — either make progress, complete with evidence, or report a repeated blocker.`;
}

// ============================================================================
// Overlay rendering (kept compatible with plan-progress subscriber)
// ============================================================================

function statusColor(status: GoalStatus): "success" | "warning" | "muted" | "error" {
	return status === "active" ? "success" : status === "paused" ? "warning" : status === "blocked" ? "error" : "muted";
}

function goalLines(state: GoalDisplayState, theme: any): string[] {
	const lines = [
		...state.objective.split("\n"),
		"",
		`${theme.fg("dim", "Active time")}  ${formatDuration(state.elapsedMs)}`,
	];
	lines.push(`${theme.fg("dim", "Continuations")}  ${state.continuations}`);
	if (state.status === "blocked" && state.blockedAudit) {
		lines.push(`${theme.fg("dim", "Blocked")}  ${state.blockedAudit.blocker}`);
		lines.push(`${theme.fg("dim", "Next")}     ${state.blockedAudit.nextInput}`);
	}
	if (state.verify) lines.push(`${theme.fg("dim", "Verify")}  $ ${state.verify}`);
	if (state.validation.length) {
		lines.push("", theme.fg("accent", theme.bold("Validation")));
		for (const item of state.validation) lines.push(`  ○ ${item}`);
	}
	lines.push("", theme.fg("dim", "/goal [<objective>|clear|edit|pause|resume|block]"));
	return lines;
}




// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
	let state: GoalState | undefined;
	let activeCtx: any;
	let nextTurnIsContinuation = false;
	let currentTurnIsContinuation = false;
	let currentTurnHadToolCall = false;
	let currentTurnCalledGoalBlock = false;
	let lastTurnWasContinuation = false;
	let lastTurnHadToolCall = false;
	let lastTurnCalledGoalBlock = false;
	let noToolContinuationStreak = 0;

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
		if (next === "active" && state.status !== "active") {
			state.activeSince = now;
			state.blockedAt = undefined;
			state.blockedAudit = undefined;
			noToolContinuationStreak = 0;
		}
		if (next === "blocked" && !state.blockedAudit) {
			state.blockedAudit = {
				fingerprint: "manual-block",
				count: BLOCKED_AUDIT_THRESHOLD,
				blocker: "Marked blocked manually.",
				attempted: "The user ran /goal block.",
				evidence: "/goal block",
				nextInput: "Resume the goal when there is actionable work again.",
				lastReportedAt: now,
			};
		}
		state.status = next;
		state.updatedAt = now;
		state.blockedAt = next === "blocked" ? now : state.blockedAt;
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
			ctx.ui.notify("Usage: /goal [<objective>|clear|edit|pause|resume|block]\nNo goal is currently set.", "info");
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
		nextTurnIsContinuation = true;
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
	 *  - anti-spin: repeated no-tool continuations mark the goal blocked
	 *  - the previous turn must not have been aborted (interruption → pause)
	 */
	const maybeContinue = (ctx: any): boolean => {
		if (!state || state.status !== "active") return false;
		if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return false;
		if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) return false;

		// Interruption → pause is detected in message_end below.
		// Any goal turn that does not report a blocker breaks the consecutive
		// blocker audit. This keeps the threshold tied to repeated blocker reports,
		// not merely repeated turns.
		if (!lastTurnCalledGoalBlock && state.blockedAudit) state.blockedAudit = undefined;

		if (lastTurnHadToolCall) {
			noToolContinuationStreak = 0;
		} else if (lastTurnWasContinuation) {
			noToolContinuationStreak += 1;
			if (noToolContinuationStreak >= BLOCKED_AUDIT_THRESHOLD) {
				state.blockedAudit = {
					fingerprint: "no-tool-continuation",
					count: noToolContinuationStreak,
					blocker: `The last ${noToolContinuationStreak} goal continuation turns made no tool calls.`,
					attempted: "Automatic goal continuation prompts were sent at safe idle boundaries.",
					evidence: "No tool execution was observed during those continuation turns.",
					nextInput: "Give a more specific next step, adjust the goal, or resume if there is actionable work to perform.",
					lastReportedAt: Date.now(),
				};
				ctx.ui.notify("Goal blocked: repeated continuations made no tool calls.", "warning");
				setStatus("blocked", ctx);
				return false;
			}
		} else {
			noToolContinuationStreak = 0;
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
		description: "Set, inspect, pause, resume, block, complete, or clear the durable session goal. Usage: /goal [<objective>|clear|edit|pause|resume|block|complete]",
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
						// Reset loop-audit flags so a fresh resume starts a new
						// blocked audit.
						lastTurnWasContinuation = false;
						lastTurnHadToolCall = false;
						lastTurnCalledGoalBlock = false;
						noToolContinuationStreak = 0;
						maybeContinue(ctx);
					}
					return;
				case "block":
				case "blocked":
					if (!setStatus("blocked", ctx)) ctx.ui.notify("No session goal to block.", "warning");
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

	// Track per-turn activity for the loop guard. A continuation that repeatedly
	// produces no tool calls is treated as a blocker instead of spinning forever.
	pi.on("turn_start", () => {
		currentTurnIsContinuation = nextTurnIsContinuation;
		nextTurnIsContinuation = false;
		currentTurnHadToolCall = false;
		currentTurnCalledGoalBlock = false;
	});
	pi.on("tool_execution_end", () => { currentTurnHadToolCall = true; });
	pi.on("turn_end", (event: any) => {
		lastTurnWasContinuation = currentTurnIsContinuation;
		lastTurnHadToolCall = currentTurnHadToolCall || (Array.isArray(event.toolResults) && event.toolResults.length > 0);
		lastTurnCalledGoalBlock = currentTurnCalledGoalBlock;
	});

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
		nextTurnIsContinuation = false;
		currentTurnIsContinuation = false;
		currentTurnHadToolCall = false;
		currentTurnCalledGoalBlock = false;
		lastTurnHadToolCall = false;
		lastTurnWasContinuation = false;
		lastTurnCalledGoalBlock = false;
		noToolContinuationStreak = 0;
		for (const entry of branchEntries(ctx)) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as PersistedGoalEntry | undefined;
			if (data?.cleared || !data?.state) {
				state = undefined;
				continue;
			}
			const restored = data.state as GoalState & Record<string, unknown>;
			const audit = restored.blockedAudit as Partial<BlockedAudit> | undefined;
			const blockedAudit = audit && typeof audit.fingerprint === "string"
				? {
					fingerprint: audit.fingerprint,
					count: typeof audit.count === "number" ? audit.count : 1,
					blocker: typeof audit.blocker === "string" ? audit.blocker : "Goal is blocked.",
					attempted: typeof audit.attempted === "string" ? audit.attempted : "",
					evidence: typeof audit.evidence === "string" ? audit.evidence : "",
					nextInput: typeof audit.nextInput === "string" ? audit.nextInput : "Provide input to unblock the goal.",
					lastReportedAt: typeof audit.lastReportedAt === "number" ? audit.lastReportedAt : Date.now(),
				}
				: undefined;
			state = {
				objective: typeof restored.objective === "string" ? restored.objective : "",
				validation: Array.isArray(restored.validation) ? [...restored.validation] : [],
				verify: typeof restored.verify === "string" ? restored.verify : undefined,
				status: normalizeStatus(restored.status),
				createdAt: typeof restored.createdAt === "number" ? restored.createdAt : Date.now(),
				updatedAt: typeof restored.updatedAt === "number" ? restored.updatedAt : Date.now(),
				activeSince: typeof restored.activeSince === "number" ? restored.activeSince : undefined,
				accumulatedActiveMs: typeof restored.accumulatedActiveMs === "number" ? restored.accumulatedActiveMs : 0,
				blockedAt: typeof restored.blockedAt === "number" ? restored.blockedAt : undefined,
				blockedAudit,
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
		label: "Report Goal Blocker",
		description:
			`Record a blocker for the active goal. Only marks the goal blocked after the same blocking condition has recurred for at least ${BLOCKED_AUDIT_THRESHOLD} consecutive goal turns and no meaningful progress is possible without user input or an external-state change. Do not call merely because work is hard, slow, uncertain, incomplete, or would benefit from clarification.`,
		parameters: Type.Object({
			blocker: Type.String({ description: "What is preventing completion." }),
			attempted: Type.String({ description: "What was attempted." }),
			evidence: Type.String({ description: "Concrete evidence of the blocker (error output, missing file, failing test, etc.)." }),
			next_input: Type.String({ description: "What input or change would unlock progress." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const alreadyReportedThisTurn = currentTurnCalledGoalBlock;
			currentTurnCalledGoalBlock = true;
			if (!state) {
				return { content: [{ type: "text", text: "No active session goal." }], details: { ok: false } };
			}
			if (state.status !== "active") {
				return { content: [{ type: "text", text: `Goal is ${state.status}, not active. Resume it before reporting blockers.` }], details: { ok: false } };
			}
			if (alreadyReportedThisTurn) {
				return { content: [{ type: "text", text: "A blocker has already been recorded for this goal turn. Wait for the next goal turn before counting the same blocker again." }], details: { ok: true, blocked: false, duplicateTurn: true } };
			}
			const fingerprint = blockerFingerprint(params.blocker, params.next_input);
			const previous = state.blockedAudit;
			const count = previous?.fingerprint === fingerprint ? previous.count + 1 : 1;
			state.blockedAudit = {
				fingerprint,
				count,
				blocker: params.blocker,
				attempted: params.attempted,
				evidence: params.evidence,
				nextInput: params.next_input,
				lastReportedAt: Date.now(),
			};

			if (count < BLOCKED_AUDIT_THRESHOLD) {
				saveAndEmit(ctx);
				return {
					content: [{ type: "text", text: `Blocker recorded (${count}/${BLOCKED_AUDIT_THRESHOLD}); goal remains active. Continue if any meaningful progress is possible. If the same blocker recurs on later goal turns, call goal_block again with the same blocker and next input.\n\nBlocker: ${params.blocker}\nAttempted: ${params.attempted}\nEvidence: ${params.evidence}\nNext input needed: ${params.next_input}` }],
					details: { ok: true, blocked: false, count, threshold: BLOCKED_AUDIT_THRESHOLD },
				};
			}

			ctx.ui.notify("Goal blocked: blocker repeated across goal turns.", "warning");
			setStatus("blocked", ctx);
			return {
				content: [{ type: "text", text: `Goal marked blocked after ${count} consecutive reports of the same blocker.\n\nBlocker: ${params.blocker}\nAttempted: ${params.attempted}\nEvidence: ${params.evidence}\nNext input needed: ${params.next_input}\n\nResume with /goal resume once unblocked.` }],
				details: { ok: true, blocked: true, count, threshold: BLOCKED_AUDIT_THRESHOLD },
			};
		},
	});
}
