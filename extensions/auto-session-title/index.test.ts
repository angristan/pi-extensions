import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appleHelperBinaryPath, isAppleTitleModel, requestAppleTitleCompletion } from "./apple";
import autoSessionTitle, { loadTitleModelConfig, loadTitleModelConfigs, normalizeTitle, requestTitleWithFallback, sessionTitleIsManual, TITLE_SYSTEM_PROMPT, titleModelConfigPath } from "./index";
import { requestTitleCompletion } from "./request";

describe("auto-session-title model requests", () => {
	test("titles the durable project instead of its latest component", () => {
		expect(TITLE_SYSTEM_PROMPT).toContain("A component remains subordinate even when discussed for several turns");
		expect(TITLE_SYSTEM_PROMPT).toContain("title that complete durable focus at the same scope");
		expect(TITLE_SYSTEM_PROMPT).toContain("Never preserve it when it names only a component of focus_summary");
		expect(TITLE_SYSTEM_PROMPT).toContain('A session building Meridian Sync remains "Meridian Sync" while discussing its revision DAG, RPC layer, and notification WebSockets');
	});

	test("does not feed a provisional title into the first settled request", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-auto-title-provisional-test-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = directory;
			writeFileSync(join(directory, "auto-session-title.json"), JSON.stringify({
				provider: "test",
				model: "titles",
				thinkingLevel: "off",
			}));

			const handlers = new Map<string, (...args: any[]) => any>();
			const entries: any[] = [];
			const prompts: any[] = [];
			const appliedTitles: string[] = [];
			let sessionName: string | undefined;
			let leafId: string | undefined;
			const pi = {
				on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
				registerCommand() {},
				registerFlag() {},
				getFlag() { return false; },
				getSessionName() { return sessionName; },
				setSessionName(name: string) {
					sessionName = name;
					appliedTitles.push(name);
				},
				appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
			};
			const ctx = {
				cwd: "/home/alex",
				hasUI: false,
				modelRegistry: {
					find: (provider: string, model: string) => ({ provider, id: model }),
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
				},
				sessionManager: {
					getBranch: () => entries,
					getEntries: () => entries,
					getSessionId: () => "session-1",
					getLeafId: () => leafId,
				},
				ui: { notify() {} },
			};
			autoSessionTitle(pi as any, {
				requestCompletion: async (_complete, _model, _auth, _systemPrompt, prompt) => {
					prompts.push(JSON.parse(prompt));
					return prompts.length < 3
						? JSON.stringify({
							turn_summary: prompts.length === 1 ? "Evaluate Context7." : "Evaluated Context7 for Pi.",
							focus_summary: "Evaluate Context7 for Pi.",
							title: "Alex Project",
						})
						: JSON.stringify({
							turn_summary: "Compared Context7 installation options.",
							focus_summary: "Evaluate Context7 for Pi.",
							title: "Context7 Evaluation",
						});
				},
			});
			handlers.get("session_start")?.({ reason: "startup" }, ctx);

			handlers.get("before_agent_start")?.({ prompt: "Would Context7 help Pi?" }, ctx);
			while (sessionName !== "Alex Project") await Bun.sleep(1);

			entries.push(
				{ type: "message", message: { role: "user", content: "Would Context7 help Pi?" } },
				{ type: "message", message: { role: "assistant", content: "Yes, as a supplemental documentation source." } },
			);
			leafId = "assistant-1";
			handlers.get("agent_settled")?.({}, ctx);
			while (entries.filter((entry) => entry.customType === "auto-session-title-state-v2").length < 1) await Bun.sleep(1);

			expect(prompts[0].previous_session_title).toBeNull();
			expect(prompts[1].previous_session_title).toBeNull();
			expect(appliedTitles).toEqual(["Alex Project"]);

			entries.push(
				{ type: "message", message: { role: "user", content: "Compare the installation options." } },
				{ type: "message", message: { role: "assistant", content: "Compared the skill and extension options." } },
			);
			leafId = "assistant-2";
			handlers.get("agent_settled")?.({}, ctx);
			while (prompts.length < 3) await Bun.sleep(1);

			expect(prompts[2].previous_session_title).toBe("Alex Project");
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rejects generated filesystem path titles", () => {
		const path = "/var/folders/sp/fywhcyx14lq17414yv54gyqh0000gn/T/pi-clipboard-1a6dda4b-2944-4d05-9635-7b7194354361.png";
		expect(normalizeTitle(path)).toBeUndefined();
		expect(normalizeTitle(`Screenshot ${path}`)).toBeUndefined();
		expect(normalizeTitle("~/Desktop/screenshot.png")).toBeUndefined();
		expect(normalizeTitle("src/session-title.ts")).toBeUndefined();
		expect(normalizeTitle("Pi Tab Title")).toBe("Pi Tab Title");
	});

	test("reads ordered model fallback config from the Pi agent directory", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-auto-title-test-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = directory;
			writeFileSync(join(directory, "auto-session-title.json"), JSON.stringify({
				models: [{
					provider: "openai-codex",
					model: "gpt-5.6-luna",
					thinkingLevel: "xhigh",
				}, {
					provider: "apple-foundation-models",
					model: "system",
					thinkingLevel: "off",
				}],
			}));

			expect(titleModelConfigPath()).toBe(join(directory, "auto-session-title.json"));
			expect(loadTitleModelConfigs()).toEqual([
				{ provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "xhigh" },
				{ provider: "apple-foundation-models", model: "system", thinkingLevel: "off" },
			]);
			expect(loadTitleModelConfig()).toEqual({ provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "xhigh" });
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("keeps the legacy single-model config", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-auto-title-legacy-test-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = directory;
			writeFileSync(join(directory, "auto-session-title.json"), JSON.stringify({
				provider: "openai-codex",
				model: "gpt-5.6-luna",
				reasoning: "high",
			}));
			expect(loadTitleModelConfigs()).toEqual([
				{ provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "high" },
			]);
			expect(loadTitleModelConfig()).toEqual({ provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "high" });
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("falls back when the preferred model is unavailable", async () => {
		const models = [
			{ provider: "missing", model: "primary", thinkingLevel: "minimal" as const },
			{ provider: "apple-foundation-models", model: "system", thinkingLevel: "off" as const },
		];
		const result = await requestTitleWithFallback(
			{ modelRegistry: { find: () => undefined } },
			models,
			"title system prompt",
			"title context",
			"session-1",
			new AbortController().signal,
			{ requestAppleCompletion: async () => '{"title":"Local Apple Titles"}' },
		);

		expect(result).toMatchObject({
			config: models[1],
			index: 1,
			failures: [{ config: models[0], code: "unavailable", reason: "model unavailable" }],
		});
	});

	test("falls back after malformed, empty, or rejected title responses", async () => {
		const models = [
			{ provider: "test", model: "primary", thinkingLevel: "minimal" as const },
			{ provider: "test", model: "fallback", thinkingLevel: "off" as const },
		];
		const ctx = {
			modelRegistry: {
				find: (provider: string, model: string) => ({ provider, id: model }),
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
			},
		};

		for (const invalidResponse of ["{not-json", "", '{"title":"src/session-title.ts"}']) {
			const result = await requestTitleWithFallback(
				ctx,
				models,
				"title system prompt",
				"title context",
				"session-1",
				new AbortController().signal,
				{
					requestCompletion: async (_complete, model) => model.id === "primary"
						? invalidResponse
						: '{"title":"Valid Fallback"}',
				},
			);
			expect(result?.index).toBe(1);
			expect(result?.failures[0].code).toBe("invalid-response");
		}
	});

	test("warns once while the same fallback remains active", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-auto-title-warning-test-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = directory;
			writeFileSync(join(directory, "auto-session-title.json"), JSON.stringify({
				models: [
					{ provider: "test", model: "primary", thinkingLevel: "minimal" },
					{ provider: "test", model: "fallback", thinkingLevel: "off" },
				],
			}));

			const handlers = new Map<string, (...args: any[]) => any>();
			const notifications: Array<{ message: string; level: string }> = [];
			let sessionName: string | undefined;
			let requestCount = 0;
			const pi = {
				on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
				registerCommand() {},
				registerFlag() {},
				getFlag() { return false; },
				getSessionName() { return sessionName; },
				setSessionName(name: string) { sessionName = name; },
				appendEntry() {},
			};
			const ctx = {
				cwd: "/tmp/project",
				hasUI: true,
				modelRegistry: {
					find: (provider: string, model: string) => ({ provider, id: model }),
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
				},
				sessionManager: {
					getBranch: () => [],
					getEntries: () => [],
					getSessionId: () => "session-1",
					getLeafId: () => undefined,
				},
				ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
			};
			autoSessionTitle(pi as any, {
				requestCompletion: async (_complete, model) => {
					requestCount += 1;
					if (model.id === "primary") throw new Error("temporarily unavailable");
					return '{"turn_summary":"Fallback worked.","focus_summary":"Maintain titles.","title":"Fallback Titles"}';
				},
			});
			handlers.get("session_start")?.({ reason: "startup" }, ctx);

			handlers.get("before_agent_start")?.({ prompt: "Name this session" }, ctx);
			while (requestCount < 2) await Bun.sleep(1);
			await Bun.sleep(1);
			handlers.get("before_agent_start")?.({ prompt: "Name this session again" }, ctx);
			while (requestCount < 4) await Bun.sleep(1);
			await Bun.sleep(1);

			const warnings = notifications.filter(({ level }) => level === "warning");
			expect(warnings).toEqual([{
				level: "warning",
				message: "Auto-title fallback: test/primary failed (temporarily unavailable); using test/fallback.",
			}]);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("restores manual-title locks from persisted generated state", () => {
		expect(sessionTitleIsManual(undefined, undefined)).toBe(false);
		expect(sessionTitleIsManual("Meridian Sync", "meridian   sync")).toBe(false);
		expect(sessionTitleIsManual("My Preferred Name", "Meridian Sync")).toBe(true);
		expect(sessionTitleIsManual("My Preferred Name", undefined)).toBe(true);
	});

	test("keeps a restored manual title locked after settlement", async () => {
		const handlers = new Map<string, (...args: any[]) => any>();
		const commands = new Map<string, any>();
		const notifications: string[] = [];
		const entries = [{
			type: "custom",
			customType: "auto-session-title-state-v2",
			data: {
				version: 2,
				turnSummary: "Implemented durable session titles.",
				focusSummary: "Maintain descriptive session titles.",
				title: "Generated Title",
				createdAt: "2026-08-15T00:00:00.000Z",
			},
		}];
		const pi = {
			on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
			registerCommand(name: string, command: any) { commands.set(name, command); },
			registerFlag() {},
			getFlag() { return false; },
			getSessionName() { return "My Preferred Name"; },
			setSessionName() { throw new Error("manual title must not be replaced"); },
			appendEntry() { throw new Error("manual title must not append state"); },
		};
		const ctx = {
			sessionManager: {
				getBranch: () => entries,
				getEntries: () => entries,
				getSessionId: () => "session-1",
				getLeafId: () => "leaf-1",
			},
			ui: { notify: (message: string) => notifications.push(message) },
		};

		autoSessionTitle(pi as any);
		handlers.get("session_start")?.({ reason: "resume" }, ctx);
		handlers.get("agent_settled")?.({}, ctx);
		await commands.get("title-status").handler("", ctx);

		expect(notifications.at(-1)).toContain("manual lock: yes");
		expect(notifications.at(-1)).toContain("last skip: manual title lock");
	});

	test("disables automatic title generation for one Pi run", async () => {
		const handlers = new Map<string, (...args: any[]) => any>();
		const commands = new Map<string, any>();
		const flags = new Map<string, any>();
		const notifications: string[] = [];
		const pi = {
			on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
			registerCommand(name: string, command: any) { commands.set(name, command); },
			registerFlag(name: string, options: any) { flags.set(name, options); },
			getFlag(name: string) { return name === "no-auto-title"; },
			getSessionName() { return undefined; },
			setSessionName() { throw new Error("disabled auto-title must not rename the session"); },
			appendEntry() { throw new Error("disabled auto-title must not append state"); },
		};
		const ctx = {
			sessionManager: {
				getBranch: () => [],
				getEntries: () => [],
				getSessionId: () => "session-1",
				getLeafId: () => "leaf-1",
			},
			ui: { notify: (message: string) => notifications.push(message) },
		};

		autoSessionTitle(pi as any);
		handlers.get("session_start")?.({ reason: "resume" }, ctx);
		handlers.get("agent_settled")?.({}, ctx);
		await commands.get("title-status").handler("", ctx);

		expect(flags.get("no-auto-title")).toEqual({
			description: "Disable automatic session title generation for this run",
			type: "boolean",
			default: false,
		});
		expect(notifications.at(-1)).toContain("automatic updates: disabled (--no-auto-title)");
		expect(notifications.at(-1)).toContain("last skip: disabled by --no-auto-title");
	});

	test("recognizes only the Apple system model backend", () => {
		expect(isAppleTitleModel("apple-foundation-models", "system")).toBe(true);
		expect(isAppleTitleModel("apple-foundation-models", "other")).toBe(false);
		expect(isAppleTitleModel("mistral", "system")).toBe(false);
	});

	test("content-addresses the compiled Apple helper cache", () => {
		const agentDir = "/tmp/pi-agent-test";
		const first = appleHelperBinaryPath(Buffer.from("first"), agentDir);
		const repeated = appleHelperBinaryPath(Buffer.from("first"), agentDir);
		const changed = appleHelperBinaryPath(Buffer.from("changed"), agentDir);
		const otherAgentDir = appleHelperBinaryPath(Buffer.from("first"), "/tmp/other-pi-agent-test");

		expect(first).toBe(repeated);
		expect(changed).not.toBe(first);
		expect(otherAgentDir).not.toBe(first);
		expect(first.startsWith(join(agentDir, "cache", "auto-session-title", "apple-model-"))).toBe(true);
	});

	test("constrains Apple titles with deterministic bounded generation", () => {
		const source = readFileSync(join(import.meta.dir, "apple-model.swift"), "utf8");
		expect(source).toContain("sampling: .greedy");
		expect(source).toContain("maximumResponseTokens: 256");
		expect(source).toContain("Repeat(0...2)");
		expect(source).toContain("SystemLanguageModel.default");
	});

	test("reports malformed native input without trapping", () => {
		if (process.platform !== "darwin") return;
		const directory = mkdtempSync(join(tmpdir(), "pi-apple-title-helper-test-"));
		const binary = join(directory, "apple-title-helper");
		try {
			const source = join(import.meta.dir, "apple-model.swift");
			const compilation = spawnSync("/usr/bin/xcrun", ["swiftc", "-parse-as-library", source, "-o", binary], { encoding: "utf8" });
			expect(compilation.status).toBe(0);
			expect(compilation.stderr).toBe("");

			const execution = spawnSync(binary, [], { input: "not-json", encoding: "utf8" });
			expect(execution.status).toBe(1);
			expect(execution.signal).toBeNull();
			expect(execution.stderr).toContain("Apple Foundation Model helper failed:");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("routes Apple titles through the local helper", async () => {
		let invocation: any;
		const response = await requestAppleTitleCompletion(
			"title system prompt",
			"title context",
			new AbortController().signal,
			async (request, signal) => {
				invocation = { request, aborted: signal.aborted };
				return '{"title":"Local Apple Titles"}';
			},
		);

		expect(response).toBe('{"title":"Local Apple Titles"}');
		expect(invocation).toEqual({
			request: { systemPrompt: "title system prompt", prompt: "title context" },
			aborted: false,
		});
	});

	test("routes Codex Luna through Pi's provider-aware completion API", async () => {
		const model = {
			provider: "openai-codex",
			id: "gpt-5.6-luna",
		};
		const auth = {
			apiKey: "test-token",
			headers: { "x-test": "header" },
			env: { TEST_ENV: "value" },
		};
		let invocation: any[] | undefined;
		const response = await requestTitleCompletion(
			async (...args: any[]) => {
				invocation = args;
				return {
					content: [{ type: "text", text: '{"title":"Luna Session Titles"}' }],
					stopReason: "stop",
				};
			},
			model,
			auth,
			"title system prompt",
			"title context",
			"session-1",
			new AbortController().signal,
			"xhigh",
		);

		expect(response).toBe('{"title":"Luna Session Titles"}');
		expect(invocation?.[0]).toBe(model);
		expect(invocation?.[1]).toMatchObject({
			systemPrompt: "title system prompt",
			messages: [{ role: "user", content: [{ type: "text", text: "title context" }] }],
		});
		expect(invocation?.[2]).toMatchObject({
			apiKey: "test-token",
			headers: { "x-test": "header" },
			env: { TEST_ENV: "value" },
			maxTokens: 384,
			reasoning: "xhigh",
			sessionId: "session-1:title",
		});
	});
});
