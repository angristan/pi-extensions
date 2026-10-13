import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import mistralConnectors from "./index";

initTheme("dark", false);

const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
const originalFetch = globalThis.fetch;
let agentDirectory: string;

beforeEach(() => {
	agentDirectory = mkdtempSync(join(tmpdir(), "mistral-connectors-"));
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	rmSync(agentDirectory, { recursive: true, force: true });
	if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
});

const connector = (name: string) => ({ id: `id-${name}`, name, status: { is_ready: true }, tools: [{ name: "read", annotations: { readOnlyHint: true } }] });

/** Serves bootstrap payloads in order and records each request. */
function serve(...payloads: unknown[]) {
	const requests: { url: string; authorization: string | null }[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		return Response.json(payloads.shift());
	}) as typeof fetch;
	return requests;
}

function load() {
	const calls: string[] = [];
	const configs = new Map<string, any>();
	let command: any;
	let sessionStart: any;
	const notices: string[] = [];
	mistralConnectors({
		registerCommand: (_name: string, options: any) => (command = options),
		on: (event: string, handler: any) => event === "session_start" && (sessionStart = handler),
		registerMcpServer: (name: string, config: any) => {
			calls.push(`register ${name}`);
			configs.set(name, config);
		},
		unregisterMcpServer: (name: string) => calls.push(`unregister ${name}`),
	} as any);
	const ctx = {
		hasUI: false,
		mode: "tui",
		modelRegistry: { getApiKeyForProvider: async (provider: string) => (provider === "mistral" ? "test-key" : undefined) },
		ui: {
			notify: (message: string) => notices.push(message),
			// Drives the checklist like a user: render, toggle the first tool, then close with Escape.
			custom: (factory: any) =>
				new Promise<void>((resolve) => {
					const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
					const component = factory({ requestRender: () => {} }, theme, {}, resolve);
					notices.push(component.render(80).join("\n"));
					component.handleInput("\r");
					component.handleInput("\x1b");
				}),
		},
	};
	const run = (args: string) => command.handler(args, ctx);
	const start = () => sessionStart({ type: "session_start" }, ctx);
	return { calls, configs, notices, run, start };
}

test("registers ready connectors on refresh and re-registers only changed servers", async () => {
	const requests = serve({ connectors: [connector("notes")] }, { connectors: [connector("notes")] });
	const { calls, configs, run } = load();
	expect(calls).toEqual([]);

	await run("refresh");
	expect(requests[0].authorization).toBe("Bearer test-key");
	expect(new URL(requests[0].url).searchParams.getAll("builtin_connectors")).toEqual(["web_search"]);
	expect(calls).toEqual(["register mistral_notes"]);
	expect(configs.get("mistral_notes")).toMatchObject({ url: "https://api.mistral.ai/v1/connectors-gateway/id-notes/mcp", enabled: true });

	await run("refresh");
	expect(calls).toEqual(["register mistral_notes"]);

	await run("disable notes");
	expect(configs.get("mistral_notes").enabled).toBe(false);
	expect(JSON.parse(readFileSync(join(agentDirectory, "mistral-connectors.json"), "utf8")).disabled).toEqual(["notes"]);
});

test("registers the cached catalog at load and unregisters connectors that disappear", async () => {
	serve({ connectors: [connector("notes"), connector("docs")] }, { connectors: [connector("docs")] });
	await load().run("refresh");

	const { calls, run } = load();
	expect(calls).toEqual(["register mistral_notes", "register mistral_docs"]);

	await run("refresh");
	expect(calls.slice(2)).toEqual(["unregister mistral_notes"]);
});

test("renames a server by re-registering it and rejects names already in use", async () => {
	serve({ connectors: [connector("incident_agent_42a4"), connector("docs")] });
	const { calls, notices, run } = load();
	await run("refresh");

	await run("rename incident_agent_42a4 incidents");
	expect(calls.slice(2)).toEqual(["unregister mistral_incident_agent_42a4", "register mistral_incidents"]);

	await run("rename incident_agent_42a4 docs");
	expect(notices.at(-1)).toContain("mistral_docs is already used by docs");
	expect(calls).toHaveLength(4);

	await run("rename incident_agent_42a4");
	expect(calls.slice(4)).toEqual(["unregister mistral_incidents", "register mistral_incident_agent_42a4"]);
});

test("warns once when a background refresh fails, even with a cached list", async () => {
	serve({ connectors: [connector("notes")] });
	await load().run("refresh");
	globalThis.fetch = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
	writeFileSync(join(agentDirectory, "mistral-connectors-cache.json"), readFileSync(join(agentDirectory, "mistral-connectors-cache.json"), "utf8").replace(/"fetchedAt": \d+/, '"fetchedAt": 0'));

	const { notices, start } = load();
	start();
	start();
	await Bun.sleep(10);
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain("refresh failed: HTTP 503");
	expect(notices[0]).toContain("Using the list fetched");
});

test("saves per-tool overrides only when they differ from the default", async () => {
	const notes = { ...connector("notes"), tools: [{ name: "read", annotations: { readOnlyHint: true } }, { name: "send" }] };
	serve({ connectors: [notes] });
	const { configs, run } = load();
	const saved = () => JSON.parse(readFileSync(join(agentDirectory, "mistral-connectors.json"), "utf8")).tools;
	await run("refresh");

	await run("tools notes send on");
	expect(saved()).toEqual({ notes: { send: true } });
	expect(configs.get("mistral_notes").toolExposure).toEqual({ read: "codemode", send: "codemode" });

	await run("tools notes read on");
	expect(saved()).toEqual({ notes: { send: true } });

	await run("tools notes send reset");
	expect(saved()).toEqual({});
	expect(configs.get("mistral_notes").toolExposure).toEqual({ read: "codemode" });
});

test("saves checklist changes once when it closes", async () => {
	serve({ connectors: [connector("notes")] });
	const { calls, notices, run } = load();
	await run("refresh");

	await run("tools notes");
	expect(notices.at(-2)).toContain("notes tools");
	expect(notices.at(-1)).toBe("notes: 0/1 tools exposed.");
	// Hiding the only tool leaves nothing to expose, so the server is unregistered.
	expect(calls).toEqual(["register mistral_notes", "unregister mistral_notes"]);
});

test("reports a missing connector instead of changing settings", async () => {
	serve({ connectors: [connector("notes")] });
	const { notices, run } = load();
	await run("refresh");
	await run("writes nope on");
	expect(notices.at(-1)).toContain(`Unknown or unconnected connector "nope"`);
	expect(() => readFileSync(join(agentDirectory, "mistral-connectors.json"))).toThrow();
});
