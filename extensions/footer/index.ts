import { calculateCost, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

const FOOTER_INDENT = " ";
const SEPARATOR = " · ";
const CONTEXT_BASELINE_TOKENS = 12_000;
const COMMAND_TIMEOUT_MS = 2_500;
const TITLE_SPINNER_INTERVAL_MS = 200;
const TITLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// The default palette is Catppuccin Mocha, used as a fallback when no theme is
// available. When a theme is present, segments resolve to theme color tokens
// so the footer matches the rest of the TUI.
const FOOTER_COLORS = {
	thread: [156, 222, 211], // entity.name.section
	path: [171, 223, 167], // string
	branch: [143, 179, 239], // entity.name.function
	model: [246, 226, 183], // entity.name.type
	usage: [242, 181, 144], // constant.numeric
	timing: [185, 170, 224], // balanced accent for ttft/tps
} as const;

/** Map a footer segment accent to a theme color token, mirroring turn-stats
 * so the footer and the per-turn transcript row share one color vocabulary. */
const FOOTER_THEME_TOKEN: Record<StatusSegment["accent"], string> = {
	thread: "accent",       // session identity — same as turn-stats cost/tps (accent)
	path: "muted",          // cwd — secondary text, like turn-stats labels
	branch: "success",     // git branch — a status-ish green, like turn-stats duration
	model: "muted",        // model name — secondary, less prominent
	usage: "text",         // tokens/ctx — default text, like turn-stats token values
	timing: "accent",      // ttft/tps — accent, like turn-stats tps
};

interface BranchChanges {
	additions: number;
	deletions: number;
}

interface StatusSegment {
	accent: "thread" | "path" | "branch" | "model" | "usage" | "timing";
	text: string;
}

interface FooterGroup {
	segments: StatusSegment[];
	/** Optional longest-to-shortest alternatives used before dropping the group. */
	variants?: StatusSegment[][];
	/** Higher values are removed or shortened first when the terminal is narrow. */
	priority: number;
	required?: boolean;
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	sessionCacheHit?: number;
}

export function formatTokensCompact(value: number): string {
	const safe = Math.max(0, Math.trunc(value));
	if (safe === 0) return "0";
	if (safe < 1_000) return String(safe);

	const [scaled, suffix] = safe >= 1_000_000_000_000
		? [safe / 1_000_000_000_000, "T"]
		: safe >= 1_000_000_000
			? [safe / 1_000_000_000, "B"]
			: safe >= 1_000_000
				? [safe / 1_000_000, "M"]
				: [safe / 1_000, "K"];
	const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
	let formatted = scaled.toFixed(decimals);
	while (formatted.includes(".") && formatted.endsWith("0")) formatted = formatted.slice(0, -1);
	if (formatted.endsWith(".")) formatted = formatted.slice(0, -1);
	return `${formatted}${suffix}`;
}

export function formatCostCents(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
	if (cost < 0.01) return "<$0.01";
	const cents = Math.round((cost + Number.EPSILON) * 100) / 100;
	return `$${cents.toFixed(2)}`;
}

export function formatDirectory(directory: string): string {
	const home = homedir();
	return directory === home || directory.startsWith(`${home}/`)
		? `~${directory.slice(home.length)}`
		: directory;
}

export function truncateTitlePart(value: string, maxGraphemes: number): string {
	if (maxGraphemes <= 0) return "";
	const graphemes = [...GRAPHEME_SEGMENTER.segment(value)].map(({ segment }) => segment);
	if (graphemes.length <= maxGraphemes || maxGraphemes <= 3) {
		return graphemes.slice(0, maxGraphemes).join("");
	}
	return `${graphemes.slice(0, maxGraphemes - 3).join("")}...`;
}

export function contextRemainingPercent(tokens: number | undefined, contextWindow: number): number {
	if (contextWindow <= CONTEXT_BASELINE_TOKENS) return 0;
	if (tokens === undefined) return 100;
	const effectiveWindow = contextWindow - CONTEXT_BASELINE_TOKENS;
	const used = Math.max(0, tokens - CONTEXT_BASELINE_TOKENS);
	const remaining = Math.max(0, effectiveWindow - used);
	return Math.round(Math.min(100, Math.max(0, (remaining / effectiveWindow) * 100)));
}

type MissingCostResolver = (message: AssistantMessage) => number | undefined;

export function usageTotals(entries: readonly any[], resolveMissingCost?: MissingCostResolver): UsageTotals {
	const totals: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		const usage = message.usage;
		if (!usage) continue;
		totals.input += Math.max(0, usage.input ?? 0);
		totals.output += Math.max(0, usage.output ?? 0);
		totals.cacheRead += Math.max(0, usage.cacheRead ?? 0);
		totals.cacheWrite += Math.max(0, usage.cacheWrite ?? 0);
		const recordedCost = Math.max(0, usage.cost?.total ?? 0);
		totals.cost += recordedCost > 0
			? recordedCost
			: Math.max(0, resolveMissingCost?.(message) ?? 0);
	}
	const sessionPrompt = totals.input + totals.cacheRead + totals.cacheWrite;
	totals.sessionCacheHit = sessionPrompt > 0
		? (totals.cacheRead / sessionPrompt) * 100
		: undefined;
	return totals;
}

function threadTitle(ctx: any): string {
	const name = ctx.sessionManager.getSessionName?.()?.trim();
	return name || ctx.sessionManager.getSessionId();
}

function terminalThreadTitle(ctx: any): string {
	const name = ctx.sessionManager.getSessionName?.()?.trim();
	return name || ctx.sessionManager.getSessionId().slice(0, 8);
}

function modelWithReasoning(ctx: any, thinkingLevel: string): string {
	const name = ctx.model?.name ?? ctx.model?.id ?? "no model";
	return `${name} ${thinkingLevel || "default"}`;
}

function rgb(text: string, color: readonly [number, number, number]): string {
	return `\u001b[38;2;${color[0]};${color[1]};${color[2]}m${text}\u001b[39m`;
}

function dim(text: string): string {
	return `\u001b[2m${text}\u001b[22m`;
}

function styleSegment(segment: StatusSegment, theme?: any): string {
	if (theme && typeof theme.fg === "function") {
		return theme.fg(FOOTER_THEME_TOKEN[segment.accent] as any, segment.text);
	}
	return rgb(segment.text, FOOTER_COLORS[segment.accent]);
}

function styledSegments(segments: StatusSegment[], separator = SEPARATOR, theme?: any): string {
	return segments.map((segment) => styleSegment(segment, theme)).join(dim(separator));
}

function renderSplitRow(left: string, right: string, width: number): string {
	const available = Math.max(0, width - visibleWidth(FOOTER_INDENT));
	if (!right) return `${FOOTER_INDENT}${truncateToWidth(left, available, "…")}`;

	const rightWidth = visibleWidth(right);
	const minimumGap = 3;
	if (!left || rightWidth + minimumGap >= available) {
		const fittedRight = truncateToWidth(right, available, "…");
		return `${FOOTER_INDENT}${" ".repeat(Math.max(0, available - visibleWidth(fittedRight)))}${fittedRight}`;
	}

	const fittedLeft = truncateToWidth(left, available - rightWidth - minimumGap, "…");
	const padding = Math.max(minimumGap, available - visibleWidth(fittedLeft) - rightWidth);
	return `${FOOTER_INDENT}${fittedLeft}${" ".repeat(padding)}${right}`;
}

function renderAdaptiveRow(groups: FooterGroup[], right: string, width: number, theme?: any): string {
	const available = Math.max(0, width - visibleWidth(FOOTER_INDENT));
	const rightWidth = visibleWidth(right);
	const minimumGap = right ? 3 : 0;
	const leftAvailable = rightWidth + minimumGap < available
		? available - rightWidth - minimumGap
		: 0;
	const active = groups
		.map((group, index) => ({ ...group, index, variantIndex: 0 }))
		.filter((group) => group.segments.length > 0 || (group.variants?.[0]?.length ?? 0) > 0);
	const currentSegments = (group: (typeof active)[number]) =>
		group.variants?.[group.variantIndex] ?? group.segments;
	const renderActive = () => active
		.map((group) => styledSegments(currentSegments(group), " ", theme))
		.join(dim(SEPARATOR));

	while (active.length > 1 && visibleWidth(renderActive()) > leftAvailable) {
		const removable = active
			.filter((group) => !group.required)
			.sort((a, b) => b.priority - a.priority || b.index - a.index)[0];
		const shrinkable = active
			.filter((group) => group.variants && group.variantIndex + 1 < group.variants.length)
			.sort((a, b) => b.priority - a.priority || b.index - a.index)[0];
		if (shrinkable && (!removable || shrinkable.priority >= removable.priority)) {
			shrinkable.variantIndex += 1;
			continue;
		}
		if (!removable) break;
		active.splice(active.indexOf(removable), 1);
	}

	return renderSplitRow(renderActive(), right, width);
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/ +/g, " ")
		.trim();
}

function extensionStatusAccent(key: string): StatusSegment["accent"] {
	if (key === "goal") return "thread";
	if (key === "plan") return "branch";
	return "usage";
}

export default function (pi: ExtensionAPI) {
	let activeCtx: any;
	let requestRender: (() => void) | undefined;
	// Extension action methods are unavailable while the module is loading.
	// Read the real level from `session_start`, after Pi initializes the runtime.
	let thinkingLevel = "default";
	let branchChangeSummary: BranchChanges | undefined;
	let gitLookupGeneration = 0;
	let agentActive = false;
	let titleFrame = 0;
	let titleTimer: ReturnType<typeof setInterval> | undefined;
	let cachedUsageSessionId: string | undefined;
	let cachedUsageTotals: UsageTotals | undefined;

	const invalidateUsageTotals = () => {
		cachedUsageSessionId = undefined;
		cachedUsageTotals = undefined;
	};

	const currentUsageTotals = (ctx: any): UsageTotals => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (cachedUsageTotals && cachedUsageSessionId === sessionId) return cachedUsageTotals;

		// Older messages may have zero cost because their custom model had no rates
		// configured when the response was recorded. Resolve each distinct model once
		// and calculate those missing values without mutating the session transcript.
		const resolvedModels = new Map<string, any | null>();
		cachedUsageTotals = usageTotals(ctx.sessionManager.getEntries(), (message) => {
			const provider = (message as any).provider;
			const modelId = (message as any).model;
			if (!provider || !modelId) return undefined;
			const key = `${provider}\u0000${modelId}`;
			if (!resolvedModels.has(key)) {
				resolvedModels.set(key, ctx.modelRegistry.find(provider, modelId) ?? null);
			}
			const model = resolvedModels.get(key);
			if (!model) return undefined;

			const usage = message.usage;
			const calculatedUsage = {
				...usage,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			return calculateCost(model, calculatedUsage as any).total;
		});
		cachedUsageSessionId = sessionId;
		return cachedUsageTotals;
	};

	const run = async (command: string, args: string[], cwd: string) => {
		try {
			const result = await pi.exec(command, args, { cwd, timeout: COMMAND_TIMEOUT_MS });
			return result.code === 0 ? result.stdout : undefined;
		} catch {
			return undefined;
		}
	};

	const git = (cwd: string, ...args: string[]) => run("git", args, cwd);

	const refExists = async (cwd: string, reference: string): Promise<boolean> =>
		(await git(cwd, "rev-parse", "--verify", "--quiet", reference)) !== undefined;

	const defaultBranchRef = async (cwd: string): Promise<string | undefined> => {
		const remoteOutput = await git(cwd, "remote");
		const remotes = (remoteOutput ?? "").split("\n").map((value) => value.trim()).filter(Boolean);
		const origin = remotes.indexOf("origin");
		if (origin > 0) remotes.unshift(remotes.splice(origin, 1)[0]);

		for (const remote of remotes) {
			const remoteHead = `refs/remotes/${remote}/HEAD`;
			const symbolic = (await git(cwd, "symbolic-ref", "--quiet", remoteHead))?.trim();
			if (symbolic && await refExists(cwd, symbolic)) return symbolic;

			const remoteShow = await git(cwd, "remote", "show", remote);
			const defaultName = remoteShow?.split("\n")
				.map((line) => line.trim())
				.find((line) => line.startsWith("HEAD branch:"))
				?.slice("HEAD branch:".length).trim();
			const remoteRef = defaultName ? `refs/remotes/${remote}/${defaultName}` : undefined;
			if (remoteRef && await refExists(cwd, remoteRef)) return remoteRef;
		}

		for (const local of ["refs/heads/main", "refs/heads/master"]) {
			if (await refExists(cwd, local)) return local;
		}
		return undefined;
	};

	const branchChanges = async (cwd: string): Promise<BranchChanges | undefined> => {
		if ((await git(cwd, "rev-parse", "--git-dir")) === undefined) return undefined;
		const baseRef = await defaultBranchRef(cwd);
		if (!baseRef) return undefined;
		const mergeBase = (await git(cwd, "merge-base", "HEAD", baseRef))?.trim();
		if (!mergeBase) return undefined;
		const numstat = await git(cwd, "diff", "--numstat", `${mergeBase}..HEAD`);
		if (numstat === undefined) return undefined;

		let additions = 0;
		let deletions = 0;
		for (const line of numstat.split("\n")) {
			const [added, deleted] = line.split("\t");
			additions += Number.parseInt(added, 10) || 0;
			deletions += Number.parseInt(deleted, 10) || 0;
		}
		return { additions, deletions };
	};

	const refreshGitSummary = async (ctx: any) => {
		const generation = ++gitLookupGeneration;
		const cwd = ctx.cwd;
		const changes = await branchChanges(cwd);
		if (generation !== gitLookupGeneration || activeCtx?.cwd !== cwd) return;
		branchChangeSummary = changes;
		requestRender?.();
	};

	const renderTitle = () => {
		if (!activeCtx) return;
		const title = truncateTitlePart(terminalThreadTitle(activeCtx), 48);
		const activity = TITLE_SPINNER_FRAMES[titleFrame] ?? TITLE_SPINNER_FRAMES[0];
		activeCtx.ui.setTitle(agentActive ? `${activity} ${title}` : title);
	};

	const stopTitleAnimation = () => {
		if (!titleTimer) return;
		clearInterval(titleTimer);
		titleTimer = undefined;
	};

	const startTitleAnimation = () => {
		stopTitleAnimation();
		titleFrame = 0;
		renderTitle();
		titleTimer = setInterval(() => {
			titleFrame = (titleFrame + 1) % TITLE_SPINNER_FRAMES.length;
			// setTitle writes OSC 0 directly; deliberately do not request a TUI render.
			renderTitle();
		}, TITLE_SPINNER_INTERVAL_MS);
		titleTimer.unref?.();
	};

	const updateActivity = (active: boolean) => {
		agentActive = active;
		if (active) startTitleAnimation();
		else {
			stopTitleAnimation();
			titleFrame = 0;
			renderTitle();
		}
		// Footer activity styling changes only at start/settle, not on spinner ticks.
		requestRender?.();
	};

	const install = (ctx: any) => {
		if (ctx.mode !== "tui") return;
		invalidateUsageTotals();
		activeCtx = ctx;
		thinkingLevel = pi.getThinkingLevel();
		renderTitle();
		void refreshGitSummary(ctx);

		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			requestRender = () => tui.requestRender();
			const onBranchChange = () => {
				requestRender?.();
				if (activeCtx) void refreshGitSummary(activeCtx);
			};
			const unsubscribe = footerData.onBranchChange(onBranchChange);
			return {
				dispose() {
					unsubscribe();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const current = activeCtx ?? ctx;
					const usage = current.getContextUsage?.();
					const contextWindow = usage?.contextWindow ?? current.model?.contextWindow ?? 0;
					const totals = currentUsageTotals(current);
					const branch = footerData.getGitBranch();
					let branchText = branch && branch !== "detached" ? branch : "";
					if (branchText && branchChangeSummary) {
						branchText += branchChangeSummary.additions === 0 && branchChangeSummary.deletions === 0
							? " clean"
							: ` +${branchChangeSummary.additions} -${branchChangeSummary.deletions}`;
					}

					const hasCache = totals.cacheRead > 0 || totals.cacheWrite > 0;
					const inputLabel = `↓ ${formatTokensCompact(totals.input)}`;
					const fullCacheDetails: string[] = [];
					if (totals.cacheRead > 0) fullCacheDetails.push(`${formatTokensCompact(totals.cacheRead)} cached`);
					if (totals.cacheWrite > 0) fullCacheDetails.push(`${formatTokensCompact(totals.cacheWrite)} written`);
					if (hasCache && totals.sessionCacheHit !== undefined) fullCacheDetails.push(`${totals.sessionCacheHit.toFixed(0)}% avg`);
					const inputCacheVariants: StatusSegment[][] = totals.input > 0 || hasCache
						? [
							[{ accent: "usage", text: fullCacheDetails.length > 0 ? `${inputLabel} (${fullCacheDetails.join(" ")})` : inputLabel }],
							[{ accent: "usage", text: hasCache && totals.sessionCacheHit !== undefined
								? `${inputLabel} (${formatTokensCompact(totals.cacheRead)} cached ${totals.sessionCacheHit.toFixed(0)}% avg)`
								: inputLabel }],
							[{ accent: "usage", text: hasCache && totals.sessionCacheHit !== undefined
								? `${inputLabel} (${totals.sessionCacheHit.toFixed(0)}% avg)`
								: inputLabel }],
						]
						: [];

					const groups: FooterGroup[] = [
						{ segments: [{ accent: "thread", text: threadTitle(current) }], priority: 0, required: true },
						{ segments: [{ accent: "path", text: formatDirectory(current.cwd) }], priority: 8 },
						{ segments: branchText ? [{ accent: "branch", text: branchText }] : [], priority: 6 },
						{ segments: [{ accent: "model", text: modelWithReasoning(current, thinkingLevel) }], priority: 7 },
						{
							segments: contextWindow > 0
								? [{ accent: "usage", text: `ctx ${contextRemainingPercent(usage?.tokens, contextWindow)}%/${formatTokensCompact(contextWindow)}` }]
								: [],
							priority: 1,
						},
						{
							segments: inputCacheVariants[0] ?? [],
							variants: inputCacheVariants,
							priority: 3,
						},
						{
							segments: totals.output > 0 ? [{ accent: "usage", text: `↑ ${formatTokensCompact(totals.output)}` }] : [],
							priority: 4,
						},
						{
							segments: totals.cost > 0 ? [{ accent: "thread", text: formatCostCents(totals.cost) }] : [],
							priority: 2,
						},
					];

					const statusPriority = new Map([["goal", 1], ["plan", 2]]);
					const statuses = [...footerData.getExtensionStatuses().entries()]
						.sort(([left], [right]) =>
							(statusPriority.get(left) ?? 100) - (statusPriority.get(right) ?? 100)
							|| left.localeCompare(right),
						)
						.map(([key, text]) => ({
							accent: extensionStatusAccent(key),
							text: sanitizeStatusText(text),
						}))
						.filter((segment) => segment.text.length > 0);
					const statusLine = styledSegments(statuses, SEPARATOR, theme);
					return [renderAdaptiveRow(groups, statusLine, width, theme)];
				},
			};
		});
	};

	pi.on("session_start", (_event, ctx) => {
		install(ctx);
	});
	pi.on("session_info_changed", (_event, ctx) => {
		activeCtx = ctx;
		renderTitle();
		requestRender?.();
	});
	pi.on("model_select", (_event, ctx) => {
		activeCtx = ctx;
		requestRender?.();
	});
	pi.on("thinking_level_select", (event, ctx) => {
		activeCtx = ctx;
		thinkingLevel = event.level;
		requestRender?.();
	});
	pi.on("agent_start", (_event, ctx) => {
		activeCtx = ctx;
		updateActivity(true);
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		invalidateUsageTotals();
	});
	pi.on("agent_settled", (_event, ctx) => {
		activeCtx = ctx;
		invalidateUsageTotals();
		updateActivity(false);
	});
	pi.on("session_compact", () => invalidateUsageTotals());
	pi.on("session_tree", () => {
		invalidateUsageTotals();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		gitLookupGeneration += 1;
		stopTitleAnimation();
		agentActive = false;
		titleFrame = 0;
		requestRender = undefined;
		activeCtx = undefined;
		invalidateUsageTotals();
		ctx.ui.setFooter(undefined);
		ctx.ui.setTitle("pi");
	});
}
