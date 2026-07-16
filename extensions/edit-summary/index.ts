import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
	generateUnifiedPatch,
	isEditToolResult,
	isToolCallEventType,
	isWriteToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	PLAN_OVERLAY_LAYOUT_EVENT,
	PLAN_OVERLAY_LAYOUT_REQUEST_EVENT,
	parsePlanOverlayLayout,
	type PlanOverlayLayout,
} from "../plan-progress/layout.js";

const ENTRY_TYPE = "edit-summary-state-v1";
const MAX_VISIBLE_FILES = 8;
const DEFAULT_TOP_MARGIN = 1;
const OVERLAY_GAP = 1;

interface FileSummary {
	path: string;
	status: "added" | "modified";
	additions: number;
	removals: number;
}

interface PersistedSummary {
	files: FileSummary[];
	completedAt: number;
}

interface DisplaySummary {
	phase: "current" | "last";
	files: FileSummary[];
}

interface FileSnapshot {
	absolutePath: string;
	displayPath: string;
	existed: boolean;
	content: string;
}

function normalizeToolPath(cwd: string, inputPath: string): { absolutePath: string; displayPath: string } {
	const normalizedInput = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
	const absolutePath = isAbsolute(normalizedInput) ? normalizedInput : resolve(cwd, normalizedInput);
	const relativePath = relative(cwd, absolutePath);
	const displayPath = relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)
		? relativePath
		: absolutePath;
	return { absolutePath, displayPath };
}

async function snapshotFile(cwd: string, inputPath: string): Promise<FileSnapshot | undefined> {
	const { absolutePath, displayPath } = normalizeToolPath(cwd, inputPath);
	try {
		return {
			absolutePath,
			displayPath,
			existed: true,
			content: await readFile(absolutePath, "utf8"),
		};
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		if (code !== "ENOENT") return undefined;
		return { absolutePath, displayPath, existed: false, content: "" };
	}
}

export function countPatchChanges(patch: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) removals++;
	}
	return { additions, removals };
}

function isFileSummary(value: unknown): value is FileSummary {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<FileSummary>;
	return (
		typeof candidate.path === "string"
		&& (candidate.status === "added" || candidate.status === "modified")
		&& typeof candidate.additions === "number"
		&& Number.isFinite(candidate.additions)
		&& candidate.additions >= 0
		&& typeof candidate.removals === "number"
		&& Number.isFinite(candidate.removals)
		&& candidate.removals >= 0
	);
}

function restoreLastSummary(ctx: ExtensionContext): DisplaySummary {
	let restored: PersistedSummary | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data as Partial<PersistedSummary> | undefined;
		if (!data || !Array.isArray(data.files) || typeof data.completedAt !== "number") continue;
		if (!data.files.every(isFileSummary)) continue;
		if (!restored || data.completedAt >= restored.completedAt) {
			restored = { files: data.files, completedAt: data.completedAt };
		}
	}
	return { phase: "last", files: restored?.files ?? [] };
}

function sortedFiles(files: Iterable<FileSummary>): FileSummary[] {
	return [...files].sort((a, b) => a.path.localeCompare(b.path));
}

function summaryHeight(summary: DisplaySummary): number {
	const visibleFiles = Math.min(summary.files.length, MAX_VISIBLE_FILES);
	const overflowRow = summary.files.length > visibleFiles ? 1 : 0;
	return 6 + visibleFiles + overflowRow;
}

class EditSummaryOverlay implements Component {
	constructor(
		private readonly theme: Theme,
		private readonly getSummary: () => DisplaySummary,
	) {}

	render(width: number): string[] {
		if (width < 18) return [];
		const summary = this.getSummary();
		if (summary.files.length === 0) return [];

		const innerWidth = width - 2;
		const border = (text: string) => this.theme.fg("borderMuted", text);
		const horizontal = "─".repeat(innerWidth);
		const line = (content = "") => {
			const clipped = truncateToWidth(content, innerWidth, "");
			const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
			return `${border("│")}${clipped}${padding}${border("│")}`;
		};

		const title = `${this.theme.bold("File edits")} ${this.theme.fg("dim", `· ${summary.phase}`)}`;
		const lines = [border(`┌${horizontal}┐`), line(` ${title}`), line()];
		const visibleFiles = summary.files.slice(0, MAX_VISIBLE_FILES);

		for (const file of visibleFiles) {
			const status = file.status === "added"
				? this.theme.fg("success", "A")
				: this.theme.fg("accent", "M");
			const counts = [
				file.additions > 0 ? this.theme.fg("success", `+${file.additions}`) : "",
				file.removals > 0 ? this.theme.fg("error", `-${file.removals}`) : "",
			].filter(Boolean).join(" ");
			const prefix = ` ${status} `;
			const reserved = visibleWidth(prefix) + visibleWidth(counts) + (counts ? 1 : 0);
			const pathWidth = Math.max(1, innerWidth - reserved);
			const path = truncateToWidth(file.path, pathWidth, "…");
			const gap = " ".repeat(Math.max(1, innerWidth - visibleWidth(prefix) - visibleWidth(path) - visibleWidth(counts)));
			lines.push(line(`${prefix}${path}${counts ? `${gap}${counts}` : ""}`));
		}

		if (summary.files.length > visibleFiles.length) {
			lines.push(line(this.theme.fg("dim", `   … ${summary.files.length - visibleFiles.length} more`)));
		}

		const additions = summary.files.reduce((total, file) => total + file.additions, 0);
		const removals = summary.files.reduce((total, file) => total + file.removals, 0);
		const totalBits = [
			`${summary.files.length} ${summary.files.length === 1 ? "file" : "files"}`,
			this.theme.fg("success", `+${additions}`),
			this.theme.fg("error", `-${removals}`),
		];
		lines.push(line(), line(` ${this.theme.fg("dim", totalBits.join("  "))}`), border(`└${horizontal}┘`));
		return lines;
	}

	invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let runActive = false;
	let displaySummary: DisplaySummary = { phase: "last", files: [] };
	let snapshots = new Map<string, FileSnapshot>();
	let currentFiles = new Map<string, FileSummary>();

	let overlayTui: TUI | undefined;
	let overlayHandle: OverlayHandle | undefined;
	let closeOverlay: (() => void) | undefined;
	let overlayGeneration = 0;
	let renderQueued = false;
	let planLayout: PlanOverlayLayout = { visible: false, height: 0 };

	const requestOverlayRender = () => {
		if (renderQueued) return;
		renderQueued = true;
		queueMicrotask(() => {
			renderQueued = false;
			overlayTui?.requestRender();
		});
	};
	const syncOverlay = () => {
		const shouldShow = enabled && displaySummary.files.length > 0;
		overlayHandle?.setHidden(!shouldShow);
		requestOverlayRender();
	};
	const stopPlanLayoutUpdates = pi.events.on(PLAN_OVERLAY_LAYOUT_EVENT, (value) => {
		const next = parsePlanOverlayLayout(value);
		if (!next) return;
		if (next.visible === planLayout.visible && next.height === planLayout.height) return;
		planLayout = next;
		requestOverlayRender();
	});

	const unmountOverlay = () => {
		overlayGeneration++;
		closeOverlay?.();
		closeOverlay = undefined;
		overlayHandle = undefined;
		overlayTui = undefined;
	};

	const mountOverlay = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		unmountOverlay();
		const generation = overlayGeneration;
		void ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				overlayTui = tui;
				closeOverlay = done;
				return new EditSummaryOverlay(theme, () => displaySummary);
			},
			{
				overlay: true,
				overlayOptions: () => {
					const top = planLayout.visible && planLayout.height > 0
						? DEFAULT_TOP_MARGIN + planLayout.height + OVERLAY_GAP
						: DEFAULT_TOP_MARGIN;
					return {
						anchor: "top-right",
						width: 46,
						maxHeight: "80%",
						margin: { top, right: 2 },
						nonCapturing: true,
						visible: (terminalWidth: number, terminalHeight: number) => (
							terminalWidth >= 72 && terminalHeight >= top + summaryHeight(displaySummary)
						),
					};
				},
				onHandle: (handle: OverlayHandle) => {
					overlayHandle = handle;
					syncOverlay();
				},
			},
		).catch(() => {
			// Session replacement can dispose the UI while this passive overlay is open.
		}).finally(() => {
			if (generation !== overlayGeneration) return;
			closeOverlay = undefined;
			overlayHandle = undefined;
			overlayTui = undefined;
		});
	};

	const beginRun = () => {
		runActive = true;
		snapshots = new Map();
		currentFiles = new Map();
		displaySummary = { phase: "current", files: [] };
		syncOverlay();
	};

	const captureBaseline = async (cwd: string, inputPath: string) => {
		const normalized = normalizeToolPath(cwd, inputPath);
		if (snapshots.has(normalized.absolutePath)) return;
		const snapshot = await snapshotFile(cwd, inputPath);
		if (snapshot) snapshots.set(snapshot.absolutePath, snapshot);
	};

	const refreshSummary = async (cwd: string, inputPath: string) => {
		const normalized = normalizeToolPath(cwd, inputPath);
		const baseline = snapshots.get(normalized.absolutePath);
		if (!baseline) return;

		let currentContent: string;
		try {
			currentContent = await readFile(baseline.absolutePath, "utf8");
		} catch {
			return;
		}

		const changed = !baseline.existed || currentContent !== baseline.content;
		if (!changed) {
			currentFiles.delete(baseline.absolutePath);
		} else {
			const patch = generateUnifiedPatch(
				baseline.displayPath,
				baseline.content,
				currentContent,
				0,
			);
			const { additions, removals } = countPatchChanges(patch);
			currentFiles.set(baseline.absolutePath, {
				path: baseline.displayPath,
				status: baseline.existed ? "modified" : "added",
				additions,
				removals,
			});
		}

		displaySummary = { phase: "current", files: sortedFiles(currentFiles.values()) };
		syncOverlay();
	};

	pi.registerCommand("edit-summary", {
		description: "Show, hide, or toggle the file edit summary overlay",
		getArgumentCompletions: (prefix: string) => {
			const values = ["show", "hide", "toggle"];
			const matches = values.filter((value) => value.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: (args, ctx) => {
			const action = args.trim().toLowerCase() || "toggle";
			if (!new Set(["show", "hide", "toggle"]).has(action)) {
				ctx.ui.notify("Usage: /edit-summary [show|hide|toggle]", "warning");
				return;
			}
			enabled = action === "show" ? true : action === "hide" ? false : !enabled;
			syncOverlay();
			ctx.ui.notify(`Edit summary overlay ${enabled ? "enabled" : "hidden"}.`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		runActive = false;
		snapshots = new Map();
		currentFiles = new Map();
		planLayout = { visible: false, height: 0 };
		displaySummary = restoreLastSummary(ctx);
		mountOverlay(ctx);
		pi.events.emit(PLAN_OVERLAY_LAYOUT_REQUEST_EVENT, undefined);
	});

	pi.on("before_agent_start", () => {
		// Keep one summary across retries, compaction recovery, steering, and queued
		// follow-ups. `agent_settled` is the user-visible run boundary.
		if (!runActive) beginRun();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
		if (!runActive) beginRun();
		await captureBaseline(ctx.cwd, event.input.path);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!isEditToolResult(event) && !isWriteToolResult(event)) return;
		if (event.isError || typeof event.input.path !== "string") return;
		await refreshSummary(ctx.cwd, event.input.path);
	});

	pi.on("agent_settled", () => {
		if (!runActive) return;
		const files = sortedFiles(currentFiles.values());
		displaySummary = { phase: "last", files };
		pi.appendEntry(ENTRY_TYPE, {
			files,
			completedAt: Date.now(),
		} satisfies PersistedSummary);
		runActive = false;
		snapshots.clear();
		currentFiles.clear();
		syncOverlay();
	});

	pi.on("session_shutdown", () => {
		runActive = false;
		snapshots.clear();
		currentFiles.clear();
		stopPlanLayoutUpdates();
		unmountOverlay();
	});
}
