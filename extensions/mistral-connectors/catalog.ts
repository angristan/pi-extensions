import type { McpExposure, McpServerConfig } from "@earendil-works/pi-coding-agent";

/** How a connector that is not ready can be connected, from the bootstrap `auth_action`. */
export type ConnectorAuthAction = "none" | "oauth" | "credentials_setup" | "other";

export interface ConnectorTool {
	name: string;
	/** True only when the server declares `readOnlyHint: true`. MCP treats missing hints as "may write". */
	readOnly: boolean;
}

export interface Connector {
	id: string;
	/** Name-derived alias, normalized the same way Mistral Vibe does, used in settings and commands. */
	alias: string;
	displayName: string;
	description?: string;
	ready: boolean;
	authAction: ConnectorAuthAction;
	tools: ConnectorTool[];
	/** Bootstrap errors reported for this connector, flattened to one line. */
	error?: string;
}

export interface ConnectorSettings {
	/** Aliases registered with `enabled: false`: listed in `/mcp`, not connected. */
	disabled: string[];
	/** Aliases whose tools without `readOnlyHint: true` are exposed. */
	allowWrites: string[];
	exposure: McpExposure;
	baseUrl: string;
}

export const DEFAULT_BASE_URL = "https://api.mistral.ai";
export const DEFAULT_SETTINGS: ConnectorSettings = { disabled: [], allowWrites: [], exposure: "codemode", baseUrl: DEFAULT_BASE_URL };
/** Pi model provider whose API key authenticates bootstrap and gateway requests. */
export const AUTH_PROVIDER = "mistral";
const MAX_DESCRIPTION_CHARS = 240;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** Mirrors Mistral Vibe's connector alias normalization so aliases match across both tools. */
export function normalizeAlias(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^[_-]+|[_-]+$/g, "").slice(0, 256) || "unnamed";
}

/**
 * Pi server name for a connector. Pi treats `-` and `_` as the same character in server names
 * and allows only letters, digits, `_`, and `-`, so the alias is lowercased and folded to `_`.
 */
export function serverName(alias: string): string {
	return `mistral_${alias.toLowerCase().replace(/-/g, "_")}`;
}

/** API root without a trailing slash or version path, so both `…/v1` and bare hosts work. */
export function apiRoot(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "").replace(/\/v\d+$/i, "");
}

export function gatewayUrl(baseUrl: string, connectorId: string): string {
	return `${apiRoot(baseUrl)}/v1/connectors-gateway/${encodeURIComponent(connectorId)}/mcp`;
}

function authAction(value: unknown): ConnectorAuthAction {
	if (!isObject(value)) return "none";
	if (value.type === "oauth" || value.type === "credentials_setup") return value.type;
	return "other";
}

function bootstrapError(value: unknown): string | undefined {
	if (value == null || value === "") return undefined;
	const parts = (Array.isArray(value) ? value : [value]).map((item) => (typeof item === "string" ? item : JSON.stringify(item)).trim()).filter(Boolean);
	return parts.length ? parts.join("; ") : undefined;
}

function parseTools(value: unknown): ConnectorTool[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((tool) => {
		const name = isObject(tool) ? text(tool.name) : undefined;
		if (!name) return [];
		const annotations = isObject(tool) && isObject(tool.annotations) ? tool.annotations : undefined;
		return [{ name, readOnly: annotations?.readOnlyHint === true }];
	});
}

/**
 * Parses `GET /v1/connectors/bootstrap`. Aliases that collide after normalization, including
 * names that differ only in case, `-`, or `_`, get a numeric suffix instead of being dropped.
 */
export function parseBootstrap(payload: unknown): Connector[] {
	const raw = isObject(payload) && Array.isArray(payload.connectors) ? payload.connectors : [];
	const usedServerNames = new Set<string>();
	const connectors: Connector[] = [];
	for (const entry of raw) {
		if (!isObject(entry)) continue;
		const id = text(entry.id) ?? (typeof entry.id === "number" ? String(entry.id) : undefined);
		if (!id) continue;
		const name = text(entry.name) ?? id;
		const base = normalizeAlias(name);
		let alias = base;
		for (let suffix = 2; usedServerNames.has(serverName(alias)); suffix++) alias = `${base}_${suffix}`;
		usedServerNames.add(serverName(alias));
		const ready = isObject(entry.status) && entry.status.is_ready === true;
		connectors.push({
			id,
			alias,
			displayName: text(entry.display_name) ?? name,
			description: text(entry.description),
			ready,
			authAction: authAction(entry.auth_action),
			tools: ready ? parseTools(entry.tools) : [],
			error: bootstrapError(entry.bootstrap_errors),
		});
	}
	return connectors;
}

const listed = (aliases: readonly string[], alias: string) => aliases.some((item) => item.toLowerCase() === alias.toLowerCase());
export const isDisabled = (settings: ConnectorSettings, alias: string) => listed(settings.disabled, alias);
export const allowsWrites = (settings: ConnectorSettings, alias: string) => listed(settings.allowWrites, alias);

/** Tools the model can reach for a connector under the current settings. */
export function exposedTools(connector: Connector, settings: ConnectorSettings): ConnectorTool[] {
	return allowsWrites(settings, connector.alias) ? connector.tools : connector.tools.filter((tool) => tool.readOnly);
}

function describe(connector: Connector, writes: boolean): string {
	const summary = connector.description ? `${connector.displayName}: ${connector.description}` : `${connector.displayName} Mistral connector`;
	const trimmed = summary.length > MAX_DESCRIPTION_CHARS ? `${summary.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : summary;
	return writes ? trimmed : `${trimmed} Write tools are hidden.`;
}

/**
 * Pi MCP config for one connector, or undefined when it is not ready or would expose no tools.
 *
 * Without write access, the server is `hidden` and only tools known to be read-only are
 * re-exposed by exact name. Tools the gateway adds later stay hidden until the next refresh
 * classifies them, so an unknown tool is never exposed as writable by accident.
 */
export function serverConfig(connector: Connector, settings: ConnectorSettings): McpServerConfig | undefined {
	if (!connector.ready) return undefined;
	const writes = allowsWrites(settings, connector.alias);
	const tools = exposedTools(connector, settings);
	if (tools.length === 0) return undefined;
	return {
		url: gatewayUrl(settings.baseUrl, connector.id),
		auth: { provider: AUTH_PROVIDER },
		description: describe(connector, writes),
		enabled: !isDisabled(settings, connector.alias),
		exposure: writes ? settings.exposure : "hidden",
		...(writes ? {} : { toolExposure: Object.fromEntries(tools.map((tool) => [tool.name, settings.exposure])) }),
	};
}
