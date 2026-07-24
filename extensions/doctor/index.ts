import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	Markdown,
	matchesKey,
	Text,
	wrapTextWithAnsi,
	type TUI,
} from "@earendil-works/pi-tui";
import { accentBorder } from "../accent-color/index.js";

const CODE_BLOCK_PATCH = Symbol.for("pi.code-blocks.patch");
const LINE_RESET_PATCH = Symbol.for("pi.cached-line-resets.patch");
const RENDER_STATS_KEY = Symbol.for("pi.renderer-cache.stats");
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_ISSUES = 12;

export interface ExtensionEntry {
	name: string;
	path: string;
	kind: "file" | "package";
}

export interface Registration {
	kind: "command" | "shortcut";
	name: string;
	file: string;
}

export interface DuplicateRegistration {
	kind: Registration["kind"];
	name: string;
	files: string[];
}

interface DiagnosticIssue {
	severity: "error" | "warning" | "info";
	text: string;
}

type ReportStatus = "ok" | DiagnosticIssue["severity"];

export interface DoctorReportItem {
	status: ReportStatus;
	label: string;
	detail?: string;
}

export interface DoctorReport {
	lines: string[];
	items: DoctorReportItem[];
}

export interface DoctorSnapshot {
	agentDir: string;
	extensions: ExtensionEntry[];
	runtimeLoadedFiles: string[];
	passiveOrUnverifiedFiles: string[];
	activeTools: string[];
	duplicates: DuplicateRegistration[];
	settings: any;
	settingsError?: string;
	modelsError?: string;
	missingEnabledModels: string[];
	unauthenticatedEnabledModels: string[];
	defaultModelResolved: boolean;
	defaultModelAuthenticated: boolean;
	availableModels: number;
	totalModels: number;
	providers: string[];
	startupIssues: string[];
	foundryIssues: string[];
	missingFeatureFiles: string[];
	notificationsEnabled: boolean | undefined;
	session: {
		id: string;
		file?: string;
		fileBytes?: number;
		entries: number;
		branchEntries: number;
		contextEntries: number;
		messages: number;
		contextTokens?: number | null;
		contextWindow?: number;
	};
}

interface RuntimePatchCheck {
	name: string;
	active: boolean;
	reversible: boolean;
	detail: string;
}

interface RendererStats {
	renderCalls?: number;
	cacheHits?: number;
	cacheMisses?: number;
	volatileRenders?: number;
	invalidations?: number;
}

function compactNumber(value: number): string {
	const safe = Math.max(0, Math.round(value));
	if (safe < 1_000) return String(safe);
	if (safe < 1_000_000) return `${(safe / 1_000).toFixed(safe < 10_000 ? 1 : 0)}K`;
	if (safe < 1_000_000_000) return `${(safe / 1_000_000).toFixed(safe < 10_000_000 ? 1 : 0)}M`;
	return `${(safe / 1_000_000_000).toFixed(1)}G`;
}

function formatBytes(bytes: number | undefined): string {
	if (bytes === undefined) return "not persisted";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
	return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function safeString(value: unknown): string {
	if (typeof value === "string") return value;
	try { return JSON.stringify(value); } catch { return String(value); }
}

function messageText(message: any): string {
	const parts: string[] = [];
	if (typeof message?.errorMessage === "string") parts.push(message.errorMessage);
	const content = message?.content;
	if (typeof content === "string") parts.push(content);
	if (Array.isArray(content)) {
		for (const item of content) {
			if (typeof item?.text === "string") parts.push(item.text);
			if (typeof item?.thinking === "string") parts.push(item.thinking);
			if (item?.type === "toolCall") parts.push(`${item.name ?? "tool"} ${safeString(item.arguments ?? {})}`);
		}
	}
	return parts.join("\n");
}

function normalizeIssue(text: string): string {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 360);
}

export function extractRecentIssues(lines: readonly string[]): { startup: string[]; foundry: string[] } {
	const startup: string[] = [];
	const foundry: string[] = [];
	const seenStartup = new Set<string>();
	const seenFoundry = new Set<string>();
	for (const raw of lines) {
		const line = normalizeIssue(raw);
		if (!line) continue;
		if (/failed to load extension|extension runtime not initialized|failed to load extension/i.test(line)) {
			if (!seenStartup.has(line)) {
				seenStartup.add(line);
				startup.push(line);
			}
		}
		if (/foundry openai error|rate limit|exceeded rate limit|stream disconnected|http 429|unknown error \(no error details/i.test(line)) {
			if (!seenFoundry.has(line)) {
				seenFoundry.add(line);
				foundry.push(line);
			}
		}
	}
	return {
		startup: startup.slice(-MAX_ISSUES),
		foundry: foundry.slice(-MAX_ISSUES),
	};
}

export async function discoverExtensionEntries(extensionDir: string): Promise<ExtensionEntry[]> {
	const entries: ExtensionEntry[] = [];
	let dirents: any[];
	try {
		dirents = await readdir(extensionDir, { withFileTypes: true });
	} catch {
		return entries;
	}
	for (const dirent of dirents) {
		if (dirent.name.startsWith(".")) continue;
		const path = join(extensionDir, dirent.name);
		if (dirent.isFile() && dirent.name.endsWith(".ts") && !dirent.name.endsWith(".d.ts")) {
			entries.push({ name: dirent.name, path, kind: "file" });
			continue;
		}
		if (!dirent.isDirectory()) continue;
		const indexPath = join(path, "index.ts");
		try {
			if ((await stat(indexPath)).isFile()) entries.push({ name: `${dirent.name}/index.ts`, path: indexPath, kind: "package" });
		} catch {
			// Support-only directories are not extension entry points.
		}
	}
	return entries.sort((a, b) => a.name.localeCompare(b.name));
}

async function extensionEntryAt(path: string, name: string): Promise<ExtensionEntry[]> {
	try {
		const info = await stat(path);
		if (info.isFile() && path.endsWith(".ts") && !path.endsWith(".d.ts")) {
			return [{ name, path, kind: "file" }];
		}
		if (!info.isDirectory()) return [];
		const indexPath = join(path, "index.ts");
		if ((await stat(indexPath)).isFile()) {
			return [{ name: `${name.replace(/\/$/, "")}/index.ts`, path: indexPath, kind: "package" }];
		}
	} catch {
		return [];
	}
	return [];
}

export async function discoverPackageExtensionEntries(packageRoot: string): Promise<ExtensionEntry[]> {
	let manifest: any;
	try {
		manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	} catch {
		return [];
	}
	const packageName = typeof manifest.name === "string" && manifest.name.trim()
		? manifest.name.trim()
		: basename(packageRoot);
	const configured = Array.isArray(manifest.pi?.extensions)
		? manifest.pi.extensions.filter((value: unknown): value is string => typeof value === "string")
		: undefined;
	const entries: ExtensionEntry[] = [];

	if (configured === undefined) {
		for (const entry of await discoverExtensionEntries(join(packageRoot, "extensions"))) {
			entries.push({ ...entry, name: `${packageName}/${entry.name}` });
		}
		return entries;
	}

	for (const configuredPath of configured) {
		const relativePath = configuredPath.replace(/^\.\//, "");
		if (relativePath.endsWith("/*")) {
			const extensionDir = resolve(packageRoot, relativePath.slice(0, -2));
			for (const entry of await discoverExtensionEntries(extensionDir)) {
				entries.push({ ...entry, name: `${packageName}/${relative(packageRoot, entry.path)}` });
			}
			continue;
		}
		const path = resolve(packageRoot, relativePath);
		entries.push(...await extensionEntryAt(path, `${packageName}/${relativePath}`));
	}
	return entries;
}

interface RuntimeSourceInfo {
	path?: unknown;
	baseDir?: unknown;
	origin?: unknown;
}

export async function discoverConfiguredExtensions(agentDir: string, sourceInfos: readonly RuntimeSourceInfo[]): Promise<ExtensionEntry[]> {
	const entries = await discoverExtensionEntries(join(agentDir, "extensions"));
	const visitedRoots = new Set<string>();
	for (const sourceInfo of sourceInfos) {
		if (typeof sourceInfo.baseDir !== "string") continue;
		const root = resolve(sourceInfo.baseDir);
		if (visitedRoots.has(root)) continue;
		visitedRoots.add(root);
		const discovered = sourceInfo.origin === "package"
			? await discoverPackageExtensionEntries(root)
			: await discoverExtensionEntries(root);
		entries.push(...discovered);
	}
	const byPath = new Map<string, ExtensionEntry>();
	for (const entry of entries) byPath.set(resolve(entry.path), entry);
	return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findDuplicateRegistrations(sources: ReadonlyArray<{ file: string; source: string }>): DuplicateRegistration[] {
	const registrations: Registration[] = [];
	const patterns: Array<[Registration["kind"], RegExp]> = [
		["command", /\bpi\.registerCommand\s*\(\s*["'`]([^"'`]+)["'`]/g],
		["shortcut", /\bpi\.registerShortcut\s*\(\s*["'`]([^"'`]+)["'`]/g],
	];
	for (const { file, source } of sources) {
		for (const [kind, pattern] of patterns) {
			pattern.lastIndex = 0;
			for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
				registrations.push({ kind, name: match[1], file });
			}
		}
	}
	const groups = new Map<string, Registration[]>();
	for (const registration of registrations) {
		const key = `${registration.kind}\0${registration.name}`;
		const group = groups.get(key) ?? [];
		group.push(registration);
		groups.set(key, group);
	}
	return [...groups.values()]
		.filter((group) => group.length > 1)
		.map((group) => ({
			kind: group[0].kind,
			name: group[0].name,
			files: [...new Set(group.map((item) => item.file))].sort(),
		}))
		.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

async function readJson(path: string): Promise<{ value?: any; error?: string }> {
	try {
		return { value: JSON.parse(await readFile(path, "utf8")) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

async function readTailLines(path: string, maxBytes = MAX_LOG_BYTES): Promise<string[]> {
	try {
		const info = await stat(path);
		const start = Math.max(0, info.size - maxBytes);
		const chunks: Buffer[] = [];
		await new Promise<void>((resolve, reject) => {
			const stream = createReadStream(path, { start });
			stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			stream.on("end", resolve);
			stream.on("error", reject);
		});
		const text = Buffer.concat(chunks).toString("utf8");
		const lines = text.split(/\r?\n/);
		if (start > 0) lines.shift();
		return lines;
	} catch {
		return [];
	}
}

function parseEnabledModel(spec: string): { provider: string; modelId: string } | undefined {
	const slash = spec.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = spec.slice(0, slash);
	const withLevel = spec.slice(slash + 1);
	const modelId = withLevel.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "");
	return modelId ? { provider, modelId } : undefined;
}

async function featureInventoryMisses(extensionDir: string): Promise<string[]> {
	try {
		const source = await readFile(join(extensionDir, "FEATURES.md"), "utf8");
		const refs = [...source.matchAll(/`([^`]+\.ts)`/g)].map((match) => match[1]);
		const missing: string[] = [];
		for (const ref of new Set(refs)) {
			try { await stat(join(extensionDir, ref)); } catch { missing.push(ref); }
		}
		return missing.sort();
	} catch {
		return [];
	}
}

async function notificationState(agentDir: string): Promise<boolean | undefined> {
	try {
		const config = JSON.parse(await readFile(join(agentDir, "notifications.json"), "utf8"));
		return config?.enabled !== false;
	} catch {
		return undefined;
	}
}

async function buildSnapshot(pi: ExtensionAPI, ctx: any): Promise<DoctorSnapshot> {
	const agentDir = getAgentDir();
	const extensionDir = join(agentDir, "extensions");
	const runtimeItems = [...pi.getCommands(), ...pi.getAllTools()];
	const sourceInfos = runtimeItems
		.map((item: any) => item.sourceInfo)
		.filter((sourceInfo: unknown): sourceInfo is RuntimeSourceInfo => Boolean(sourceInfo && typeof sourceInfo === "object"));
	const extensions = await discoverConfiguredExtensions(agentDir, sourceInfos);
	const sources = await Promise.all(extensions.map(async (entry) => ({
		file: entry.name,
		source: await readFile(entry.path, "utf8").catch(() => ""),
	})));
	const duplicates = findDuplicateRegistrations(sources);
	const runtimeSourcePaths = [...new Set(sourceInfos
		.map((sourceInfo) => sourceInfo.path)
		.filter((path: unknown): path is string => typeof path === "string")
		.map((path) => resolve(path)))];
	const runtimeLoadedFiles = extensions
		.filter((entry) => runtimeSourcePaths.some((path) => {
			const entryPath = resolve(entry.path);
			return path === entryPath
				|| path === dirname(entryPath)
				|| entryPath.startsWith(`${path}${sep}`);
		}))
		.map((entry) => entry.name)
		.sort();
	const runtimePaths = new Set(runtimeLoadedFiles);
	const passiveOrUnverifiedFiles = extensions
		.map((entry) => entry.name)
		.filter((name) => !runtimePaths.has(name));
	const settingsResult = await readJson(join(agentDir, "settings.json"));
	const settings = settingsResult.value ?? {};
	const allModels = ctx.modelRegistry.getAll();
	const availableModels = ctx.modelRegistry.getAvailable();
	const enabledSpecs = Array.isArray(settings.enabledModels) ? settings.enabledModels.filter((item: unknown): item is string => typeof item === "string") : [];
	const missingEnabledModels = enabledSpecs.filter((spec: string) => {
		const parsed = parseEnabledModel(spec);
		return !parsed || !ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	});
	const availableKeys = new Set(availableModels.map((model: any) => `${model.provider}/${model.id}`));
	const unauthenticatedEnabledModels = enabledSpecs.filter((spec: string) => {
		const parsed = parseEnabledModel(spec);
		return parsed && ctx.modelRegistry.find(parsed.provider, parsed.modelId) && !availableKeys.has(`${parsed.provider}/${parsed.modelId}`);
	});
	const defaultModel = typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string"
		? ctx.modelRegistry.find(settings.defaultProvider, settings.defaultModel)
		: undefined;

	const sessionLines: string[] = [];
	for (const entry of ctx.sessionManager.getEntries().slice(-800)) {
		if (entry.type === "message") {
			const text = messageText(entry.message);
			if (text) sessionLines.push(text);
		}
	}
	const logLines = await readTailLines(join(agentDir, "pi-debug.log"));
	const issues = extractRecentIssues([...logLines, ...sessionLines]);
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	let fileBytes: number | undefined;
	if (sessionFile) {
		try { fileBytes = (await stat(sessionFile)).size; } catch { /* in-memory or replaced */ }
	}
	const entries = ctx.sessionManager.getEntries();
	const usage = ctx.getContextUsage?.();

	return {
		agentDir,
		extensions,
		runtimeLoadedFiles,
		passiveOrUnverifiedFiles,
		activeTools: pi.getActiveTools(),
		duplicates,
		settings,
		settingsError: settingsResult.error,
		modelsError: ctx.modelRegistry.getError?.(),
		missingEnabledModels,
		unauthenticatedEnabledModels,
		defaultModelResolved: Boolean(defaultModel),
		defaultModelAuthenticated: Boolean(defaultModel && availableKeys.has(`${defaultModel.provider}/${defaultModel.id}`)),
		availableModels: availableModels.length,
		totalModels: allModels.length,
		providers: [...new Set<string>(allModels.map((model: any) => String(model.provider)))].sort(),
		startupIssues: issues.startup,
		foundryIssues: issues.foundry,
		missingFeatureFiles: await featureInventoryMisses(extensionDir),
		notificationsEnabled: await notificationState(agentDir),
		session: {
			id: ctx.sessionManager.getSessionId(),
			file: sessionFile,
			fileBytes,
			entries: entries.length,
			branchEntries: ctx.sessionManager.getBranch().length,
			contextEntries: ctx.sessionManager.buildContextEntries().length,
			messages: entries.filter((entry: any) => entry.type === "message").length,
			contextTokens: usage?.tokens,
			contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
		},
	};
}

function runtimePatchChecks(tui: TUI): RuntimePatchCheck[] {
	const markdownPrototype = Markdown.prototype as any;
	const codeState = markdownPrototype[CODE_BLOCK_PATCH];
	const lineState = (tui as any)[LINE_RESET_PATCH];
	return [
		{
			name: "Markdown code-block renderer",
			active: Boolean(codeState),
			reversible: Boolean(codeState?.original && markdownPrototype.renderToken !== codeState.original),
			detail: codeState ? `${codeState.owners ?? 1} owner(s); original retained` : "patch sentinel absent",
		},
		{
			name: "TUI line-reset cache",
			active: Boolean(lineState),
			reversible: Boolean(lineState?.original && (tui as any).applyLineResets !== lineState.original),
			detail: lineState
				? `${lineState.cache?.size ?? 0} entries; ${compactNumber(lineState.hits ?? 0)} hits / ${compactNumber(lineState.misses ?? 0)} misses; Kitty ${compactNumber(lineState.imagePositionHits ?? 0)} stable / ${compactNumber(lineState.imagePositionMisses ?? 0)} redrawn; original retained`
				: "patch sentinel absent",
		},
	];
}

function rendererStats(): Record<string, RendererStats> {
	const root = globalThis as typeof globalThis & { [RENDER_STATS_KEY]?: Record<string, RendererStats> };
	return root[RENDER_STATS_KEY] ?? {};
}

function statusIcon(status: ReportStatus, theme: any): string {
	if (status === "ok") return theme.fg("success", "✓");
	if (status === "warning") return theme.fg("warning", "!");
	if (status === "error") return theme.fg("error", "×");
	return theme.fg("dim", "·");
}

export function countReportIssues(items: readonly DoctorReportItem[]): { errors: number; warnings: number } {
	let errors = 0;
	let warnings = 0;
	for (const item of items) {
		if (item.status === "error") errors += 1;
		else if (item.status === "warning") warnings += 1;
	}
	return { errors, warnings };
}

export function buildDoctorReport(snapshot: DoctorSnapshot, tui: TUI, theme: any): DoctorReport {
	const lines: string[] = [];
	const items: DoctorReportItem[] = [];
	const section = (title: string) => {
		if (lines.length) lines.push("");
		lines.push(theme.fg("accent", theme.bold(title)));
	};
	const item = (status: ReportStatus, label: string, detail?: string) => {
		items.push({ status, label, detail });
		lines.push(`${statusIcon(status, theme)} ${theme.bold(label)}${detail ? ` ${theme.fg("muted", detail)}` : ""}`);
	};
	const detail = (text: string) => lines.push(`  ${theme.fg("dim", text)}`);

	section("Extensions");
	item(snapshot.extensions.length > 0 ? "ok" : "error", `${snapshot.extensions.length} discovered extension entries`);
	for (const extension of snapshot.extensions) detail(extension.name);
	item(snapshot.runtimeLoadedFiles.length > 0 ? "ok" : "warning", `${snapshot.runtimeLoadedFiles.length} entries have live command/tool registration evidence`);
	for (const file of snapshot.runtimeLoadedFiles) detail(file);
	if (snapshot.passiveOrUnverifiedFiles.length) {
		item("info", `${snapshot.passiveOrUnverifiedFiles.length} passive or unverified entries`, "event/render-only extensions cannot be proven through the public registry");
		detail(snapshot.passiveOrUnverifiedFiles.join(", "));
	}
	item("info", "Active model tools", snapshot.activeTools.join(", ") || "none");
	if (snapshot.startupIssues.length === 0) item("ok", "No recent startup failures found", "pi-debug.log and current session evidence");
	else {
		item("error", `${snapshot.startupIssues.length} recent startup failure${snapshot.startupIssues.length === 1 ? "" : "s"}`);
		for (const issue of snapshot.startupIssues) detail(issue);
	}
	if (snapshot.duplicates.length === 0) item("ok", "No duplicate extension commands or shortcuts");
	else {
		for (const duplicate of snapshot.duplicates) {
			item("warning", `Duplicate ${duplicate.kind} ${duplicate.name}`);
			detail(duplicate.files.join(", "));
		}
	}
	if (snapshot.missingFeatureFiles.length === 0) item("ok", "Feature inventory references existing files");
	else for (const file of snapshot.missingFeatureFiles) item("error", `Missing inventory file ${file}`);

	section("Runtime patches and caches");
	for (const patch of runtimePatchChecks(tui)) {
		item(patch.active && patch.reversible ? "ok" : patch.active ? "warning" : "error", patch.name, patch.detail);
	}
	const stats = rendererStats();
	if (Object.keys(stats).length === 0) item("warning", "No renderer cache counters published");
	for (const [name, value] of Object.entries(stats).sort(([a], [b]) => a.localeCompare(b))) {
		const hits = value.cacheHits ?? 0;
		const misses = value.cacheMisses ?? 0;
		const denominator = hits + misses;
		const hitRate = denominator > 0 ? `${((hits / denominator) * 100).toFixed(1)}% hit` : "not exercised";
		item("info", name, `${compactNumber(value.renderCalls ?? 0)} renders · ${hitRate} · ${compactNumber(value.volatileRenders ?? 0)} volatile`);
	}
	section("Models and provider configuration");
	if (snapshot.settingsError) item("error", "settings.json is invalid", snapshot.settingsError);
	else item("ok", "settings.json parsed");
	if (snapshot.modelsError) item("error", "models.json validation failed", snapshot.modelsError);
	else item("ok", "Model registry loaded");
	item(snapshot.availableModels > 0 ? "ok" : "error", `${snapshot.availableModels}/${snapshot.totalModels} models have configured auth`);
	detail(`${snapshot.providers.length} providers: ${snapshot.providers.join(", ")}`);
	if (snapshot.missingEnabledModels.length === 0) item("ok", "All enabled model specs resolve");
	else for (const spec of snapshot.missingEnabledModels) item("error", `Stale enabled model ${spec}`);
	if (snapshot.unauthenticatedEnabledModels.length === 0) item("ok", "All resolved enabled models have configured auth");
	else for (const spec of snapshot.unauthenticatedEnabledModels) item("warning", `Enabled model lacks configured auth ${spec}`);
	const selected = `${snapshot.settings.defaultProvider ?? "?"}/${snapshot.settings.defaultModel ?? "?"}`;
	item(!snapshot.defaultModelResolved ? "error" : !snapshot.defaultModelAuthenticated ? "warning" : "ok", "Default model", `${selected}${snapshot.defaultModelResolved && !snapshot.defaultModelAuthenticated ? " · auth unavailable" : ""}`);
	if (snapshot.foundryIssues.length === 0) item("ok", "No recent Foundry failure evidence found");
	else {
		item("warning", `${snapshot.foundryIssues.length} recent Foundry/provider issue${snapshot.foundryIssues.length === 1 ? "" : "s"}`);
		for (const issue of snapshot.foundryIssues) detail(issue);
	}

	section("Current session");
	item("info", "Session", snapshot.session.id);
	if (snapshot.session.file) detail(snapshot.session.file.replace(homedir(), "~"));
	item((snapshot.session.fileBytes ?? 0) > 25 * 1024 * 1024 ? "warning" : "ok", "Session file size", formatBytes(snapshot.session.fileBytes));
	item(snapshot.session.entries > 5_000 ? "warning" : "ok", "Entries",
		`${compactNumber(snapshot.session.entries)} total · ${compactNumber(snapshot.session.branchEntries)} active branch · ${compactNumber(snapshot.session.contextEntries)} context-visible`);
	item("info", "Messages", compactNumber(snapshot.session.messages));
	if (snapshot.session.contextWindow) {
		const tokens = snapshot.session.contextTokens;
		const percent = typeof tokens === "number" ? ` · ${((tokens / snapshot.session.contextWindow) * 100).toFixed(1)}%` : "";
		item("info", "Context", `${tokens == null ? "unknown" : compactNumber(tokens)} / ${compactNumber(snapshot.session.contextWindow)}${percent}`);
	}

	section("Terminal and notifications");
	const identity = `${process.env.TERM_PROGRAM ?? "unknown"} / ${process.env.TERM ?? "unknown"}`;
	item(process.stdout.isTTY ? "ok" : "warning", "Interactive terminal", process.stdout.isTTY ? identity : "stdout is not a TTY");
	item("info", "Viewport", `${process.stdout.columns ?? "?"}×${process.stdout.rows ?? "?"} · ${process.platform}${process.env.TMUX ? " · tmux" : ""}`);
	const osc9 = Boolean(process.stdout.isTTY && /ghostty|iterm|kitty|warp|wezterm/i.test(identity));
	item(osc9 ? "ok" : "info", "OSC 9 notifications", osc9 ? "supported by detected terminal" : "fallback may be used");
	item(snapshot.notificationsEnabled === false ? "warning" : "ok", "Desktop notifications",
		snapshot.notificationsEnabled === false ? "disabled" : snapshot.notificationsEnabled === true ? "enabled" : "default enabled; no config file");

	section("Suggestions");
	const suggestions: DiagnosticIssue[] = [];
	if (snapshot.startupIssues.length) suggestions.push({ severity: "error", text: "Resolve extension startup failures before trusting downstream health checks." });
	if (snapshot.duplicates.length) suggestions.push({ severity: "warning", text: "Rename duplicate extension commands or shortcuts to avoid numeric invocation suffixes and ambiguous keys." });
	if (snapshot.missingEnabledModels.length) suggestions.push({ severity: "error", text: "Remove or correct stale enabledModels entries in settings.json." });
	if (snapshot.foundryIssues.some((issue) => /rate limit|429|exceeded/i.test(issue))) suggestions.push({ severity: "warning", text: "Recent Foundry evidence indicates throttling; avoid hidden retries and inspect the provider quota before another large run." });
	if ((snapshot.session.fileBytes ?? 0) > 25 * 1024 * 1024) suggestions.push({ severity: "warning", text: "This session is large. Renderer caches are active, but a fresh session may make diagnostics and session search faster." });
	if (suggestions.length === 0) suggestions.push({ severity: "info", text: "No corrective action is currently suggested." });
	for (const suggestion of suggestions) item(suggestion.severity === "warning" ? "warning" : suggestion.severity, suggestion.text);
	lines.push("");
	lines.push(theme.fg("dim", "Doctor never changes configuration, reloads extensions, or retries providers."));
	return { lines, items };
}

class DoctorPager {
	private scroll = 0;
	private cachedWidth = 0;
	private cachedLines: string[] = [];
	private readonly container: Container;
	private readonly border: DynamicBorder;
	private readonly title: Text;
	private readonly body: Text;
	private readonly footer: Text;
	private readonly report: DoctorReport;

	constructor(
		private readonly snapshot: DoctorSnapshot,
		private readonly tui: TUI,
		private readonly theme: any,
		private readonly done: (result?: unknown) => void,
	) {
		// Canonical pi pattern (see tui.md Pattern 1 / summarize.ts): a Container
		// framed by DynamicBorder top+bottom, with Text children. Pi draws the
		// border and handles width/resize, so we avoid hand-drawn box chars and
		// manual width math.
		this.border = new DynamicBorder((s: string) => this.theme.fg("accent", s));
		this.title = new Text("", 1, 0);
		this.body = new Text("", 1, 0);
		this.footer = new Text(this.theme.fg("dim", "↑↓/PgUp/PgDn scroll · Home/End · q close"), 1, 0);
		this.report = buildDoctorReport(this.snapshot, this.tui, this.theme);

		this.container = new Container();
		this.container.addChild(this.border);
		this.container.addChild(this.title);
		this.container.addChild(this.body);
		this.container.addChild(this.footer);
		this.container.addChild(this.border);

		// The headline summarizes the exact item set rendered in the body.
		const { errors, warnings } = countReportIssues(this.report.items);
		const status = errors > 0 ? this.theme.fg("error", `${errors} error${errors === 1 ? "" : "s"}`)
			: warnings > 0 ? this.theme.fg("warning", `${warnings} warning${warnings === 1 ? "" : "s"}`)
			: this.theme.fg("success", "all green");
		this.title.setText(`${this.theme.fg("accent", this.theme.bold("Pi Doctor"))} ${this.theme.fg("dim", "·")} ${status} ${this.theme.fg("dim", "· read-only diagnostics")}`);
	}

	// Wrap report lines to the available width. Cache key is the width so a
	// re-render at the same width is cheap.
	private lines(width: number): string[] {
		if (this.cachedWidth === width) return this.cachedLines;
		const wrapped: string[] = [];
		for (const line of this.report.lines) {
			if (!line) { wrapped.push(""); continue; }
			wrapped.push(...wrapTextWithAnsi(line, Math.max(1, width)));
		}
		this.cachedWidth = width;
		this.cachedLines = wrapped;
		return wrapped;
	}

	render(width: number): string[] {
		const max = Math.max(1, width);
		// Reserve rows for: top border, title, footer, bottom border (4 rows).
		const height = Math.max(10, (process.stdout.rows || 24) - 5);
		const bodyHeight = Math.max(1, height - 4);
		const lines = this.lines(max);
		const maxScroll = Math.max(0, lines.length - bodyHeight);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visible = lines.slice(this.scroll, this.scroll + bodyHeight);
		while (visible.length < bodyHeight) visible.push("");
		this.body.setText(visible.join("\n"));
		return this.container.render(max);
	}

	handleInput(data: string): void {
		const page = Math.max(5, (process.stdout.rows || 24) - 9);
		if (matchesKey(data, Key.escape) || data === "q") return this.done(undefined);
		if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, Key.down)) this.scroll += 1;
		else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - page);
		else if (matchesKey(data, Key.pageDown)) this.scroll += page;
		else if (matchesKey(data, Key.home)) this.scroll = 0;
		else if (matchesKey(data, Key.end)) this.scroll = Number.MAX_SAFE_INTEGER;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.container.invalidate();
	}
}
export default function (pi: ExtensionAPI) {
	pi.registerCommand("doctor", {
		description: "Inspect extension, provider, session, cache, and terminal health",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("doctor", ctx.ui.theme.fg("accent", "doctor…"));
			try {
				const snapshot = await buildSnapshot(pi, ctx);
				if (ctx.mode !== "tui") {
					ctx.ui.notify(`Pi Doctor: ${snapshot.extensions.length} extensions, ${snapshot.startupIssues.length} startup errors, ${snapshot.duplicates.length} duplicate registrations.`, "info");
					return;
				}
				await ctx.ui.custom((tui: TUI, theme: any, _kb: any, done: (result: unknown) => void) =>
					new DoctorPager(snapshot, tui, theme, done), {
						overlay: true,
						overlayOptions: { width: "94%", maxHeight: "92%", anchor: "center", margin: 1 },
					});
			} finally {
				ctx.ui.setStatus("doctor", undefined);
			}
		},
	});
}
