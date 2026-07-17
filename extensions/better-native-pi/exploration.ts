/**
 * Dependency graph:
 * Direct: `./render.js`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
 *   `node:path`.
 * Used by: `extensions/better-native-pi/file-tools.ts`, `extensions/better-native-pi/index.ts`.
 */
import { basename, dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { shortPath } from "./render.js";

export const EXPLORATION_DETAILS_KEY = "__pi_exploration";
const REGISTRY_KEY = Symbol.for("pi.exploration.registry.v2");
const TURN_SEPARATOR_ENTRY_TYPE = "turn-separator";
const EXPLORATION_TOOLS = new Set(["read", "ls", "grep", "find"]);

export interface Activity {
	verb: "Read" | "List" | "Search";
	detail: string;
	/** Raw path for structured read coalescing; detail stays as fallback text. */
	path?: string;
	/** Human range label, e.g. "lines 10-40", for chunked reads. */
	range?: string;
}

interface DisplayActivity {
	verb: Activity["verb"];
	detail: string;
}

interface LegacySummary {
	activities: Activity[];
}

type CallStatus = "pending" | "done" | "error";

export interface ExplorationMarker {
	version: 2;
	groupId: string;
	leaderId: string;
	index: number;
	toolCallId: string;
	toolName: string;
	activity: Activity;
	isError: boolean;
}

interface ExplorationCall {
	toolCallId: string;
	toolName: string;
	activity: Activity;
	index: number;
	status: CallStatus;
}

interface ExplorationGroup {
	id: string;
	leaderId: string;
	calls: ExplorationCall[];
	accepting: boolean;
	runtime: boolean;
	component?: ExplorationGroupComponent;
	requestRender?: () => void;
}

interface ExplorationRegistry {
	rendererEnabled: boolean;
	sequence: number;
	currentGroupId?: string;
	groups: Map<string, ExplorationGroup>;
	callToGroup: Map<string, string>;
}

function registry(): ExplorationRegistry {
	const root = globalThis as typeof globalThis & { [REGISTRY_KEY]?: ExplorationRegistry };
	return root[REGISTRY_KEY] ??= {
		rendererEnabled: false,
		sequence: 0,
		groups: new Map(),
		callToGroup: new Map(),
	};
}

function clearRegistry(preserveRenderer = true): void {
	const state = registry();
	const rendererEnabled = preserveRenderer ? state.rendererEnabled : false;
	state.rendererEnabled = rendererEnabled;
	state.sequence = 0;
	state.currentGroupId = undefined;
	state.groups.clear();
	state.callToGroup.clear();
}

/** Called by file-tools when its exploration-aware tool renderers are active. */
export function enableExplorationToolRendering(): void {
	registry().rendererEnabled = true;
}

export function isExplorationTool(toolName: string): boolean {
	return EXPLORATION_TOOLS.has(toolName);
}

function strippedArgs(args: any): any {
	if (!args || typeof args !== "object") return {};
	const { reasoning: _reasoning, ...rest } = args;
	return rest;
}

function readRangeLabel(args: any): string | undefined {
	const offset = Number.isInteger(args.offset) ? args.offset : undefined;
	const limit = Number.isInteger(args.limit) ? args.limit : undefined;
	if (offset !== undefined && limit !== undefined) return `lines ${offset}-${offset + limit - 1}`;
	if (offset !== undefined) return `from line ${offset}`;
	if (limit !== undefined) return `first ${limit} lines`;
	return undefined;
}

function readActivity(args: any): Activity {
	const path = String(args.path);
	const range = readRangeLabel(args);
	return {
		verb: "Read",
		detail: range ? `${path} · ${range}` : path,
		path,
		range,
	};
}

export function explorationActivity(toolName: string, rawArgs: any): Activity | undefined {
	const args = strippedArgs(rawArgs);
	if (toolName === "read" && typeof args.path === "string") return readActivity(args);
	if (toolName === "ls") {
		return { verb: "List", detail: typeof args.path === "string" ? shortPath(args.path) : "." };
	}
	if ((toolName === "grep" || toolName === "find") && typeof args.pattern === "string") {
		return {
			verb: "Search",
			detail: typeof args.path === "string" ? `${args.pattern} in ${shortPath(args.path)}` : args.pattern,
		};
	}
	return undefined;
}

function wrapDetail(text: string, width: number): string[] {
	return wrapTextWithAnsi(text.trim(), Math.max(1, width));
}

function compactRangeList(ranges: readonly string[]): string | undefined {
	const unique = [...new Set(ranges.filter(Boolean))];
	if (unique.length === 0) return undefined;
	const linePrefix = "lines ";
	if (unique.every((range) => range.startsWith(linePrefix))) {
		return `${linePrefix}${unique.map((range) => range.slice(linePrefix.length)).join(", ")}`;
	}
	return unique.join(", ");
}

function readPathDisplay(path: string): string {
	const file = basename(path);
	const directory = dirname(path);
	if (!directory || directory === ".") return file;
	const displayDirectory = shortPath(directory);
	const suffix = displayDirectory.endsWith("/") ? "" : "/";
	return `${file} in ${displayDirectory}${suffix}`;
}

function appendReadRun(grouped: DisplayActivity[], reads: readonly Activity[]): void {
	const byPath = new Map<string, { path: string; ranges: string[]; wholeFile: boolean }>();
	for (const read of reads) {
		const path = read.path ?? read.detail;
		let item = byPath.get(path);
		if (!item) {
			item = { path, ranges: [], wholeFile: false };
			byPath.set(path, item);
		}
		if (read.range) item.ranges.push(read.range);
		else item.wholeFile = true;
	}

	for (const item of byPath.values()) {
		const ranges = compactRangeList(item.ranges);
		const suffix = item.wholeFile
			? (ranges ? ` · whole file, ${ranges}` : "")
			: (ranges ? ` · ${ranges}` : "");
		grouped.push({ verb: "Read", detail: `${readPathDisplay(item.path)}${suffix}` });
	}
}

function displayDetail(activity: Activity): string {
	if (activity.verb === "List") return activity.detail === "." ? "." : shortPath(activity.detail);
	if (activity.verb !== "Search") return activity.detail;
	const separator = " in ";
	const index = activity.detail.lastIndexOf(separator);
	if (index < 0) return activity.detail;
	return `${activity.detail.slice(0, index)}${separator}${shortPath(activity.detail.slice(index + separator.length))}`;
}

function coalescedActivities(activities: readonly Activity[]): DisplayActivity[] {
	const grouped: DisplayActivity[] = [];
	for (let index = 0; index < activities.length;) {
		const current = activities[index];
		if (current.verb !== "Read") {
			grouped.push({ verb: current.verb, detail: displayDetail(current) });
			index += 1;
			continue;
		}

		const reads: Activity[] = [];
		while (index < activities.length && activities[index].verb === "Read") {
			reads.push(activities[index]);
			index += 1;
		}
		appendReadRun(grouped, reads);
	}
	return grouped;
}

function dim(theme: any, text: string): string {
	return typeof theme?.fg === "function" ? theme.fg("dim", text) : text;
}

function accent(theme: any, text: string): string {
	return typeof theme?.fg === "function" ? theme.fg("accent", text) : text;
}

function styledReadDetail(detail: string, theme: any): string {
	const rangeSeparator = " · ";
	const rangeIndex = detail.indexOf(rangeSeparator);
	const location = rangeIndex < 0 ? detail : detail.slice(0, rangeIndex);
	const range = rangeIndex < 0 ? "" : detail.slice(rangeIndex);
	const inSeparator = " in ";
	const inIndex = location.lastIndexOf(inSeparator);
	const styledLocation = inIndex < 0
		? location
		: `${location.slice(0, inIndex)}${dim(theme, inSeparator)}${location.slice(inIndex + inSeparator.length)}`;
	return `${styledLocation}${range ? dim(theme, range) : ""}`;
}

function styledDetail(item: DisplayActivity, theme: any): string {
	if (item.verb === "Read") return styledReadDetail(item.detail, theme);
	if (item.verb === "Search") {
		const separator = " in ";
		const index = item.detail.lastIndexOf(separator);
		if (index < 0) return item.detail;
		return `${item.detail.slice(0, index)}${dim(theme, separator)}${item.detail.slice(index + separator.length)}`;
	}
	return item.detail;
}

export function renderExploration(
	activities: readonly Activity[],
	active: boolean,
	theme: any,
	width: number,
): string[] {
	const maxWidth = Math.max(1, width);
	const styleHeading = active ? (text: string) => accent(theme, text) : (text: string) => text;
	const bullet = styleHeading("•");
	const title = active ? "Exploring" : "Explored";
	const lines = [truncateToWidth(`${bullet} ${styleHeading(theme.bold(title))}`, maxWidth, "…")];
	const grouped = coalescedActivities(activities);

	grouped.forEach((item, index) => {
		const isLast = index === grouped.length - 1;
		const connector = isLast ? "└" : "├";
		const gutter = isLast ? "    " : "  │ ";
		const verb = accent(theme, item.verb);
		const firstPrefix = `${dim(theme, `  ${connector} `)}${verb} `;
		const continuationPrefix = `${dim(theme, gutter)}${" ".repeat(visibleWidth(`${item.verb} `))}`;
		const detailWidth = Math.max(1, maxWidth - visibleWidth(firstPrefix));
		const detailRows = wrapDetail(styledDetail(item, theme), detailWidth);
		for (const [rowIndex, row] of detailRows.entries()) {
			const prefix = rowIndex === 0 ? firstPrefix : continuationPrefix;
			lines.push(truncateToWidth(`${prefix}${row}`, maxWidth, "…"));
		}
	});
	return lines;
}

/** Backward-compatible renderer for old persisted recap entries. */
export function renderSummary(summary: LegacySummary, theme: any, width: number): string[] {
	return renderExploration(summary.activities ?? [], false, theme, width);
}

class ExplorationGroupComponent implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly groupId: string,
		private readonly theme: any,
	) {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const maxWidth = Math.max(1, width);
		if (this.cachedLines && this.cachedWidth === maxWidth) return this.cachedLines;
		const group = registry().groups.get(this.groupId);
		if (!group) return [];
		const activities = [...group.calls]
			.sort((a, b) => a.index - b.index)
			.map((call) => call.activity);
		const active = group.calls.some((call) => call.status === "pending");
		this.cachedLines = renderExploration(activities, active, this.theme, maxWidth);
		this.cachedWidth = maxWidth;
		return this.cachedLines;
	}
}

function notifyGroup(group: ExplorationGroup): void {
	group.component?.invalidate();
	group.requestRender?.();
}

function createGroup(runtime: boolean, preferredId?: string, leaderId?: string): ExplorationGroup {
	const state = registry();
	const id = preferredId ?? `explore-${Date.now().toString(36)}-${++state.sequence}`;
	const group: ExplorationGroup = {
		id,
		leaderId: leaderId ?? "",
		calls: [],
		accepting: runtime,
		runtime,
	};
	state.groups.set(id, group);
	if (runtime) state.currentGroupId = id;
	return group;
}

function currentAcceptingGroup(): ExplorationGroup | undefined {
	const state = registry();
	const group = state.currentGroupId ? state.groups.get(state.currentGroupId) : undefined;
	return group?.accepting ? group : undefined;
}

function ensureLiveCall(toolCallId: string, toolName: string, args: any): ExplorationGroup | undefined {
	const state = registry();
	if (!state.rendererEnabled) return undefined;
	const activity = explorationActivity(toolName, args);
	if (!activity) return undefined;

	const existingId = state.callToGroup.get(toolCallId);
	if (existingId) {
		const existing = state.groups.get(existingId);
		const call = existing?.calls.find((item) => item.toolCallId === toolCallId);
		if (call && (call.activity.verb !== activity.verb || call.activity.detail !== activity.detail)) {
			call.activity = activity;
			notifyGroup(existing!);
		}
		return existing;
	}

	const group = currentAcceptingGroup() ?? createGroup(true);
	if (!group.leaderId) group.leaderId = toolCallId;
	const call: ExplorationCall = {
		toolCallId,
		toolName,
		activity,
		index: group.calls.length,
		status: "pending",
	};
	group.calls.push(call);
	state.callToGroup.set(toolCallId, group.id);
	notifyGroup(group);
	return group;
}

function groupForCall(toolCallId: string): ExplorationGroup | undefined {
	const state = registry();
	const groupId = state.callToGroup.get(toolCallId);
	return groupId ? state.groups.get(groupId) : undefined;
}

function finishCall(toolCallId: string, isError: boolean): ExplorationCall | undefined {
	const group = groupForCall(toolCallId);
	const call = group?.calls.find((item) => item.toolCallId === toolCallId);
	if (!group || !call) return undefined;
	call.status = isError ? "error" : "done";
	notifyGroup(group);
	return call;
}

function closeCurrentGroup(): void {
	const state = registry();
	const group = currentAcceptingGroup();
	if (!group) return;
	group.accepting = false;
	state.currentGroupId = undefined;
	notifyGroup(group);
}

function markerFrom(value: any): ExplorationMarker | undefined {
	const marker = value?.[EXPLORATION_DETAILS_KEY];
	if (!marker || marker.version !== 2) return undefined;
	if (typeof marker.groupId !== "string" || typeof marker.leaderId !== "string") return undefined;
	if (typeof marker.toolCallId !== "string" || typeof marker.toolName !== "string") return undefined;
	if (!Number.isInteger(marker.index) || !marker.activity || typeof marker.activity.detail !== "string") return undefined;
	if (marker.activity.verb !== "Read" && marker.activity.verb !== "List" && marker.activity.verb !== "Search") return undefined;
	return marker as ExplorationMarker;
}

function markerForCall(group: ExplorationGroup, call: ExplorationCall, isError: boolean): ExplorationMarker {
	return {
		version: 2,
		groupId: group.id,
		leaderId: group.leaderId,
		index: call.index,
		toolCallId: call.toolCallId,
		toolName: call.toolName,
		activity: { ...call.activity },
		isError,
	};
}

function upsertPersistedMarker(marker: ExplorationMarker): ExplorationGroup {
	const state = registry();
	let group = state.groups.get(marker.groupId);
	let changed = false;
	if (!group) {
		group = createGroup(false, marker.groupId, marker.leaderId);
		changed = true;
	}
	if (group.leaderId !== marker.leaderId) {
		group.leaderId = marker.leaderId;
		changed = true;
	}
	if (!group.runtime && group.accepting) {
		group.accepting = false;
		changed = true;
	}
	let call = group.calls.find((item) => item.toolCallId === marker.toolCallId);
	const status: CallStatus = marker.isError ? "error" : "done";
	if (!call) {
		call = {
			toolCallId: marker.toolCallId,
			toolName: marker.toolName,
			activity: { ...marker.activity },
			index: marker.index,
			status,
		};
		group.calls.push(call);
		changed = true;
	} else {
		if (call.toolName !== marker.toolName) {
			call.toolName = marker.toolName;
			changed = true;
		}
		if (call.activity.verb !== marker.activity.verb || call.activity.detail !== marker.activity.detail) {
			call.activity = { ...marker.activity };
			changed = true;
		}
		if (call.index !== marker.index) {
			call.index = marker.index;
			changed = true;
		}
		if (call.status !== status) {
			call.status = status;
			changed = true;
		}
	}
	if (state.callToGroup.get(marker.toolCallId) !== group.id) {
		state.callToGroup.set(marker.toolCallId, group.id);
		changed = true;
	}
	if (changed) {
		group.calls.sort((a, b) => a.index - b.index);
		notifyGroup(group);
	}
	return group;
}

function isAssistantMessageEntry(entry: any): boolean {
	return entry?.type === "message" && entry.message?.role === "assistant";
}

function isTurnSeparatorEntry(entry: any): boolean {
	return entry?.type === "custom" && entry.customType === TURN_SEPARATOR_ENTRY_TYPE;
}

function isNonEmptyThinkingDelta(event: any): boolean {
	return event.assistantMessageEvent?.type === "thinking_delta"
		&& typeof event.assistantMessageEvent.delta === "string"
		&& Boolean(event.assistantMessageEvent.delta.trim());
}

function restorePersistedGroups(entries: readonly any[]): void {
	clearRegistry(true);
	// Rebuild contiguous exploration calls within each assistant step. Tool-only
	// assistant messages still get a turn separator, so grouping across assistant
	// entries makes later calls render as empty followers below stacked separators.
	let currentCanonicalGroup: ExplorationGroup | undefined;
	let nextCanonicalIndex = 0;
	const offsetsByStoredGroup = new Map<string, number>();
	const closeRestoredGroup = () => {
		currentCanonicalGroup = undefined;
		nextCanonicalIndex = 0;
		offsetsByStoredGroup.clear();
	};

	for (const entry of entries) {
		if (isAssistantMessageEntry(entry) || isTurnSeparatorEntry(entry)) {
			closeRestoredGroup();
			continue;
		}

		if (entry?.type !== "message" || entry.message?.role !== "toolResult") continue;
		const marker = markerFrom(entry.message.details);
		if (!marker) {
			if (typeof entry.message?.toolName === "string" && !isExplorationTool(entry.message.toolName)) {
				closeRestoredGroup();
			}
			continue;
		}

		if (!currentCanonicalGroup) {
			// Use a restore-local canonical id instead of marker.groupId. Older
			// sessions may have persisted one group id across multiple assistant
			// steps; after a boundary split, reusing that id would rejoin them.
			const canonicalGroup = createGroup(false, undefined, marker.toolCallId);
			currentCanonicalGroup = upsertPersistedMarker({
				...marker,
				groupId: canonicalGroup.id,
				index: 0,
				leaderId: marker.toolCallId,
			});
			nextCanonicalIndex = 1;
			offsetsByStoredGroup.set(marker.groupId, 0 - marker.index);
			continue;
		}

		let offset = offsetsByStoredGroup.get(marker.groupId);
		if (offset === undefined) {
			offset = nextCanonicalIndex;
			offsetsByStoredGroup.set(marker.groupId, offset);
		}
		const canonicalIndex = marker.index + offset;
		nextCanonicalIndex = Math.max(nextCanonicalIndex, canonicalIndex + 1);
		upsertPersistedMarker({
			...marker,
			groupId: currentCanonicalGroup.id,
			leaderId: currentCanonicalGroup.leaderId,
			index: canonicalIndex,
		});
	}
}

function leaderComponent(group: ExplorationGroup, theme: any, context: any): Component {
	group.component ??= new ExplorationGroupComponent(group.id, theme);
	if (typeof context?.invalidate === "function") group.requestRender = () => context.invalidate();
	return group.component;
}

/** Returns undefined when file-tools should use its normal renderer. */
export function renderExplorationCall(
	toolName: string,
	args: any,
	theme: any,
	context: any,
): Component | undefined {
	if (!isExplorationTool(toolName) || !registry().rendererEnabled || !context?.isPartial) return undefined;
	const toolCallId = context.toolCallId as string | undefined;
	if (!toolCallId) return undefined;
	const group = ensureLiveCall(toolCallId, toolName, args);
	if (!group) return undefined;
	return group.leaderId === toolCallId ? leaderComponent(group, theme, context) : new Container();
}

/** Returns undefined when file-tools should use its normal result renderer. */
export function renderExplorationResult(
	toolName: string,
	result: any,
	options: any,
	theme: any,
	context: any,
): Component | undefined {
	if (!isExplorationTool(toolName) || !registry().rendererEnabled) return undefined;
	const toolCallId = context?.toolCallId as string | undefined;
	if (!toolCallId) return undefined;
	if (options?.isPartial) {
		return groupForCall(toolCallId) ? new Container() : undefined;
	}

	const marker = markerFrom(result?.details);
	const group = groupForCall(toolCallId) ?? (marker ? upsertPersistedMarker(marker) : undefined);
	if (!group) return undefined;
	return group.leaderId === toolCallId ? leaderComponent(group, theme, context) : new Container();
}

export function resetExplorationStateForTests(): void {
	clearRegistry(false);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		restorePersistedGroups(ctx.sessionManager.getBranch());
	});

	pi.on("session_tree", (_event, ctx) => {
		restorePersistedGroups(ctx.sessionManager.getBranch());
	});

	pi.on("session_compact", (_event, ctx) => {
		restorePersistedGroups(ctx.sessionManager.getBranch());
	});

	pi.on("before_agent_start", () => {
		closeCurrentGroup();
	});

	pi.on("message_start", (event: any) => {
		if (event.message?.role === "assistant") closeCurrentGroup();
	});

	pi.on("tool_execution_start", (event: any) => {
		if (!registry().rendererEnabled) return;
		if (isExplorationTool(event.toolName)) {
			ensureLiveCall(event.toolCallId, event.toolName, event.args);
		} else {
			closeCurrentGroup();
		}
	});

	pi.on("tool_result", (event: any) => {
		if (!registry().rendererEnabled || !isExplorationTool(event.toolName)) return;
		const group = groupForCall(event.toolCallId)
			?? ensureLiveCall(event.toolCallId, event.toolName, event.input);
		const call = finishCall(event.toolCallId, Boolean(event.isError));
		if (!group || !call) return;
		const details = event.details && typeof event.details === "object" ? event.details : {};
		return {
			details: {
				...details,
				[EXPLORATION_DETAILS_KEY]: markerForCall(group, call, Boolean(event.isError)),
			},
		};
	});

	pi.on("tool_execution_end", (event: any) => {
		if (!registry().rendererEnabled || !isExplorationTool(event.toolName)) return;
		finishCall(event.toolCallId, Boolean(event.isError));
	});

	pi.on("message_update", (event: any) => {
		const type = event.assistantMessageEvent?.type;
		// Keep grouping across empty thinking metadata, but preserve transcript
		// chronology: visible non-empty thinking belongs between tool calls and
		// therefore splits exploration groups just like final-answer text.
		if (type === "text_start" || type === "text_delta" || isNonEmptyThinkingDelta(event)) {
			closeCurrentGroup();
		}
	});

	pi.on("agent_end", () => {
		closeCurrentGroup();
	});

	pi.on("session_shutdown", () => {
		closeCurrentGroup();
		registry().rendererEnabled = false;
	});

	// Keep old sessions readable. New groups are persisted inside each tool
	// result's details and therefore do not append duplicate custom entries.
	pi.registerEntryRenderer<LegacySummary>("exploration", (entry: any, _options: any, theme: any) =>
		new LegacyExplorationSummary(entry.data ?? { activities: [] }, theme));
}

class LegacyExplorationSummary implements Component {
	constructor(private readonly summary: LegacySummary, private readonly theme: any) {}
	render(width: number): string[] { return renderSummary(this.summary, this.theme, width); }
	invalidate(): void {}
}
