import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, sliceByColumn, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

export const EXPLORATION_DETAILS_KEY = "__pi_exploration";
const REGISTRY_KEY = Symbol.for("pi.exploration.registry.v2");
const EXPLORATION_TOOLS = new Set(["read", "ls", "grep", "find"]);

export interface Activity {
	verb: "Read" | "List" | "Search";
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

export function explorationActivity(toolName: string, rawArgs: any): Activity | undefined {
	const args = strippedArgs(rawArgs);
	if (toolName === "read" && typeof args.path === "string") {
		return { verb: "Read", detail: args.path };
	}
	if (toolName === "ls") {
		return { verb: "List", detail: typeof args.path === "string" ? args.path : "." };
	}
	if ((toolName === "grep" || toolName === "find") && typeof args.pattern === "string") {
		return {
			verb: "Search",
			detail: typeof args.path === "string" ? `${args.pattern} in ${args.path}` : args.pattern,
		};
	}
	return undefined;
}

function wrapDetail(text: string, width: number): string[] {
	const maxWidth = Math.max(1, width);
	const rows: string[] = [];
	let remaining = text.trim();
	while (visibleWidth(remaining) > maxWidth) {
		const window = sliceByColumn(remaining, 0, maxWidth);
		const whitespace = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
		const slash = window.lastIndexOf("/");
		const comma = window.lastIndexOf(",");
		let split = Math.max(whitespace, slash, comma >= 0 ? comma + 1 : -1);
		if (split <= 0) split = window.length;
		const row = remaining.slice(0, split).trimEnd();
		rows.push(row || window);
		remaining = remaining.slice(split);
		if (/^[\s,]/.test(remaining)) remaining = remaining.replace(/^\s+/, "");
	}
	rows.push(remaining);
	return rows;
}

function coalescedActivities(activities: readonly Activity[]): Activity[] {
	const grouped: Activity[] = [];
	for (let index = 0; index < activities.length;) {
		const current = activities[index];
		if (current.verb !== "Read") {
			grouped.push({ ...current });
			index += 1;
			continue;
		}

		const details: string[] = [];
		const seen = new Set<string>();
		while (index < activities.length && activities[index].verb === "Read") {
			const detail = activities[index].detail;
			if (!seen.has(detail)) {
				seen.add(detail);
				details.push(detail);
			}
			index += 1;
		}
		grouped.push({ verb: "Read", detail: details.join(", ") });
	}
	return grouped;
}

export function renderExploration(
	activities: readonly Activity[],
	active: boolean,
	theme: any,
	width: number,
): string[] {
	const maxWidth = Math.max(1, width);
	const bullet = theme.fg(active ? "accent" : "dim", "•");
	const title = active ? "Exploring" : "Explored";
	const lines = [truncateToWidth(`${bullet} ${theme.bold(title)}`, maxWidth, "…")];
	const grouped = coalescedActivities(activities);

	grouped.forEach((item, index) => {
		const treePrefix = index === 0 ? "  └ " : "    ";
		const verb = theme.fg("accent", item.verb);
		const firstPrefix = `${treePrefix}${verb} `;
		const continuationPrefix = " ".repeat(visibleWidth(firstPrefix));
		const detailWidth = Math.max(1, maxWidth - visibleWidth(firstPrefix));
		const detailRows = wrapDetail(item.detail, detailWidth);
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

function hasVisibleAssistantContent(entry: any): boolean {
	if (entry?.type !== "message" || entry.message?.role !== "assistant") return false;
	const content = entry.message?.content;
	return Array.isArray(content)
		&& content.some((item: any) => {
			if (item?.type === "text" && typeof item.text === "string") return item.text.trim();
			if (item?.type === "thinking" && typeof item.thinking === "string") return item.thinking.trim();
			return false;
		});
}

function isNonEmptyThinkingDelta(event: any): boolean {
	return event.assistantMessageEvent?.type === "thinking_delta"
		&& typeof event.assistantMessageEvent.delta === "string"
		&& Boolean(event.assistantMessageEvent.delta.trim());
}

function restorePersistedGroups(entries: readonly any[]): void {
	clearRegistry(true);
	// Rebuild contiguous exploration stretches into one canonical group while
	// preserving ordering inside each stored group. Visible assistant content,
	// including non-empty reasoning/thinking, remains a hard boundary.
	let currentCanonicalGroup: ExplorationGroup | undefined;
	let nextCanonicalIndex = 0;
	const offsetsByStoredGroup = new Map<string, number>();
	const closeRestoredGroup = () => {
		currentCanonicalGroup = undefined;
		nextCanonicalIndex = 0;
		offsetsByStoredGroup.clear();
	};

	for (const entry of entries) {
		if (hasVisibleAssistantContent(entry)) {
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
			const firstMarker = { ...marker, index: 0, leaderId: marker.toolCallId };
			currentCanonicalGroup = upsertPersistedMarker(firstMarker);
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
