import { getAgentDir, type ExtensionAPI, type ExtensionContext, type McpExposure, type McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fetchAuthUrl, fetchBootstrap } from "./api";
import {
	allowsWrites,
	AUTH_PROVIDER,
	type Connector,
	connectorServerName,
	type ConnectorSettings,
	DEFAULT_SETTINGS,
	exposedTools,
	hasLongToolNames,
	isDisabled,
	parseBootstrap,
	serverConfig,
	VALID_NAME,
} from "./catalog";

export const COMMAND = "mistral-connectors";
/** Same lifetime as Mistral Vibe's bootstrap cache. */
export const CACHE_TTL_MS = 10 * 60 * 1000;
const EXPOSURES: readonly McpExposure[] = ["codemode", "deferred", "direct", "hidden"];
const SUBCOMMANDS = ["status", "refresh", "enable", "disable", "writes", "rename", "connect"];
/** Subcommands that take the alias of a ready connector. */
const READY_SUBCOMMANDS = ["enable", "disable", "writes", "rename"];
const USAGE = `Usage: /${COMMAND} [status|refresh|enable <name>|disable <name>|writes <name> on|off|rename <name> [short]|connect <name>]`;

export const settingsPath = () => join(getAgentDir(), "mistral-connectors.json");
export const cachePath = () => join(getAgentDir(), "mistral-connectors-cache.json");

interface Cache {
	version: 1;
	fetchedAt: number;
	/** Hash of the API root and key, so switching accounts invalidates the cache. */
	account: string;
	connectors: Connector[];
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export function loadSettings(): ConnectorSettings {
	const raw = readJson(settingsPath()) as Partial<Record<keyof ConnectorSettings, unknown>> | undefined;
	return {
		disabled: strings(raw?.disabled),
		allowWrites: strings(raw?.allowWrites),
		names: Object.fromEntries(
			Object.entries(raw?.names && typeof raw.names === "object" ? raw.names : {}).filter((entry): entry is [string, string] => typeof entry[1] === "string" && VALID_NAME.test(entry[1])),
		),
		exposure: EXPOSURES.includes(raw?.exposure as McpExposure) ? (raw!.exposure as McpExposure) : DEFAULT_SETTINGS.exposure,
		baseUrl: typeof raw?.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : DEFAULT_SETTINGS.baseUrl,
	};
}

function loadCache(): Cache | undefined {
	const raw = readJson(cachePath()) as Partial<Cache> | undefined;
	if (raw?.version !== 1 || typeof raw.fetchedAt !== "number" || typeof raw.account !== "string" || !Array.isArray(raw.connectors)) return undefined;
	return raw as Cache;
}

const accountKey = (baseUrl: string, apiKey: string) => createHash("sha256").update(`${baseUrl}\0${apiKey}`).digest("hex").slice(0, 16);

function age(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 120) return `${minutes} min ago`;
	return `${Math.round(minutes / 60)} h ago`;
}

export default function (pi: ExtensionAPI) {
	let settings = loadSettings();
	let cache = loadCache();
	let lastError: string | undefined;
	let inflight: Promise<void> | undefined;
	/** Serialized config of each server this extension registered, to skip no-op re-registrations. */
	const registered = new Map<string, string>();
	/** Registration failures by connector alias. */
	const registrationErrors = new Map<string, string>();

	const connectors = () => cache?.connectors ?? [];
	const ready = () => connectors().filter((connector) => connector.ready);

	/**
	 * Converges Pi's registrations on the catalog and settings. Unchanged servers are left
	 * alone so their connections, and the prompt's server list, stay stable.
	 */
	const apply = () => {
		registrationErrors.clear();
		const desired = new Map<string, { alias: string; config: McpServerConfig }>();
		for (const connector of connectors()) {
			const config = serverConfig(connector, settings);
			if (!config) continue;
			const name = connectorServerName(connector, settings);
			// A hand-edited short name can collide; the first connector keeps the name.
			if (desired.has(name)) registrationErrors.set(connector.alias, `server name ${name} is already used by ${desired.get(name)!.alias}`);
			else desired.set(name, { alias: connector.alias, config });
		}
		for (const name of [...registered.keys()]) {
			if (desired.has(name)) continue;
			pi.unregisterMcpServer(name);
			registered.delete(name);
		}
		for (const [name, { alias, config }] of desired) {
			const serialized = JSON.stringify(config);
			if (registered.get(name) === serialized) continue;
			try {
				pi.registerMcpServer(name, config);
				registered.set(name, serialized);
			} catch (error) {
				// Another extension owns the name, or Pi rejected the config; keep the other servers.
				registrationErrors.set(alias, error instanceof Error ? error.message : String(error));
			}
		}
	};

	const refresh = (ctx: ExtensionContext, force: boolean): Promise<void> => {
		inflight ??= (async () => {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(AUTH_PROVIDER);
			if (!apiKey) throw new Error(`No API key for the "${AUTH_PROVIDER}" provider. Set MISTRAL_API_KEY or configure it in models.json.`);
			const account = accountKey(settings.baseUrl, apiKey);
			if (!force && cache?.account === account && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return;
			const payload = await fetchBootstrap({ baseUrl: settings.baseUrl, apiKey, signal: ctx.signal });
			cache = { version: 1, fetchedAt: Date.now(), account, connectors: parseBootstrap(payload) };
			await writeJson(cachePath(), cache);
			apply();
		})()
			.then(() => {
				lastError = undefined;
			})
			.catch((error: unknown) => {
				lastError = error instanceof Error ? error.message : String(error);
				throw error;
			})
			.finally(() => {
				inflight = undefined;
			});
		return inflight;
	};

	const updateSettings = async (change: (current: ConnectorSettings) => ConnectorSettings) => {
		settings = change(loadSettings());
		await writeJson(settingsPath(), settings);
		apply();
	};

	const toggle = (list: string[], alias: string, present: boolean) => {
		const rest = list.filter((item) => item.toLowerCase() !== alias.toLowerCase());
		return present ? [...rest, alias] : rest;
	};

	const describeState = (connector: Connector): string => {
		const exposed = exposedTools(connector, settings).length;
		const writes = allowsWrites(settings, connector.alias);
		const name = connectorServerName(connector, settings);
		const readOnly = connector.tools.every((tool) => tool.readOnly);
		const parts = [`${exposed}/${connector.tools.length} tools`, readOnly ? "read-only" : writes ? "writes allowed" : "writes hidden"];
		if (name !== connectorServerName(connector, DEFAULT_SETTINGS)) parts.push(`as ${name}`);
		if (exposed === 0) parts.push(`not registered: no read-only tools, use /${COMMAND} writes ${connector.alias} on`);
		else if (hasLongToolNames(connector, settings)) parts.push(`tool names too long, Pi adds hash suffixes: use /${COMMAND} rename ${connector.alias} <short>`);
		if (registrationErrors.has(connector.alias)) parts.push(`registration failed: ${registrationErrors.get(connector.alias)}`);
		if (connector.error) parts.push(`error: ${connector.error}`);
		return parts.join(" · ");
	};

	const statusText = (): string => {
		if (!cache) return lastError ? `Mistral connectors unavailable: ${lastError}` : `No connector list yet. Run /${COMMAND} refresh.`;
		const width = Math.max(0, ...ready().map((connector) => connector.alias.length));
		const lines = [`Mistral connectors, fetched ${age(Date.now() - cache.fetchedAt)}:`];
		for (const connector of ready()) {
			const state = !serverConfig(connector, settings) ? "--" : isDisabled(settings, connector.alias) ? "off" : "on";
			lines.push(`  ${state.padEnd(3)} ${connector.alias.padEnd(width)}  ${describeState(connector)}`);
		}
		const pending = connectors().length - ready().length;
		if (pending > 0) lines.push(`${pending} more can be connected with /${COMMAND} connect <name>.`);
		if (lastError) lines.push(`Last refresh failed: ${lastError}`);
		return lines.join("\n");
	};

	const findConnector = (name: string | undefined, pool: Connector[]) => pool.find((connector) => connector.alias.toLowerCase() === name?.toLowerCase());

	const connect = async (ctx: ExtensionContext, connector: Connector) => {
		if (connector.ready) {
			ctx.ui.notify(`${connector.alias} is already connected.`, "info");
			return;
		}
		if (connector.authAction !== "oauth") {
			ctx.ui.notify(`${connector.alias} needs ${connector.authAction === "credentials_setup" ? "credentials" : "setup"} in Le Chat's connector settings. Then run /${COMMAND} refresh.`, "info");
			return;
		}
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(AUTH_PROVIDER);
		if (!apiKey) throw new Error(`No API key for the "${AUTH_PROVIDER}" provider.`);
		const url = await fetchAuthUrl({ baseUrl: settings.baseUrl, apiKey }, connector.id);
		ctx.ui.notify(`Open this URL to connect ${connector.alias}, then run /${COMMAND} refresh:\n${url}`, "info");
	};

	const setEnabled = async (connector: Connector, enabled: boolean) => {
		await updateSettings((current) => ({ ...current, disabled: toggle(current.disabled, connector.alias, !enabled) }));
		return `${connector.alias} ${enabled ? "enabled" : "disabled"}.`;
	};

	const setWrites = async (connector: Connector, writes: boolean) => {
		await updateSettings((current) => ({ ...current, allowWrites: toggle(current.allowWrites, connector.alias, writes) }));
		return `${connector.alias}: write tools ${writes ? "allowed" : "hidden"}.`;
	};

	/** Sets a short server name, or clears it when `short` is empty. */
	const setName = async (connector: Connector, short: string | undefined) => {
		if (short && !VALID_NAME.test(short)) throw new Error(`"${short}" may only contain letters, digits, "_", and "-".`);
		const next = (current: ConnectorSettings): ConnectorSettings => {
			const names = Object.fromEntries(Object.entries(current.names).filter(([alias]) => alias.toLowerCase() !== connector.alias.toLowerCase()));
			return { ...current, names: short ? { ...names, [connector.alias]: short } : names };
		};
		const name = connectorServerName(connector, next(settings));
		const owner = ready().find((other) => other !== connector && connectorServerName(other, settings) === name);
		if (owner) throw new Error(`${name} is already used by ${owner.alias}.`);
		await updateSettings(next);
		return `${connector.alias} is now the ${name} MCP server.`;
	};

	/** Interactive picker: choose a connector, then an action. */
	const pick = async (ctx: ExtensionContext) => {
		const actions = new Map<string, () => Promise<string | void>>();
		for (const connector of ready()) {
			const state = isDisabled(settings, connector.alias) ? "off" : "on";
			actions.set(`${connector.alias} (${state}) · ${describeState(connector)}`, async () => {
				const enabled = !isDisabled(settings, connector.alias);
				const writes = allowsWrites(settings, connector.alias);
				const choice = await ctx.ui.select(connector.alias, [enabled ? "Disable" : "Enable", writes ? "Hide write tools" : "Allow write tools", "Rename server"]);
				if (choice === "Disable" || choice === "Enable") return setEnabled(connector, choice === "Enable");
				if (choice === "Rename server") {
					const short = await ctx.ui.input(`Short name for ${connector.alias} (empty resets)`, connector.alias.split(/[_-]/)[0]);
					return short === undefined ? undefined : setName(connector, short.trim() || undefined);
				}
				if (choice) return setWrites(connector, !writes);
			});
		}
		actions.set("Connect another connector…", async () => {
			const pending = connectors().filter((connector) => !connector.ready).sort((a, b) => a.alias.localeCompare(b.alias));
			const choice = await ctx.ui.select("Connect a Mistral connector", pending.map((connector) => connector.alias));
			const connector = findConnector(choice, pending);
			if (connector) await connect(ctx, connector);
		});
		actions.set("Refresh from Mistral", async () => {
			await refresh(ctx, true);
			return statusText();
		});
		const choice = await ctx.ui.select("Mistral connectors", [...actions.keys()]);
		const message = choice ? await actions.get(choice)!() : undefined;
		if (message) ctx.ui.notify(message, "info");
	};

	const completions = (prefix: string): AutocompleteItem[] | null => {
		const [sub = "", name, extra] = prefix.trimStart().split(/\s+/);
		let values: string[];
		if (name === undefined) values = SUBCOMMANDS.filter((item) => item.startsWith(sub.toLowerCase()));
		else if (extra !== undefined) values = sub === "writes" ? ["on", "off"].filter((item) => item.startsWith(extra)).map((item) => `${sub} ${name} ${item}`) : [];
		else {
			const pool = sub === "connect" ? connectors().filter((connector) => !connector.ready) : READY_SUBCOMMANDS.includes(sub) ? ready() : [];
			values = pool.map((connector) => connector.alias).filter((alias) => alias.toLowerCase().startsWith(name.toLowerCase())).map((alias) => `${sub} ${alias}`);
		}
		return values.length ? values.map((value) => ({ value, label: value.split(" ").at(-1)! })) : null;
	};

	pi.registerCommand(COMMAND, {
		description: "Show, refresh, select, rename, or connect Mistral connectors exposed as MCP servers",
		getArgumentCompletions: completions,
		handler: async (args, ctx) => {
			const [sub = "", name, value] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (!sub && ctx.hasUI && cache) return await pick(ctx);
				if (!sub || sub === "status") return ctx.ui.notify(statusText(), "info");
				if (sub === "refresh") {
					await refresh(ctx, true);
					return ctx.ui.notify(statusText(), "info");
				}
				if (sub === "connect") {
					const connector = findConnector(name, connectors());
					if (!connector) return ctx.ui.notify(`Unknown connector "${name ?? ""}". ${USAGE}`, "warning");
					return await connect(ctx, connector);
				}
				const connector = findConnector(name, ready());
				if (!connector || !READY_SUBCOMMANDS.includes(sub)) return ctx.ui.notify(connector ? USAGE : `Unknown or unconnected connector "${name ?? ""}". ${USAGE}`, "warning");
				if (sub === "writes") {
					if (value !== "on" && value !== "off") return ctx.ui.notify(USAGE, "warning");
					return ctx.ui.notify(await setWrites(connector, value === "on"), "info");
				}
				if (sub === "rename") return ctx.ui.notify(await setName(connector, value), "info");
				ctx.ui.notify(await setEnabled(connector, sub === "enable"), "info");
			} catch (error) {
				ctx.ui.notify(`Mistral connectors: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	// Register the cached catalog while loading, so the servers connect with the session and the
	// first prompt already lists them. The refresh below only re-registers servers that changed.
	apply();

	let warned = false;
	pi.on("session_start", (_event, ctx) => {
		// Do not hold up session start on the network. Warn once per runtime when a refresh fails,
		// so a stale cached list is not silent; later failures only appear in the status.
		refresh(ctx, false).catch((error: unknown) => {
			// Without a Mistral key there is nothing to fix here; the status explains it.
			if (warned || /No API key/.test(String(error))) return;
			warned = true;
			const stale = cache ? ` Using the list fetched ${age(Date.now() - cache.fetchedAt)}.` : "";
			ctx.ui.notify(`Mistral connectors refresh failed: ${error instanceof Error ? error.message : String(error)}.${stale}`, "warning");
		});
	});
}
