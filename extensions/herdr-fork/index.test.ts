import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import registerHerdrFork, { createForkedSession, CURRENT_PANE_LABEL, removeStaleDrafts, takeDraft } from "./index";

// File modes, owners, symlinks, and FIFOs are POSIX-only; the extension is off on Windows.
const posixTest = test.skipIf(process.platform === "win32");
const FORK_NAME = "2026-09-28T15-56-05-767Z_01a0e8bb-0507-71cd-b898-aaa1f80bb094.jsonl";

const temporaryPaths: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "herdr-fork-test-"));
	temporaryPaths.push(directory);
	return directory;
}

/** A path shaped like the extension's own draft files. */
function draftPath(directory = tmpdir()): string {
	const path = join(directory, `pi-herdr-fork-${randomUUID()}.txt`);
	temporaryPaths.push(path);
	return path;
}

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function ok(stdout = "") {
	return { stdout, stderr: "", code: 0 };
}

function assistant(text: string): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test-provider",
		model: "test-model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createHarness(options: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	mode?: string;
	choice?: string;
	sessionFile?: string | null;
	sessionName?: string;
	fork?: { sessionFile: string; draft?: string };
	/** Herdr error returned by `agent start`, after `busy` shell-not-ready replies. */
	startError?: { code: string; message: string };
	busy?: number;
	closeFails?: boolean;
} = {}) {
	const directory = temporaryDirectory();
	const savedSession = join(directory, "current.jsonl");
	writeFileSync(savedSession, "{}\n");
	const forkFile = options.fork?.sessionFile ?? join(directory, FORK_NAME);
	const draftFile = join(directory, "pi-herdr-fork-0000.txt");
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const calls: string[][] = [];
	const commands: string[] = [];
	let busy = options.busy ?? 0;
	const selections: Array<{ title: string; options: string[] }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	let editorText = "";
	const env = options.env ?? { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" };

	const herdrError = (code: string, message: string) => ({ stdout: "", stderr: JSON.stringify({ error: { code, message } }), code: 1 });
	const exec = async (command: string, args: string[]) => {
		calls.push(args);
		commands.push(command);
		if (args[0] === "pane" && args[1] === "split") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }));
		if (args[0] === "tab" && args[1] === "create") {
			return ok(JSON.stringify({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p3" } } }));
		}
		if (args[0] === "workspace" && args[1] === "create") {
			return ok(JSON.stringify({ result: { workspace: { workspace_id: "w2", label: "repo" }, root_pane: { pane_id: "w2:p1" } } }));
		}
		if (args[0] === "agent" && args[1] === "start") {
			if (busy-- > 0) return herdrError("agent_pane_busy", "agent target pane is not an available shell");
			if (options.startError) return herdrError(options.startError.code, options.startError.message);
		}
		if (args[1] === "close" && options.closeFails) return herdrError("close_failed", "cannot close");
		return ok();
	};
	const ctx = {
		mode: options.mode ?? "tui",
		cwd: "/repo",
		sessionManager: {
			getSessionFile: () => (options.sessionFile === null ? undefined : options.sessionFile ?? savedSession),
		},
		ui: {
			select: async (title: string, choices: string[]) => {
				selections.push({ title, options: choices });
				return options.choice;
			},
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			getEditorText: () => editorText,
			setEditorText: (text: string) => { editorText = text; },
		},
	};
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		getSessionName: () => options.sessionName,
	};
	registerHerdrFork(pi as any, {
		env,
		platform: options.platform ?? "linux",
		exec,
		createForkedSession: () => {
			if (options.fork) return options.fork;
			writeFileSync(forkFile, "{}\n");
			return { sessionFile: forkFile, draft: "Try the other approach" };
		},
		writeDraft: (text) => {
			writeFileSync(draftFile, text);
			return draftFile;
		},
		sleep: async () => {},
	});
	const fork = async (position: "before" | "at" = "before") => {
		let result: unknown;
		for (const handler of handlers.get("session_before_fork") ?? []) {
			result = await handler({ type: "session_before_fork", entryId: "entry-2", position }, ctx);
		}
		return result;
	};
	const start = async () => {
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	};
	return { handlers, calls, commands, selections, notifications, fork, start, env, forkFile, draftFile, editor: () => editorText };
}

const startPi = (name: string, pane: string, sessionFile: string) =>
	["agent", "start", name, "--kind", "pi", "--pane", pane, "--timeout", "30000", "--", "--session", sessionFile];

describe("herdr-fork", () => {
	test("stays inactive outside a Herdr-managed TUI", async () => {
		expect(createHarness({ env: {} }).handlers.size).toBe(0);
		expect(createHarness({ platform: "win32" }).handlers.size).toBe(0);

		const headless = createHarness({ mode: "print", choice: "New tab" });
		expect(await headless.fork()).toBeUndefined();
		expect(headless.selections).toEqual([]);
	});

	test("leaves unsaved sessions to Pi's own fork handling", async () => {
		const harness = createHarness({ sessionFile: null, choice: "New tab" });
		expect(await harness.fork()).toBeUndefined();
		expect(harness.selections).toEqual([]);
		expect(harness.calls).toEqual([]);
	});

	test("keeps the in-place fork for the current pane and cancels on escape", async () => {
		const current = createHarness({ choice: CURRENT_PANE_LABEL });
		expect(await current.fork()).toBeUndefined();
		expect(current.selections).toEqual([{
			title: "Open fork in",
			options: ["Current pane", "New pane to the right", "New pane below", "New tab", "New workspace"],
		}]);
		expect(current.calls).toEqual([]);

		const dismissed = createHarness({ choice: undefined });
		expect(await dismissed.fork()).toEqual({ cancel: true });
		expect(dismissed.calls).toEqual([]);
	});

	test("starts Pi as a Herdr agent in a focused split once its shell is ready", async () => {
		const harness = createHarness({ choice: "New pane to the right", busy: 2 });
		expect(await harness.fork()).toEqual({ cancel: true });
		const start = startPi("fork-f80bb094", "w1:p2", harness.forkFile);
		expect(harness.calls).toEqual([
			["pane", "split", "--current", "--direction", "right", "--cwd", "/repo", "--focus", "--env", `PI_HERDR_FORK_DRAFT=${harness.draftFile}`],
			start,
			start,
			start,
		]);
		expect(harness.commands.every((command) => command === "herdr")).toBe(true);
		expect(readFileSync(harness.draftFile, "utf8")).toBe("Try the other approach");
		expect(harness.notifications).toEqual([{ message: "Forked into new pane w1:p2.", type: "info" }]);
	});

	test("opens clones in a labeled tab or a new workspace", async () => {
		const spaced = `/sessions/my forks/${FORK_NAME}`;
		const tab = createHarness({ choice: "New tab", sessionName: "Refactor auth", fork: { sessionFile: spaced } });
		expect(await tab.fork("at")).toEqual({ cancel: true });
		expect(tab.selections[0].title).toBe("Open clone in");
		expect(tab.calls).toEqual([
			["tab", "create", "--workspace", "w1", "--cwd", "/repo", "--label", "Refactor auth", "--focus"],
			startPi("clone-f80bb094", "w1:p3", spaced),
		]);
		expect(tab.notifications[0].message).toBe("Cloned into new tab w1:t2.");

		const workspace = createHarness({
			choice: "New workspace",
			fork: { sessionFile: "/sessions/clone.jsonl" },
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: "/opt/herdr/bin/herdr" },
		});
		await workspace.fork("at");
		expect(workspace.calls).toEqual([
			["workspace", "create", "--cwd", "/repo", "--focus"],
			startPi("clone-clone", "w2:p1", "/sessions/clone.jsonl"),
		]);
		expect(workspace.commands).toEqual(["/opt/herdr/bin/herdr", "/opt/herdr/bin/herdr"]);
		expect(workspace.notifications[0].message).toBe("Cloned into new workspace repo.");
	});

	test("keeps the fork when a timed-out destination cannot be closed", async () => {
		const harness = createHarness({
			choice: "New pane below",
			startError: { code: "agent_start_timeout", message: "pi was not ready" },
			closeFails: true,
		});
		expect(await harness.fork()).toEqual({ cancel: true });
		expect(harness.calls.at(-1)).toEqual(["pane", "close", "w1:p2"]);
		expect(existsSync(harness.forkFile)).toBe(true);
		expect(existsSync(harness.draftFile)).toBe(true);
		expect(harness.notifications[0].type).toBe("error");
	});

	test("removes what it created when Pi does not start", async () => {
		const startError = { code: "agent_start_timeout", message: "pi was not ready" };
		const pane = createHarness({ choice: "New pane below", startError });
		expect(await pane.fork()).toEqual({ cancel: true });
		expect(pane.calls.at(-1)).toEqual(["pane", "close", "w1:p2"]);
		expect(existsSync(pane.forkFile)).toBe(false);
		expect(existsSync(pane.draftFile)).toBe(false);
		expect(pane.notifications).toEqual([
			{ message: "Could not open the fork in Herdr: Herdr agent start failed: pi was not ready", type: "error" },
		]);

		const tab = createHarness({ choice: "New tab", startError });
		await tab.fork();
		expect(tab.calls.at(-1)).toEqual(["tab", "close", "w1:t2"]);

		const workspace = createHarness({ choice: "New workspace", startError });
		await workspace.fork();
		expect(workspace.calls.at(-1)).toEqual(["workspace", "close", "w2"]);
	});

	posixTest("still cancels the in-place fork when cleanup cannot remove files", async () => {
		const locked = temporaryDirectory();
		const sessionFile = join(locked, FORK_NAME);
		writeFileSync(sessionFile, "{}\n");
		chmodSync(locked, 0o500);
		try {
			const harness = createHarness({ choice: "New pane below", fork: { sessionFile }, startError: { code: "x", message: "no pi" } });
			expect(await harness.fork()).toEqual({ cancel: true });
			expect(harness.notifications[0].type).toBe("error");
		} finally {
			chmodSync(locked, 0o700);
		}
	});

	posixTest("restores a handed-over draft once in the new Pi", async () => {
		const draft = draftPath();
		writeFileSync(draft, "Try the other approach", { mode: 0o600, flag: "wx" });
		const harness = createHarness({ env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", PI_HERDR_FORK_DRAFT: draft } });
		await harness.start();
		expect(harness.editor()).toBe("Try the other approach");
		expect(existsSync(draft)).toBe(false);
		expect(harness.env.PI_HERDR_FORK_DRAFT).toBeUndefined();
	});

	posixTest("ignores inherited draft paths it did not create", () => {
		const outside = draftPath(temporaryDirectory());
		writeFileSync(outside, "keep me", { mode: 0o600 });
		expect(takeDraft(outside)).toBeUndefined();
		expect(existsSync(outside)).toBe(true);

		const secret = join(temporaryDirectory(), "secret.txt");
		writeFileSync(secret, "keep me", { mode: 0o600 });
		const link = draftPath();
		symlinkSync(secret, link);
		expect(takeDraft(link)).toBeUndefined();
		expect(readFileSync(secret, "utf8")).toBe("keep me");

		const shared = draftPath();
		writeFileSync(shared, "keep me");
		chmodSync(shared, 0o644);
		expect(takeDraft(shared)).toBeUndefined();
		expect(existsSync(shared)).toBe(true);

		expect(takeDraft(join(tmpdir(), "notes.txt"))).toBeUndefined();

		// Opening a FIFO without a writer would block startup.
		const fifo = draftPath();
		expect(spawnSync("mkfifo", ["-m", "600", fifo]).status).toBe(0);
		expect(takeDraft(fifo)).toBeUndefined();
		expect(existsSync(fifo)).toBe(true);
	});

	test("removes day-old drafts that no Pi picked up", () => {
		const old = draftPath();
		const fresh = draftPath();
		for (const path of [old, fresh]) writeFileSync(path, "draft", { mode: 0o600 });
		const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		utimesSync(old, twoDaysAgo, twoDaysAgo);
		removeStaleDrafts();
		expect(existsSync(old)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});
});

describe("createForkedSession", () => {
	test("matches Pi's fork and clone branch points without switching sessions", () => {
		const directory = temporaryDirectory();
		const session = SessionManager.create("/repo", directory);
		session.appendMessage({ role: "user", content: "First prompt", timestamp: Date.now() });
		session.appendMessage(assistant("First answer"));
		const secondPrompt = session.appendMessage({ role: "user", content: [{ type: "text", text: "Second prompt" }], timestamp: Date.now() });
		session.appendMessage(assistant("Second answer"));
		const originalFile = session.getSessionFile();

		const fork = createForkedSession(session, secondPrompt, "before");
		expect(fork.draft).toBe("Second prompt");
		expect(fork.sessionFile).not.toBe(originalFile);
		const forked = SessionManager.open(fork.sessionFile).getBranch();
		expect(forked.map((entry: any) => entry.message?.role)).toEqual(["user", "assistant"]);
		expect(SessionManager.open(fork.sessionFile).getHeader()?.parentSession).toBe(originalFile);

		const clone = createForkedSession(session, session.getLeafId()!, "at");
		expect(clone.draft).toBeUndefined();
		expect(SessionManager.open(clone.sessionFile).getBranch()).toHaveLength(4);
		expect(session.getSessionFile()).toBe(originalFile);
	});

	test("writes forks before the first reply with their parent and setup entries", () => {
		const directory = temporaryDirectory();
		const session = SessionManager.create("/repo", directory);
		const firstPrompt = session.appendMessage({ role: "user", content: "First prompt", timestamp: Date.now() });
		session.appendMessage(assistant("First answer"));
		const originalFile = session.getSessionFile();

		const empty = createForkedSession(session, firstPrompt, "before");
		expect(empty).toMatchObject({ draft: "First prompt" });
		expect(empty.sessionFile.startsWith(directory)).toBe(true);
		const reopened = SessionManager.open(empty.sessionFile);
		expect(reopened.getHeader()?.parentSession).toBe(originalFile);
		expect(reopened.getEntries()).toEqual([]);

		const configured = SessionManager.create("/repo", directory);
		configured.appendModelChange("test-provider", "test-model");
		const prompt = configured.appendMessage({ role: "user", content: "Configured prompt", timestamp: Date.now() });
		configured.appendMessage(assistant("Configured answer"));
		const fork = SessionManager.open(createForkedSession(configured, prompt, "before").sessionFile);
		expect(fork.getHeader()?.parentSession).toBe(configured.getSessionFile());
		expect(fork.getEntries().map((entry) => entry.type)).toEqual(["model_change"]);

		// The new Pi appends to the written file without a second header.
		fork.appendMessage({ role: "user", content: "Next", timestamp: Date.now() });
		fork.appendMessage(assistant("Reply"));
		const lines = readFileSync(fork.getSessionFile()!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(lines.filter((line) => line.type === "session")).toHaveLength(1);
		expect(lines.map((line) => line.type)).toEqual(["session", "model_change", "message", "message"]);

		expect(() => createForkedSession(session, "missing-entry", "before")).toThrow("Invalid entry ID");
	});
});
