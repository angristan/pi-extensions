import { expect, test } from "bun:test";
import {
	contextRemainingPercent,
	FOOTER_GROUP_PRIORITY,
	formatCostCents,
	formatTokensCompact,
	renderAdaptiveRow,
	truncateTitlePart,
	usageTotals,
} from "./index";

test("formats compact footer values without misleading zeroes", () => {
	expect(formatTokensCompact(999)).toBe("999");
	expect(formatTokensCompact(1_250)).toBe("1.25K");
	expect(formatTokensCompact(12_500_000)).toBe("12.5M");
	expect(formatCostCents(0.001)).toBe("<$0.01");
	expect(formatCostCents(1.236)).toBe("$1.24");
	expect(truncateTitlePart("abcdef", 5)).toBe("ab...");
});

test("computes context usage after the reserved baseline", () => {
	expect(contextRemainingPercent(12_000, 112_000)).toBe(0);
	expect(contextRemainingPercent(62_000, 112_000)).toBe(50);
	expect(contextRemainingPercent(999_000, 112_000)).toBe(100);
});

test("hides cache details, git, then directory as space narrows", () => {
	const segment = (accent: "thread" | "path" | "branch" | "model" | "usage", text: string) => ({ accent, text });
	const groups: Parameters<typeof renderAdaptiveRow>[0] = [
		{ segments: [segment("thread", "thread")], priority: FOOTER_GROUP_PRIORITY.thread, required: true },
		{ segments: [segment("path", "directory")], priority: FOOTER_GROUP_PRIORITY.path },
		{ segments: [segment("branch", "git")], priority: FOOTER_GROUP_PRIORITY.git },
		{ segments: [segment("model", "model")], priority: FOOTER_GROUP_PRIORITY.model },
		{
			segments: [segment("usage", "input"), segment("branch", "cache")],
			variants: [
				[segment("usage", "input"), segment("branch", "cache")],
				[segment("usage", "input")],
			],
			priority: FOOTER_GROUP_PRIORITY.input,
			variantPriority: FOOTER_GROUP_PRIORITY.cache,
		},
	];
	const plain = (width: number) => renderAdaptiveRow(groups, "", width)
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

	expect(plain(46)).toContain("directory │ git │ model │ input");
	expect(plain(46)).not.toContain("cache");
	expect(plain(40)).toContain("directory │ model │ input");
	expect(plain(40)).not.toContain("git");
	expect(plain(34)).toContain("thread │ model │ input");
	expect(plain(34)).not.toContain("directory");
});

test("aggregates assistant usage and resolves missing historical costs", () => {
	const entries = [
		{ type: "message", message: { role: "user", usage: { input: 999 } } },
		{ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 30, cacheWrite: 0, cost: { total: 0 } } } },
		{ type: "message", message: { role: "assistant", usage: { input: 20, output: 7, cacheRead: 0, cacheWrite: 10, cost: { total: 0.25 } } } },
	];
	const totals = usageTotals(entries, () => 0.1);

	expect(totals).toMatchObject({ input: 30, output: 12, cacheRead: 30, cacheWrite: 10, cost: 0.35 });
	expect(totals.sessionCacheHit).toBeCloseTo(42.857, 2);
});
