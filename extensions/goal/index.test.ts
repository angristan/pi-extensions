import { expect, mock, test } from "bun:test";

const registeredOverlayCards: any[] = [];
const judgeResponses: any[] = [];
const judgeCalls: any[] = [];
const mockedComplete = mock(async (...args: any[]) => {
	judgeCalls.push(args);
	const next = judgeResponses.length ? judgeResponses.shift() : undefined;
	if (next instanceof Error) throw next;
	return next ?? {
		stopReason: "stop",
		content: [{ type: "text", text: '{"verdict":"allow","reason":"evidence is sufficient","missing_evidence":[],"next_action":""}' }],
		usage: { input: 5, output: 7 },
	};
});
const { buildGoalContext, renderGoalOverlayBody, default: goalExtension } = await import("./index");

function makeHarness(options: { judgeRetryPolicy?: { enabled: boolean; maxRetries: number; baseDelayMs: number } } = {}) {
	judgeResponses.length = 0;
	judgeCalls.length = 0;
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const commands: Record<string, any> = {};
	const tools: Record<string, any> = {};
	const activeTools = new Set<string>();
	const entries: any[] = [];
	const sent: Array<{ message: any; options: any }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const confirmCalls: Array<{ title: string; message: string }> = [];
	const confirmResponses: boolean[] = [];
	let editorValue: string | undefined;
	let branchReadCount = 0;

	const ctx: any = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		model: { provider: "test", id: "judge-model", name: "Judge model", contextWindow: 128_000 },
		modelRegistry: {
			complete: mockedComplete,
		},
		getSystemPrompt: () => "System prompt for tests.",
		sessionManager: {
			getBranch: () => { branchReadCount += 1; return entries; },
			getEntries: () => entries,
			getLeafId: () => entries.length ? String(entries.length) : null,
			getSessionId: () => "test-session",
		},
		ui: {
			notify(message: string, type?: string) { notifications.push({ message, type }); },
			setStatus() {},
			confirm(title: string, message: string) {
				confirmCalls.push({ title, message });
				return Promise.resolve(confirmResponses.length ? confirmResponses.shift()! : true);
			},
			editor(_title: string, _source: string) { return Promise.resolve(editorValue); },
			theme: { bold: (text: string) => text, fg: (_color: string, text: string) => text },
		},
	};

	goalExtension({
		appendEntry(customType: string, data: any) { entries.push({ type: "custom", id: String(entries.length + 1), customType, data }); },
		sendMessage(message: any, options: any) { sent.push({ message, options }); },
		events: { emit() {}, on() { return () => {}; } },
		on(event: string, handler: any) { (handlers[event] ??= []).push(handler); },
		registerCommand(name: string, command: any) { commands[name] = command; },
		registerTool(tool: any) { tools[tool.name] = tool; activeTools.add(tool.name); },
		getActiveTools() { return [...activeTools]; },
		setActiveTools(names: string[]) {
			activeTools.clear();
			for (const name of names) activeTools.add(name);
		},
	} as any, {
		registerOverlayCard(definition: any) {
			registeredOverlayCards.push(definition);
			return { invalidate() {}, unregister() {} };
		},
		judgeRetryPolicy: options.judgeRetryPolicy,
	});

	return {
		handlers,
		commands,
		tools,
		activeTools,
		entries,
		sent,
		notifications,
		confirmCalls,
		confirmResponses,
		ctx,
		getBranchReadCount: () => branchReadCount,
		setEditorValue(value: string | undefined) { editorValue = value; },
	};
}

async function emit(harness: ReturnType<typeof makeHarness>, event: string, payload: any = {}) {
	const results: any[] = [];
	for (const handler of harness.handlers[event] ?? []) {
		results.push(await handler(payload, harness.ctx));
	}
	return results;
}

async function context(harness: ReturnType<typeof makeHarness>, messages: any[]) {
	const results = await emit(harness, "context", { messages });
	return results.find((result) => result !== undefined);
}

function latestGoalState(harness: ReturnType<typeof makeHarness>) {
	return [...harness.entries].reverse().find((entry) => entry.customType === "goal-state")?.data?.state;
}

function isContinuation(message: any) {
	return message?.customType === "goal-continuation";
}

function sentMessages(harness: ReturnType<typeof makeHarness>, customType: string) {
	return harness.sent.filter(({ message }) => message?.customType === customType);
}

function queueJudge(verdict: "allow" | "deny", fields: Record<string, unknown> = {}) {
	judgeResponses.push({
		stopReason: "stop",
		content: [{ type: "text", text: JSON.stringify({ verdict, reason: verdict === "allow" ? "ok" : "not proven", missing_evidence: [], next_action: "", ...fields }) }],
		usage: { input: 11, output: 13 },
	});
}

test("reserves goal_set for long-running autonomous work", () => {
	const h = makeHarness();
	const description = h.tools.goal_set.description;

	expect(description).toContain("including multi-step work; use update_plan instead");
	expect(description).toContain("long-running, multi-turn work");
	expect(description).toContain("Most tasks should not create a goal");
});

test("renders the goal overlay as a compact summary", () => {
	const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text };
	const lines = renderGoalOverlayBody({
		objective: "Continue the vendor-neutral browser capture backend for the capture service while preserving parity with HTTP-only captures across discovery, filtering, assets, retries, lifecycle metadata, observability, and replayable WARC/MCDX output.",
		validation: ["parity harness passes", "WARC counts match"],
		status: "active",
		createdAt: 0,
		updatedAt: 0,
		accumulatedActiveMs: 0,
		continuations: 3,
		elapsedMs: 125_000,
	}, 52, 40, theme, { inputTokens: 42_000, outputTokens: 3_000, cacheReadTokens: 62_000_000, cacheWriteTokens: 1_500_000 });

	expect(lines.length).toBeLessThanOrEqual(7);
	expect(lines.every((line) => line.length <= 52)).toBe(true);
	expect(lines[2]).toMatch(/^\+\d+ lines? · \/goal-status$/);
	expect(lines[3]).toBe("");
	expect(lines.slice(4).join("\n")).toContain("2m 5s active · 3 cycles · 2 criteria");
	expect(lines.slice(4).join("\n")).toContain("Usage  ↓42K  ↑3K · cached 62M · written 1.5M");
	expect(lines.join("\n")).not.toContain("tokens spent");
	expect(lines.join("\n")).not.toContain("R62M");
});

test("keeps cycle and criteria counters visible at zero", () => {
	const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text };
	const lines = renderGoalOverlayBody({
		objective: "Ship the feature",
		validation: [],
		status: "active",
		createdAt: 0,
		updatedAt: 0,
		accumulatedActiveMs: 0,
		continuations: 0,
		elapsedMs: 1_000,
	}, 52, 40, theme);

	expect(lines.join("\n")).toContain("1s active · 0 cycles · 0 criteria");
});

test("renders a semantic goal status indicator", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("ship the feature", h.ctx);
	const card = registeredOverlayCards.at(-1)!;
	const title = card.title(h.ctx.ui.theme);
	expect(title).toContain("Goal ● active");
});

test("includes tool, compaction, and branch-summary usage in cached goal stats", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("ship the feature", h.ctx);
	h.entries.push(
		{ type: "message", message: { role: "toolResult", usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 } } },
		{ type: "compaction", usage: { input: 7, output: 11, cacheRead: 13, cacheWrite: 17 } },
		{ type: "branch_summary", usage: { input: 19, output: 23, cacheRead: 29, cacheWrite: 31 } },
	);
	await emit(h, "session_compact");

	const card = registeredOverlayCards.at(-1)!;
	const text = card.renderBody(58, 7, h.ctx.ui.theme).join("\n");
	expect(text).toContain("Usage  ↓28  ↑37 · cached 46 · written 53");
});

test("updates cached usage from finalized messages before persistence", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("ship the feature", h.ctx);
	await emit(h, "message_end", {
		message: { role: "assistant", stopReason: "stop", usage: { input: 23, output: 29, cacheRead: 31, cacheWrite: 37 } },
	});

	const card = registeredOverlayCards.at(-1)!;
	expect(card.renderBody(58, 7, h.ctx.ui.theme).join("\n")).toContain("Usage  ↓23  ↑29 · cached 31 · written 37");
});

test("overlay repaint reuses cached usage without reading the branch", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("ship the feature", h.ctx);
	const card = registeredOverlayCards.at(-1)!;
	const readsBeforeRender = h.getBranchReadCount();

	card.renderBody(58, 7, h.ctx.ui.theme);
	card.renderBody(58, 7, h.ctx.ui.theme);

	expect(h.getBranchReadCount()).toBe(readsBeforeRender);
});

test("recomputes cached usage after branch restore", async () => {
	const h = makeHarness();
	const persistedGoal = {
		type: "custom",
		customType: "goal-state",
		data: {
			state: {
				objective: "finish the migration",
				validation: [],
				status: "active",
				createdAt: 1,
				updatedAt: 1,
				activeSince: 1,
				accumulatedActiveMs: 0,
				continuations: 2,
			},
		},
	};
	h.entries.push(persistedGoal, { type: "message", message: { role: "assistant", usage: { input: 3, output: 4 } } });
	await emit(h, "session_start");
	const card = registeredOverlayCards.at(-1)!;
	expect(card.renderBody(58, 7, h.ctx.ui.theme).join("\n")).toContain("Usage  ↓3  ↑4");

	h.entries.splice(0, h.entries.length, persistedGoal, { type: "message", message: { role: "assistant", usage: { input: 17, output: 19 } } });
	await emit(h, "session_tree");
	expect(card.renderBody(58, 7, h.ctx.ui.theme).join("\n")).toContain("Usage  ↓17  ↑19");
});

test("labels the initial goal-loop kickoff as cycle one", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("ship the feature", h.ctx);
	await h.commands["goal-status"].handler("", h.ctx);

	const status = h.notifications.at(-1)!.message;
	expect(status).toContain("Cycles  1");
	expect(status).not.toContain("Continuations");
});

test("wraps goal data as escaped untrusted context", () => {
	const text = buildGoalContext({
		objective: "<do>&override</do>",
		validation: ["<check>&done"],
		status: "active",
		createdAt: 0,
		updatedAt: 0,
		accumulatedActiveMs: 0,
		continuations: 0,
	});

	expect(text).toContain("<untrusted_objective>");
	expect(text).toContain("&lt;do&gt;&amp;override&lt;/do&gt;");
	expect(text).toContain("&lt;check&gt;&amp;done");
	expect(text).not.toContain("<do>&override</do>");
});

test("appends active goal context without rebuilding the system prompt", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("ship <unsafe>&", h.ctx);

	expect(await emit(h, "before_agent_start", { prompt: "continue" })).toEqual([undefined]);
	const contexts = sentMessages(h, "goal-context");
	expect(contexts).toHaveLength(1);
	expect(contexts[0]!.options).toEqual({ deliverAs: "steer" });
	expect(contexts[0]!.message.content).toContain("## Active session goal");
	expect(contexts[0]!.message.content).toContain("ship &lt;unsafe&gt;&amp;");
	expect(contexts[0]!.message.content).not.toContain("ship <unsafe>&");
});

test("re-anchors persisted goal context after restore and compaction", async () => {
	const h = makeHarness();
	h.entries.push({
		type: "custom",
		customType: "goal-state",
		data: {
			state: {
				objective: "finish the migration",
				validation: ["all checks pass"],
				status: "active",
				createdAt: 1,
				updatedAt: 1,
				activeSince: 1,
				accumulatedActiveMs: 0,
				continuations: 2,
			},
		},
	});

	await emit(h, "session_start");
	expect(sentMessages(h, "goal-context")).toHaveLength(1);
	expect(sentMessages(h, "goal-context")[0]!.message.content).toContain("finish the migration");

	await emit(h, "session_compact");
	expect(sentMessages(h, "goal-context")).toHaveLength(2);
	expect(sentMessages(h, "goal-context").at(-1)!.message.content).toContain("finish the migration");
});

test("retires legacy cleared goal instructions on restore", async () => {
	const h = makeHarness();
	h.entries.push(
		{
			type: "custom",
			customType: "goal-state",
			data: {
				state: {
					objective: "monitor the old rollout",
					validation: [],
					status: "active",
					createdAt: 1,
					updatedAt: 1,
					activeSince: 1,
					accumulatedActiveMs: 0,
					continuations: 1,
				},
			},
		},
		{ type: "custom", customType: "goal-state", data: { cleared: true } },
	);

	await emit(h, "session_start");

	const context = sentMessages(h, "goal-context").at(-1)!.message;
	expect(context.details.status).toBe("cleared");
	expect(context.content).toContain("previous active-goal instructions are retired");
	expect(context.content).toContain("monitor the old rollout");
});

test("retires completed goal instructions across compaction and restore", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("finish the migration", h.ctx);
	const contextsBeforeCompletion = sentMessages(h, "goal-context").length;

	await h.tools.goal_complete.execute("complete", {}, undefined, undefined, h.ctx);
	await emit(h, "session_compact");
	await emit(h, "session_start");

	expect(latestGoalState(h).status).toBe("complete");
	const contexts = sentMessages(h, "goal-context");
	expect(contexts).toHaveLength(contextsBeforeCompletion + 3);
	for (const { message } of contexts.slice(contextsBeforeCompletion)) {
		expect(message.details?.status).toBe("complete");
		expect(message.content).toContain("previous active-goal instructions are retired");
	}
});

test("continuation prompt is injected transiently and stale markers are pruned", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("ship <unsafe>&", h.ctx);

	const continuation = sentMessages(h, "goal-continuation")[0]!;
	expect(continuation.message.content).toBe("Goal continuation requested.");
	expect(continuation.message.content).not.toContain("unsafe");

	await emit(h, "turn_start", { turnIndex: 0, timestamp: 0 });
	const result = await context(h, [
		{ customType: "goal-continuation", content: "stale", display: false },
		{ role: "assistant", content: [] },
		continuation.message,
	]);

	expect(result.messages).toHaveLength(2);
	const injected = result.messages.find(isContinuation);
	expect(injected.content).toContain("<untrusted_objective>");
	expect(injected.content).toContain("ship &lt;unsafe&gt;&amp;");
	expect(injected.content).toContain("Completion audit:");
	expect(injected.details.transient).toBe(true);

	const second = await context(h, [continuation.message, { role: "assistant", content: [] }]);
	expect(second.messages.some(isContinuation)).toBe(false);
});

test("replacing an unfinished goal requires confirmation", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("initial goal", h.ctx);
	const entriesAfterInitial = h.entries.length;

	h.confirmResponses.push(false);
	await h.commands.goal.handler("replacement goal", h.ctx);
	expect(h.confirmCalls).toHaveLength(1);
	expect(latestGoalState(h).objective).toBe("initial goal");
	expect(h.entries).toHaveLength(entriesAfterInitial);

	h.confirmResponses.push(true);
	await h.commands.goal.handler("replacement goal", h.ctx);
	expect(h.confirmCalls).toHaveLength(2);
	expect(latestGoalState(h).objective).toBe("replacement goal");
});

test("goal tools stay active after their first session activation", async () => {
	const h = makeHarness();
	await emit(h, "session_start");
	for (const name of ["goal_complete", "goal_block"]) {
		expect(h.activeTools.has(name)).toBe(false);
	}

	const stale = await h.tools.goal_complete.execute("stale", {}, undefined, undefined, h.ctx);
	expect(stale.content[0].text).toBe("");
	expect(stale.details).toMatchObject({ ok: false, ignored: true, reason: "no-goal" });

	await h.commands.goal.handler("active goal", h.ctx);
	for (const name of ["goal_complete", "goal_block"]) {
		expect(h.activeTools.has(name)).toBe(true);
	}

	await h.tools.goal_complete.execute("complete", {}, undefined, undefined, h.ctx);
	for (const name of ["goal_complete", "goal_block"]) {
		expect(h.activeTools.has(name)).toBe(true);
	}

	const contextsBeforeClear = sentMessages(h, "goal-context").length;
	await h.commands.goal.handler("clear", h.ctx);
	for (const name of ["goal_complete", "goal_block"]) {
		expect(h.activeTools.has(name)).toBe(true);
	}
	expect(sentMessages(h, "goal-context")).toHaveLength(contextsBeforeClear + 1);
	expect(sentMessages(h, "goal-context").at(-1)!.message).toMatchObject({ details: { status: "cleared" } });
});

test("editing a completed goal reactivates it and starts the loop", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("initial goal", h.ctx);
	await h.commands.goal.handler("complete", h.ctx);
	expect(latestGoalState(h).status).toBe("complete");
	const contextsBeforeEdit = sentMessages(h, "goal-context").length;
	const continuationsBeforeEdit = sentMessages(h, "goal-continuation").length;

	h.setEditorValue("# Goal\nreactivated goal\n\n## Validation\n- evidence checked\n");
	await h.commands.goal.handler("edit", h.ctx);

	const state = latestGoalState(h);
	expect(state.status).toBe("active");
	expect(state.completedAt).toBeUndefined();
	expect(state.objective).toBe("reactivated goal");
	expect(state.validation).toEqual(["evidence checked"]);
	expect(sentMessages(h, "goal-context")).toHaveLength(contextsBeforeEdit + 1);
	expect(sentMessages(h, "goal-continuation")).toHaveLength(continuationsBeforeEdit + 1);
	expect(sentMessages(h, "goal-continuation").at(-1)!.message.content).toBe("Goal continuation requested.");
});

test("terminal provider errors block the active goal instead of continuing", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("initial goal", h.ctx);
	const contextsBeforeError = sentMessages(h, "goal-context").length;
	const continuationsBeforeError = sentMessages(h, "goal-continuation").length;

	await emit(h, "message_end", {
		message: { role: "assistant", stopReason: "error", errorMessage: "429 too many requests" },
	});
	await emit(h, "agent_settled", {});

	const state = latestGoalState(h);
	expect(state.status).toBe("blocked");
	expect(state.blockedAudit.fingerprint).toBe("provider-usage-limit");
	expect(state.blockedAudit.evidence).toBe("429 too many requests");
	expect(sentMessages(h, "goal-context")).toHaveLength(contextsBeforeError + 1);
	const blockedContext = sentMessages(h, "goal-context").at(-1)!.message;
	expect(blockedContext.details.status).toBe("blocked");
	expect(blockedContext.content).toContain("goal_resume");
	expect(blockedContext.content).toContain("goal_clear");
	expect(sentMessages(h, "goal-continuation")).toHaveLength(continuationsBeforeError);

	const [reconciliation] = await emit(h, "before_agent_start", { prompt: "continue the work" });
	expect(reconciliation.message.details).toEqual({ status: "blocked", reconciliation: true });
	expect(reconciliation.message.content).toContain("reconciliation required");
});

test("goal_complete silently retries a transient judge failure", async () => {
	const h = makeHarness({ judgeRetryPolicy: { enabled: true, maxRetries: 1, baseDelayMs: 0 } });
	await h.commands.goal.handler("ship the feature", h.ctx);
	judgeResponses.push({
		stopReason: "error",
		errorMessage: "Your requests have exceeded rate limit.",
		content: [],
	});
	queueJudge("allow");

	const result = await h.tools.goal_complete.execute("call", { summary: "done" }, undefined, undefined, h.ctx);

	expect(result.details).toMatchObject({ ok: true });
	expect(latestGoalState(h).status).toBe("complete");
	expect(judgeCalls).toHaveLength(2);
	expect(result.content[0].text).not.toContain("could not be audited");
});

test("goal_complete surfaces one failure after transient judge retries are exhausted", async () => {
	const h = makeHarness({ judgeRetryPolicy: { enabled: true, maxRetries: 2, baseDelayMs: 0 } });
	await h.commands.goal.handler("ship the feature", h.ctx);
	for (let attempt = 0; attempt < 3; attempt++) {
		judgeResponses.push({
			stopReason: "error",
			errorMessage: "HTTP 429 too many requests",
			content: [],
		});
	}

	const result = await h.tools.goal_complete.execute("call", { summary: "done" }, undefined, undefined, h.ctx);

	expect(judgeCalls).toHaveLength(3);
	expect(result.details).toMatchObject({ ok: false, judgeError: true });
	expect(result.content[0].text).toContain("HTTP 429 too many requests");
	expect(latestGoalState(h).status).toBe("active");
});

test("goal_complete does not retry non-transient judge failures", async () => {
	const h = makeHarness({ judgeRetryPolicy: { enabled: true, maxRetries: 2, baseDelayMs: 0 } });
	await h.commands.goal.handler("ship the feature", h.ctx);
	judgeResponses.push({
		stopReason: "error",
		errorMessage: "insufficient_quota: billing quota exceeded",
		content: [],
	});

	const result = await h.tools.goal_complete.execute("call", { summary: "done" }, undefined, undefined, h.ctx);

	expect(judgeCalls).toHaveLength(1);
	expect(result.details).toMatchObject({ ok: false, judgeError: true });
	expect(result.content[0].text).toContain("insufficient_quota");
});

test("goal_complete is vetoed when the judge says evidence is missing", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("ship the feature", h.ctx);
	queueJudge("deny", {
		reason: "Tests were not run.",
		missing_evidence: ["test output"],
		next_action: "Run the relevant test suite.",
	});

	const result = await h.tools.goal_complete.execute("call", { summary: "done" }, undefined, undefined, h.ctx);

	expect(result.details).toMatchObject({ ok: false, judgeDenied: true });
	expect(result.content[0].text).toContain("Tests were not run");
	expect(result.content[0].text).toContain("Run the relevant test suite");
	expect(latestGoalState(h).status).toBe("active");
	expect(judgeCalls).toHaveLength(1);
	const block = h.tools.goal_complete.renderResult(result, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	expect(renderBlock(block)[0]).toContain("Completion denied by judge");
});

test("goal_block is vetoed at the threshold when the judge finds an action", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("reduce p95 latency below 120ms", h.ctx);

	for (let run = 1; run <= 2; run++) {
		await emit(h, "turn_start", { turnIndex: 0, timestamp: 0 });
		await h.tools.goal_block.execute(`call-${run}`, { blocker: "needs logs" }, undefined, undefined, h.ctx);
		await emit(h, "turn_end", { turnIndex: 0, toolResults: [{ toolName: "goal_block" }] });
		await emit(h, "agent_settled");
	}
	queueJudge("deny", { reason: "Logs can still be inspected.", next_action: "Read the local log file." });
	await emit(h, "turn_start", { turnIndex: 0, timestamp: 0 });
	const result = await h.tools.goal_block.execute("call-3", { blocker: "needs logs" }, undefined, undefined, h.ctx);

	expect(result.terminate).toBeUndefined();
	expect(result.details).toMatchObject({ ok: false, blocked: false, judgeDenied: true });
	expect(latestGoalState(h).status).toBe("active");
	expect(latestGoalState(h).blockedAudit).toBeUndefined();
	const block = h.tools.goal_block.renderResult(result, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	expect(renderBlock(block)[0]).toContain("Blocker rejected by judge");
	expect(renderBlock(block)[1]).toContain("Read the local log file");
});

test("goal_block judge receives authoritative in-flight threshold evidence", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("reduce p95 latency below 120ms", h.ctx);

	for (let run = 1; run <= 2; run++) {
		await emit(h, "turn_start", { turnIndex: 0, timestamp: 0 });
		await h.tools.goal_block.execute(`call-${run}`, { blocker: "needs logs" }, undefined, undefined, h.ctx);
		await emit(h, "turn_end", { turnIndex: 0, toolResults: [{ toolName: "goal_block" }] });
		await emit(h, "agent_settled");
	}

	await emit(h, "turn_start", { turnIndex: 0, timestamp: 0 });
	await h.tools.goal_block.execute("call-3", { blocker: "needs logs" }, undefined, undefined, h.ctx);

	const prompt = judgeCalls[0]![1].messages[0].content[0].text;
	expect(prompt).toContain("<extension_audit_state>");
	expect(prompt).toContain("3/3 consecutive settled goal runs");
	expect(prompt).toContain("current goal_block call is still in flight");
	expect(prompt).toContain("Do not require its tool result in the transcript");
});

test("judge veto rendering keeps useful text and expands full details", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("ship the feature", h.ctx);
	const longReason = "The relevant validation output is missing even though the summary claimed success; inspect the exact command output before completing the goal.";
	queueJudge("deny", {
		reason: longReason,
		missing_evidence: ["the exact validation command output", "the persisted artifact checksum"],
		next_action: "Run the validation command and include its output.",
	});

	const result = await h.tools.goal_complete.execute("call", { summary: "done" }, undefined, undefined, h.ctx);
	const collapsed = h.tools.goal_complete.renderResult(result, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	const collapsedLines = renderBlock(collapsed, 180);
	expect(collapsedLines[0]).toContain("Completion denied by judge");
	// No old 120-column hard cap: a wide viewport keeps the useful tail visible.
	expect(collapsedLines[1]).toContain("before completing the goal");

	const expanded = h.tools.goal_complete.renderResult(result, { isPartial: false, expanded: true }, h.ctx.ui.theme, { lastComponent: undefined });
	const expandedText = renderBlock(expanded, 80).join("\n");
	expect(expandedText).toContain("Missing evidence:");
	expect(expandedText).toContain("the exact validation command output");
	expect(expandedText).toContain("Next action: Run the validation command");
});

test("anti-spin uses judge guidance before blocking", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("ship the feature", h.ctx);
	queueJudge("deny", { reason: "A file inspection is still available.", next_action: "Read package.json." });

	for (let run = 0; run < 3; run++) {
		await emit(h, "turn_start", { turnIndex: run, timestamp: 0 });
		await emit(h, "turn_end", { turnIndex: run, toolResults: [] });
		await emit(h, "agent_settled");
	}

	const state = latestGoalState(h);
	expect(state.status).toBe("active");
	expect(state.blockedAudit).toBeUndefined();
	expect(h.notifications.at(-1)!.message).toContain("actionable next step");
	const continuation = sentMessages(h, "goal-continuation").at(-1)!;
	expect(continuation.message.content).toBe("Goal continuation requested.");
	await emit(h, "turn_start", { turnIndex: 99, timestamp: 0 });
	const result = await context(h, [continuation.message]);
	expect(result.messages[0].content).toContain("Goal judge guidance after a no-tool loop");
	expect(result.messages[0].content).toContain("Read package.json");
});

// Render the lines a tool block component produces.
function renderBlock(component: any, width = 80): string[] {
	return component.render(width);
}

test("goal_complete allows a final response, renders one compact block, and hides stale calls", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("reduce p95 latency below 120ms", h.ctx);
	h.entries.push({ type: "message", message: { role: "assistant", usage: { input: 41, output: 43, cacheRead: 47, cacheWrite: 53 } } });
	await emit(h, "session_compact");
	const notificationsBeforeCompletion = h.notifications.length;

	const result = await h.tools.goal_complete.execute("call", { summary: "shipped the fix" }, undefined, undefined, h.ctx);
	expect(h.notifications).toHaveLength(notificationsBeforeCompletion);
	// Pi should perform a follow-up model turn so the user receives a final report.
	expect(result.terminate).toBeUndefined();
	expect(result.details.completion).toBeDefined();
	expect(result.details.completion.activeTimeMs).toBeGreaterThanOrEqual(0);
	expect(result.details.completion.validationCount).toBe(0);
	expect(result.details.completion.tokens).toEqual({ inputTokens: 41, outputTokens: 43, cacheReadTokens: 47, cacheWriteTokens: 53 });
	const colorTheme = { bold: (text: string) => text, fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
	const block = h.tools.goal_complete.renderResult(result, { isPartial: false }, colorTheme, { lastComponent: undefined });
	const lines = renderBlock(block);
	expect(lines[0]).toContain("Completed goal");
	expect(lines[1]).toContain("└");
	// The branch shows the summary (preferred) or the objective in normal text,
	// not dimmed like low-priority metadata.
	expect(lines[1]).toContain("<text>shipped the fix</text>");
	// The completion block surfaces lifetime stats since the overlay card hid,
	// but only the stats line is muted.
	expect(lines.length).toBeGreaterThanOrEqual(3);
	expect(lines[2]).toContain("└");
	expect(lines[2]).toContain("<muted>");
	expect(lines[2]).toMatch(/active.*cycle.*0 criteria/i);

	// A stale call against no active goal renders nothing.
	const stale = { ...result, details: { ok: false, ignored: true, reason: "no-goal" } };
	const staleBlock = h.tools.goal_complete.renderResult(stale, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	expect(renderBlock(staleBlock)).toEqual([]);
});

test("/goal complete surfaces lifetime stats in the notification", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("reduce p95 latency below 120ms", h.ctx);

	await h.commands.goal.handler("complete", h.ctx);
	expect(latestGoalState(h).status).toBe("complete");
	const note = h.notifications.at(-1)!;
	expect(note.message).toContain("Goal complete:");
	expect(note.message).toMatch(/active.*cycle/i);
});

test("goal_block terminates and counts once per settled run", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("reduce p95 latency below 120ms", h.ctx);

	let result: any;
	for (let run = 1; run <= 3; run++) {
		await emit(h, "agent_start");
		await emit(h, "turn_start", { turnIndex: 0, timestamp: 0 });
		result = await h.tools.goal_block.execute(`call-${run}`, { blocker: "flaky CI on macOS" }, undefined, undefined, h.ctx);
		expect(result.terminate).toBe(true);
		await emit(h, "turn_end", { turnIndex: 0, toolResults: [{ toolName: "goal_block" }] });
		// A single goal_block skips the follow-up model turn. Keep the audit robust
		// when a non-terminating sibling tool still causes one in the same run.
		await emit(h, "turn_start", { turnIndex: 1, timestamp: 0 });
		await emit(h, "turn_end", { turnIndex: 1, toolResults: [] });
		await emit(h, "agent_settled");

		const settled = latestGoalState(h);
		expect(settled.blockedAudit.count).toBe(run);
		expect(settled.status).toBe(run === 3 ? "blocked" : "active");
	}

	expect(result.details.blocked).toBe(true);
	let block = h.tools.goal_block.renderResult(result, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	let lines = renderBlock(block);
	expect(lines[0]).toContain("Goal blocked");
	expect(lines[1]).toContain("flaky CI on macOS");

	// Even if another turn follows the first tool call, the same low-level run
	// cannot count a second blocker report.
	await h.commands.goal.handler("fresh goal", h.ctx);
	await emit(h, "agent_start");
	await emit(h, "turn_start", { turnIndex: 0, timestamp: 0 });
	const recorded = await h.tools.goal_block.execute("dup-1", { blocker: "same blocker" }, undefined, undefined, h.ctx);
	expect(recorded.terminate).toBe(true);
	expect(recorded.details.blocked).toBe(false);
	block = h.tools.goal_block.renderResult(recorded, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	lines = renderBlock(block);
	expect(lines[0]).toContain("Blocker recorded");
	expect(lines[1]).toContain("1/3");

	await emit(h, "turn_end", { turnIndex: 0, toolResults: [{ toolName: "goal_block" }] });
	await emit(h, "turn_start", { turnIndex: 1, timestamp: 0 });
	const duplicate = await h.tools.goal_block.execute("dup-2", { blocker: "same blocker" }, undefined, undefined, h.ctx);
	expect(duplicate.terminate).toBe(true);
	expect(duplicate.details.duplicateRun).toBe(true);
	block = h.tools.goal_block.renderResult(duplicate, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	lines = renderBlock(block);
	expect(lines[0]).toContain("Blocker already recorded");
	expect(lines[1]).toContain("settled run");
});

test("a settled run without goal_block breaks the blocker audit", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("reduce p95 latency below 120ms", h.ctx);

	await emit(h, "turn_start", { turnIndex: 0, timestamp: 0 });
	await h.tools.goal_block.execute("call-1", { blocker: "flaky CI on macOS" }, undefined, undefined, h.ctx);
	await emit(h, "turn_end", { turnIndex: 0, toolResults: [{ toolName: "goal_block" }] });
	await emit(h, "turn_start", { turnIndex: 1, timestamp: 0 });
	await emit(h, "turn_end", { turnIndex: 1, toolResults: [] });
	await emit(h, "agent_settled");
	expect(latestGoalState(h).blockedAudit.count).toBe(1);

	await emit(h, "turn_start", { turnIndex: 0, timestamp: 0 });
	await emit(h, "turn_end", { turnIndex: 0, toolResults: [] });
	await emit(h, "agent_settled");
	expect(latestGoalState(h).blockedAudit).toBeUndefined();
});

test("goal_set, goal_resume, and goal_clear are always available", async () => {
	const h = makeHarness();
	await emit(h, "session_start");
	// Lifecycle entry tools are available before a goal exists; terminal tools
	// remain gated until a goal becomes active.
	expect(h.activeTools.has("goal_set")).toBe(true);
	expect(h.activeTools.has("goal_resume")).toBe(true);
	expect(h.activeTools.has("goal_clear")).toBe(true);
	expect(h.tools.goal_resume.description).toContain("Do not use goal_set with replace: true");
	expect(h.tools.goal_clear.description).toContain("obsolete, superseded, cancelled, or unrelated");
	expect(h.activeTools.has("goal_complete")).toBe(false);
	expect(h.activeTools.has("goal_block")).toBe(false);
	const notificationsBeforeSet = h.notifications.length;

	// Setting a goal activates the loop tools and starts the loop.
	await h.tools.goal_set.execute("call", {
		objective: "make all tests pass",
		validation: ["bun test is green"],
	}, undefined, undefined, h.ctx);
	const state = latestGoalState(h);
	expect(state.status).toBe("active");
	expect(state.objective).toBe("make all tests pass");
	expect(state.validation).toEqual(["bun test is green"]);
	expect(h.activeTools.has("goal_complete")).toBe(true);
	expect(h.activeTools.has("goal_block")).toBe(true);
	expect(sentMessages(h, "goal-context")).toHaveLength(1);
	expect(sentMessages(h, "goal-context")[0]!.message.content).toContain("make all tests pass");
	expect(sentMessages(h, "goal-continuation")).toHaveLength(1);
	expect(sentMessages(h, "goal-continuation")[0]!.message.content).toBe("Goal continuation requested.");
	expect(h.notifications).toHaveLength(notificationsBeforeSet);
});

test("goal_resume preserves paused goal identity and lifetime state", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("# Goal\nship the existing feature\n\n## Validation\n- focused tests pass", h.ctx);
	await h.commands.goal.handler("pause", h.ctx);
	const paused = latestGoalState(h);
	const snapshot = {
		objective: paused.objective,
		validation: [...paused.validation],
		createdAt: paused.createdAt,
		accumulatedActiveMs: paused.accumulatedActiveMs,
		continuations: paused.continuations,
	};
	const continuationsBeforeResume = sentMessages(h, "goal-continuation").length;
	// Match the reported regression: the paused goal was restored from an older
	// session branch before the agent was asked to resume it.
	await emit(h, "session_start");

	const result = await h.tools.goal_resume.execute("resume", {}, undefined, undefined, h.ctx);
	const resumed = latestGoalState(h);
	expect(result.details).toMatchObject({ ok: true, resumed: true, previousStatus: "paused" });
	expect(resumed.status).toBe("active");
	expect(resumed.objective).toBe(snapshot.objective);
	expect(resumed.validation).toEqual(snapshot.validation);
	expect(resumed.createdAt).toBe(snapshot.createdAt);
	expect(resumed.accumulatedActiveMs).toBe(snapshot.accumulatedActiveMs);
	expect(resumed.continuations).toBe(snapshot.continuations + 1);
	expect(sentMessages(h, "goal-continuation")).toHaveLength(continuationsBeforeResume + 1);

	const block = h.tools.goal_resume.renderResult(result, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	const lines = renderBlock(block);
	expect(lines[0]).toContain("Resumed goal");
	expect(lines[1]).toContain("ship the existing feature");
});

test("goal_resume reports when no goal exists", async () => {
	const h = makeHarness();
	const result = await h.tools.goal_resume.execute("resume", {}, undefined, undefined, h.ctx);
	expect(result.details).toEqual({ ok: false, reason: "no-goal" });
	const block = h.tools.goal_resume.renderResult(result, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	const lines = renderBlock(block);
	expect(lines[0]).toContain("Goal resume failed");
	expect(lines[1]).toContain("No session goal to resume");
});

test("goal_clear retires stale goals without deleting their history", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("monitor the old rollout", h.ctx);
	await h.commands.goal.handler("block", h.ctx);
	const entriesBeforeClear = h.entries.length;

	const result = await h.tools.goal_clear.execute("clear", { reason: "the user changed topics" }, undefined, undefined, h.ctx);

	expect(result.details).toMatchObject({ ok: true, cleared: true, previousStatus: "blocked" });
	expect(h.entries).toHaveLength(entriesBeforeClear + 1);
	expect(h.entries.at(-1)!.data).toEqual({ cleared: true });
	const context = sentMessages(h, "goal-context").at(-1)!.message;
	expect(context.details.status).toBe("cleared");
	expect(context.content).toContain("previous active-goal instructions are retired");
	expect(context.content).toContain("monitor the old rollout");
	const block = h.tools.goal_clear.renderResult(result, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	expect(renderBlock(block)[0]).toContain("Cleared goal");
	expect(renderBlock(block)[1]).toContain("monitor the old rollout");
});

test("goal_clear reports when no goal exists", async () => {
	const h = makeHarness();
	const result = await h.tools.goal_clear.execute("clear", {}, undefined, undefined, h.ctx);
	expect(result.details).toEqual({ ok: false, reason: "no-goal" });
	expect(renderBlock(h.tools.goal_clear.renderResult(result, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined }))[0]).toContain("Goal clear failed");
});

test("goal_set refuses to silently overwrite an in-progress goal", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("initial goal", h.ctx);

	// Without replace:true, overwriting an active goal is refused, not silent.
	const refused = await h.tools.goal_set.execute("call", { objective: "easier goal" }, undefined, undefined, h.ctx);
	expect(refused.details.needsReplace).toBe(true);
	expect(latestGoalState(h).objective).toBe("initial goal");

	// With replace:true, the goal is overwritten and the loop restarts.
	const contextsBeforeReplace = sentMessages(h, "goal-context").length;
	const continuationsBeforeReplace = sentMessages(h, "goal-continuation").length;
	const replaced = await h.tools.goal_set.execute("call", { objective: "replacement goal", replace: true }, undefined, undefined, h.ctx);
	expect(replaced.details.replaced).toBe(true);
	const state = latestGoalState(h);
	expect(state.objective).toBe("replacement goal");
	// maybeContinue kicks a fresh continuation (incrementing continuations to 1);
	// the fresh-audit guarantee is that noToolContinuationStreak was reset.
	expect(sentMessages(h, "goal-context")).toHaveLength(contextsBeforeReplace + 1);
	expect(sentMessages(h, "goal-continuation")).toHaveLength(continuationsBeforeReplace + 1);
	expect(sentMessages(h, "goal-continuation").at(-1)!.message.content).toBe("Goal continuation requested.");
});

test("goal_set overwrites a completed goal freely without replace:true", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("first goal", h.ctx);
	await h.commands.goal.handler("complete", h.ctx);
	expect(latestGoalState(h).status).toBe("complete");

	// Completed goals are not "in progress", so no replace:true needed.
	const result = await h.tools.goal_set.execute("call", { objective: "next goal" }, undefined, undefined, h.ctx);
	expect(result.details.set).toBe(true);
	const state = latestGoalState(h);
	expect(state.status).toBe("active");
	expect(state.objective).toBe("next goal");
});

test("goal_set renders set, replaced, and needsReplace blocks", async () => {
	const h = makeHarness();

	// Fresh set → green "Set goal".
	const set = await h.tools.goal_set.execute("call", { objective: "ship the feature" }, undefined, undefined, h.ctx);
	let block = h.tools.goal_set.renderResult(set, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	let lines = renderBlock(block);
	expect(lines[0]).toContain("Set goal");
	expect(lines[1]).toContain("ship the feature");

	// Active goal, no replace → green "Goal already active".
	const refused = await h.tools.goal_set.execute("call", { objective: "easier" }, undefined, undefined, h.ctx);
	block = h.tools.goal_set.renderResult(refused, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	lines = renderBlock(block);
	expect(lines[0]).toContain("Goal already active");
	expect(lines[1]).toContain("ship the feature");

	// Replace → green "Replaced goal".
	const replaced = await h.tools.goal_set.execute("call", { objective: "replacement", replace: true }, undefined, undefined, h.ctx);
	block = h.tools.goal_set.renderResult(replaced, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	lines = renderBlock(block);
	expect(lines[0]).toContain("Replaced goal");
	expect(lines[1]).toContain("replacement");
});

test("goal_set replacement expands full objective and validation", async () => {
	const h = makeHarness();
	await h.tools.goal_set.execute("call", { objective: "initial goal" }, undefined, undefined, h.ctx);
	const longObjective = "replace the current session goal with a deliberately long objective whose useful suffix should remain visible on wide terminals and available in expanded details";
	const result = await h.tools.goal_set.execute("call", {
		objective: longObjective,
		validation: ["expanded validation criterion stays visible"],
		replace: true,
	}, undefined, undefined, h.ctx);

	const collapsed = h.tools.goal_set.renderResult(result, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	const collapsedLines = renderBlock(collapsed, 220);
	expect(collapsedLines[0]).toContain("Replaced goal");
	expect(collapsedLines[1]).toContain("expanded details");
	expect(collapsedLines[1]).toContain("1 criterion");
	expect(collapsedLines[1]).toContain("Ctrl+O for full details");

	const expanded = h.tools.goal_set.renderResult(result, { isPartial: false, expanded: true }, h.ctx.ui.theme, { lastComponent: undefined });
	const expandedText = renderBlock(expanded, 72).join("\n");
	expect(expandedText).toContain("Objective:");
	expect(expandedText).toContain("available in expanded details");
	expect(expandedText).toContain("expanded validation criterion stays visible");
});
