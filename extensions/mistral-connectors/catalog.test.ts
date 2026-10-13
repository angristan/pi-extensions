import { describe, expect, test } from "bun:test";
import { connectorServerName, DEFAULT_SETTINGS, hasLongToolNames, parseBootstrap, serverConfig, serverName } from "./catalog";

const tool = (name: string, readOnlyHint?: boolean) => ({ name, ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }) });

const payload = {
	connectors: [
		{
			id: "c-notes",
			name: "notes",
			display_name: "Notes",
			description: "Search and edit notes.",
			status: { is_ready: true },
			tools: [tool("search", true), tool("edit", false), tool("guess")],
		},
		{ id: "c-writer", name: "writer", status: { is_ready: true }, tools: [tool("send", false)] },
		{ id: "c-oauth", name: "Box Drive", status: { is_ready: false }, auth_action: { type: "oauth" }, tools: [tool("x", true)] },
		{ id: "c-dup", name: "box-drive", status: { is_ready: true }, tools: [tool("list", true)], bootstrap_errors: ["slow", "retry"] },
		{ name: "no id" },
	],
};

describe("parseBootstrap", () => {
	const connectors = parseBootstrap(payload);

	test("treats only an explicit readOnlyHint as read-only", () => {
		expect(connectors[0].tools).toEqual([
			{ name: "search", readOnly: true },
			{ name: "edit", readOnly: false },
			{ name: "guess", readOnly: false },
		]);
	});

	test("keeps colliding aliases distinct and drops entries without an id", () => {
		expect(connectors.map((connector) => connector.alias)).toEqual(["notes", "writer", "Box_Drive", "box-drive_2"]);
		expect(new Set(connectors.map((connector) => serverName(connector.alias))).size).toBe(4);
	});

	test("ignores tools of connectors that are not ready and keeps their auth action", () => {
		expect(connectors[2]).toMatchObject({ ready: false, authAction: "oauth", tools: [] });
		expect(connectors[3].error).toBe("slow; retry");
	});
});

describe("server names", () => {
	const [long] = parseBootstrap({
		connectors: [{ id: "c-long", name: "incident_investigation_agent_read_only_42a4", status: { is_ready: true }, tools: [tool("get_issue_details", true)] }],
	});

	test("flags aliases that push exposed tool names past Pi's 64-character limit", () => {
		expect(connectorServerName(long, DEFAULT_SETTINGS)).toBe("mistral_incident_investigation_agent_read_only_42a4");
		expect(hasLongToolNames(long, DEFAULT_SETTINGS)).toBe(true);
	});

	test("uses a configured short name, matching the alias case-insensitively", () => {
		const settings = { ...DEFAULT_SETTINGS, names: { INCIDENT_investigation_agent_read_only_42a4: "incidents" } };
		expect(connectorServerName(long, settings)).toBe("mistral_incidents");
		expect(hasLongToolNames(long, settings)).toBe(false);
	});
});

describe("serverConfig", () => {
	const [notes, writer, oauth] = parseBootstrap(payload);

	test("hides write tools by default and re-exposes only read-only tools", () => {
		const config = serverConfig(notes, { ...DEFAULT_SETTINGS, baseUrl: "https://api.example.test/v1/" });
		expect(config).toMatchObject({
			url: "https://api.example.test/v1/connectors-gateway/c-notes/mcp",
			auth: { provider: "mistral" },
			enabled: true,
			exposure: "hidden",
			toolExposure: { search: "codemode" },
		});
		expect(config?.description).toBe("Notes: Search and edit notes. Write tools are hidden.");
	});

	test("exposes every tool once writes are allowed, matching the alias case-insensitively", () => {
		const config = serverConfig(notes, { ...DEFAULT_SETTINGS, allowWrites: ["NOTES"], exposure: "deferred" });
		expect(config).toMatchObject({ exposure: "deferred" });
		expect(config).not.toHaveProperty("toolExposure");
	});

	test("registers disabled connectors without enabling them", () => {
		expect(serverConfig(notes, { ...DEFAULT_SETTINGS, disabled: ["notes"] })?.enabled).toBe(false);
	});

	test("skips connectors that are not ready or would expose no tools", () => {
		expect(serverConfig(oauth, DEFAULT_SETTINGS)).toBeUndefined();
		expect(serverConfig(writer, DEFAULT_SETTINGS)).toBeUndefined();
		expect(serverConfig(writer, { ...DEFAULT_SETTINGS, allowWrites: ["writer"] })).toBeDefined();
	});
});
