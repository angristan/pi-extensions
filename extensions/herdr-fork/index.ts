import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERDR_TIMEOUT_MS = 5_000;
/** How long Herdr may wait for the new Pi to be ready for input. */
const PI_READY_TIMEOUT_MS = 30_000;
/** How long a new pane's shell may take to reach its prompt. */
const SHELL_READY_TIMEOUT_MS = 10_000;
const SHELL_RETRY_MS = 150;
const STALE_DRAFT_MS = 24 * 60 * 60 * 1000;
const DRAFT_ENV = "PI_HERDR_FORK_DRAFT";
const DRAFT_FILE_PATTERN = /^pi-herdr-fork-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.txt$/;

type Destination = "pane-right" | "pane-down" | "tab" | "workspace";
type ForkPosition = "before" | "at";

export const CURRENT_PANE_LABEL = "Current pane";
export const DESTINATIONS: ReadonlyArray<readonly [label: string, destination: Destination]> = [
	["New pane to the right", "pane-right"],
	["New pane below", "pane-down"],
	["New tab", "tab"],
	["New workspace", "workspace"],
];

interface ExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

export interface ForkedSession {
	sessionFile: string;
	/** Prompt text Pi restores to the editor after an in-place fork. */
	draft?: string;
}

type ForkSource = {
	getCwd(): string;
	getSessionDir(): string;
	getSessionFile(): string | undefined;
	getEntry(id: string): any;
};

interface RuntimeDependencies {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	exec?: (command: string, args: string[], options?: { timeout?: number }) => Promise<ExecResult>;
	createForkedSession?: (source: ForkSource, entryId: string, position: ForkPosition) => ForkedSession;
	writeDraft?: (text: string) => string;
	sleep?: (ms: number) => Promise<void>;
}

function userMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("");
}

/**
 * Write a fork to a new session file without replacing the running session.
 * Mirrors Pi's in-place fork: "before" branches from the prompt's parent and
 * returns the prompt as a draft; "at" (clone) keeps the selected entry.
 */
export function createForkedSession(source: ForkSource, entryId: string, position: ForkPosition): ForkedSession {
	const currentFile = source.getSessionFile();
	const entry = source.getEntry(entryId);
	if (!currentFile || !entry) throw new Error("Invalid entry ID for forking");

	let leafId: string | null;
	let draft: string | undefined;
	if (position === "at") {
		leafId = entry.id;
	} else {
		if (entry.type !== "message" || entry.message?.role !== "user") throw new Error("Invalid entry ID for forking");
		leafId = entry.parentId ?? null;
		draft = userMessageText(entry.message.content);
	}

	let fork: SessionManager;
	if (leafId) {
		fork = SessionManager.open(currentFile, source.getSessionDir());
		if (!fork.createBranchedSession(leafId)) throw new Error("Failed to create forked session");
	} else {
		fork = SessionManager.create(source.getCwd(), source.getSessionDir());
		fork.newSession({ parentSession: currentFile });
	}
	return { sessionFile: persistSession(fork), draft };
}

/**
 * Pi writes a session file only once it has a reply. A fork before the first
 * reply must still exist for the new process, with its parent and setup entries.
 */
function persistSession(session: SessionManager): string {
	const path = session.getSessionFile();
	if (!path) throw new Error("Failed to create forked session");
	if (!existsSync(path)) {
		const lines = [session.getHeader(), ...session.getEntries()].map((entry) => JSON.stringify(entry));
		writeFileSync(path, `${lines.join("\n")}\n`, { flag: "wx" });
	}
	return path;
}

function writeDraftFile(text: string): string {
	const path = join(tmpdir(), `pi-herdr-fork-${randomUUID()}.txt`);
	writeFileSync(path, text, { mode: 0o600, flag: "wx" });
	return path;
}

/**
 * Read and delete a draft handed over through the environment. The path is
 * untrusted, so only a private regular file of this user, named and placed as
 * writeDraftFile creates it, is read and removed.
 */
export function takeDraft(path: string): string | undefined {
	if (dirname(path) !== tmpdir() || !DRAFT_FILE_PATTERN.test(basename(path))) return undefined;
	let fd: number | undefined;
	try {
		// Non-blocking so a FIFO cannot stall startup before fstat rejects it.
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stats = fstatSync(fd);
		const uid = process.getuid?.();
		if (!stats.isFile() || (stats.mode & 0o077) !== 0 || (uid !== undefined && stats.uid !== uid)) return undefined;
		const draft = readFileSync(fd, "utf8");
		rmSync(path, { force: true });
		return draft;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Delete this user's drafts that no new Pi picked up, such as one without this extension. */
export function removeStaleDrafts(now = Date.now()): void {
	const directory = tmpdir();
	const uid = process.getuid?.();
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return;
	}
	for (const name of names) {
		if (!DRAFT_FILE_PATTERN.test(name)) continue;
		const path = join(directory, name);
		try {
			const stats = lstatSync(path);
			if (!stats.isFile() || (uid !== undefined && stats.uid !== uid) || now - stats.mtimeMs < STALE_DRAFT_MS) continue;
			rmSync(path, { force: true });
		} catch {
			// Another Pi may have removed it first.
		}
	}
}

/**
 * Herdr agent names are unique among live agents: a lowercase letter, then
 * lowercase letters, digits, '-' or '_'. Session IDs start with a timestamp,
 * so the name uses their random end.
 */
function agentName(verb: string, sessionFile: string): string {
	const id = basename(sessionFile, ".jsonl").split("_").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-8);
	return id ? `${verb}-${id}` : verb;
}

/** Cleanup must not throw: Pi would then fork in place after a failed Herdr fork. */
function removeQuietly(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// Stale drafts are swept later; a leftover fork is an unused session.
	}
}

class HerdrError extends Error {
	constructor(readonly operation: string, readonly code: string | undefined, message: string) {
		super(`Herdr ${operation} failed: ${message}`);
	}
}

function parseJson(text: string, operation: string): any {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Herdr ${operation} returned invalid JSON.`);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Offer Herdr panes, tabs, and workspaces as destinations for Pi's fork and clone. */
export default function herdrFork(pi: ExtensionAPI, dependencies: RuntimeDependencies = {}) {
	const env = dependencies.env ?? process.env;
	if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID) return;
	// Draft checks rely on POSIX file modes and owners; untested on Windows.
	if ((dependencies.platform ?? process.platform) === "win32") return;

	const exec = dependencies.exec ?? ((command, args, options) => pi.exec(command, args, options));
	const forkSession = dependencies.createForkedSession ?? createForkedSession;
	const writeDraft = dependencies.writeDraft ?? writeDraftFile;
	const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	// Herdr exports its own binary to panes; PATH may differ from the shell's.
	const herdr = env.HERDR_BIN_PATH || "herdr";

	const runHerdr = async (args: string[], timeout = HERDR_TIMEOUT_MS): Promise<string> => {
		const result = await exec(herdr, args, { timeout });
		if (result.code === 0) return result.stdout;
		const operation = args.slice(0, 2).join(" ");
		let code: string | undefined;
		let message = (result.stderr || result.stdout || `exit code ${result.code ?? "unknown"}`).trim();
		// Herdr reports errors as JSON on stderr.
		for (const output of [result.stderr, result.stdout]) {
			try {
				const error = JSON.parse(output)?.error;
				if (typeof error?.message === "string") message = error.message;
				if (typeof error?.code === "string") code = error.code;
				break;
			} catch {
				// Not JSON; try the other stream or keep the plain text.
			}
		}
		throw new HerdrError(operation, code, message.slice(0, 500));
	};

	/** Start Pi through Herdr, which passes arguments without shell quoting and waits until Pi is ready. */
	const startPi = async (paneId: string, name: string, args: string[]): Promise<void> => {
		const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
		for (;;) {
			try {
				await runHerdr(
					["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", String(PI_READY_TIMEOUT_MS), "--", ...args],
					PI_READY_TIMEOUT_MS + HERDR_TIMEOUT_MS,
				);
				return;
			} catch (error) {
				// A new pane is busy until its shell reaches the prompt.
				if (!(error instanceof HerdrError) || error.code !== "agent_pane_busy" || Date.now() > deadline) throw error;
				await sleep(SHELL_RETRY_MS);
			}
		}
	};
	const createInHerdr = async (args: string[]): Promise<any> =>
		parseJson(await runHerdr(args), args.slice(0, 2).join(" "));

	interface Opened {
		paneId: string;
		place: string;
		/** Herdr command that removes everything this destination created. */
		close: string[];
	}

	/** Create the destination and return its new shell pane. */
	const openDestination = async (destination: Destination, cwd: string, label: string, extraArgs: string[]): Promise<Opened> => {
		let paneId: unknown;
		let place: string;
		let close: string[];
		if (destination === "pane-right" || destination === "pane-down") {
			const direction = destination === "pane-right" ? "right" : "down";
			const payload = await createInHerdr(["pane", "split", "--current", "--direction", direction, "--cwd", cwd, "--focus", ...extraArgs]);
			paneId = payload?.result?.pane?.pane_id;
			place = `new pane ${paneId}`;
			close = ["pane", "close", String(paneId)];
		} else if (destination === "tab") {
			const workspace = env.HERDR_WORKSPACE_ID ? ["--workspace", env.HERDR_WORKSPACE_ID] : [];
			const payload = await createInHerdr(["tab", "create", ...workspace, "--cwd", cwd, "--label", label, "--focus", ...extraArgs]);
			const tabId = payload?.result?.tab?.tab_id;
			paneId = payload?.result?.root_pane?.pane_id;
			place = `new tab ${tabId ?? paneId}`;
			close = typeof tabId === "string" ? ["tab", "close", tabId] : ["pane", "close", String(paneId)];
		} else {
			const payload = await createInHerdr(["workspace", "create", "--cwd", cwd, "--focus", ...extraArgs]);
			const workspace = payload?.result?.workspace;
			paneId = payload?.result?.root_pane?.pane_id;
			place = `new workspace ${workspace?.label ?? workspace?.workspace_id ?? paneId}`;
			close = typeof workspace?.workspace_id === "string"
				? ["workspace", "close", workspace.workspace_id]
				: ["pane", "close", String(paneId)];
		}
		if (typeof paneId !== "string" || !paneId) {
			if (close[0] !== "pane") await runHerdr(close).catch(() => undefined);
			throw new Error(`Herdr did not return a pane for the ${destination.replace("-", " ")}.`);
		}
		return { paneId, place, close };
	};

	pi.on("session_before_fork", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Another Pi process can open only a saved session; keep Pi's own handling otherwise.
		const currentFile = ctx.sessionManager.getSessionFile();
		if (!currentFile || !existsSync(currentFile)) return;

		const verb = event.position === "at" ? "clone" : "fork";
		const choice = await ctx.ui.select(`Open ${verb} in`, [CURRENT_PANE_LABEL, ...DESTINATIONS.map(([label]) => label)]);
		if (choice === undefined) return { cancel: true };
		const destination = DESTINATIONS.find(([label]) => label === choice)?.[1];
		if (!destination) return;

		let fork: ForkedSession | undefined;
		let draftPath: string | undefined;
		let opened: Opened | undefined;
		try {
			fork = forkSession(ctx.sessionManager, event.entryId, event.position);
			draftPath = fork.draft ? writeDraft(fork.draft) : undefined;
			const label = pi.getSessionName()?.trim() || verb;
			opened = await openDestination(destination, ctx.cwd, label, draftPath ? ["--env", `${DRAFT_ENV}=${draftPath}`] : []);
			await startPi(opened.paneId, agentName(verb, fork.sessionFile), ["--session", fork.sessionFile]);
			ctx.ui.notify(`${verb === "fork" ? "Forked" : "Cloned"} into ${opened.place}.`, "info");
		} catch (error) {
			// Pi may have started after Herdr stopped waiting; keep its files unless its pane is gone.
			const closed = !opened || await runHerdr(opened.close).then(() => true, () => false);
			if (closed && draftPath) removeQuietly(draftPath);
			if (closed && fork) removeQuietly(fork.sessionFile);
			ctx.ui.notify(`Could not open the ${verb} in Herdr: ${errorMessage(error)}`, "error");
		}
		// The fork now lives in Herdr (or failed); keep this session in place.
		return { cancel: true };
	});

	pi.on("session_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.reason === "startup") removeStaleDrafts();
		const draftPath = env[DRAFT_ENV];
		if (!draftPath) return;
		// The variable stays in the pane's shell; the deleted file makes later Pi runs ignore it.
		delete env[DRAFT_ENV];
		const draft = takeDraft(draftPath);
		if (draft && !ctx.ui.getEditorText()) ctx.ui.setEditorText(draft);
	});
}
