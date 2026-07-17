import { expect, test } from "bun:test";
import {
	contextRemainingPercent,
	formatCostCents,
	formatTokensCompact,
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
