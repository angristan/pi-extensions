export const SUBAGENT_USAGE_ENTRY_TYPE = "subagent-usage";
export const SUBAGENT_USAGE_EVENT = "subagent:usage";

export interface PersistedSubagentUsage {
	version: 1;
	provider?: string;
	model?: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cacheWrite1h?: number;
		cost: number;
	};
}

function nonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function persistedSubagentUsage(message: any): PersistedSubagentUsage | undefined {
	const usage = message?.usage;
	if (!usage) return undefined;
	return {
		version: 1,
		provider: typeof message.provider === "string" ? message.provider : undefined,
		model: typeof message.model === "string" ? message.model : undefined,
		usage: {
			input: nonNegativeNumber(usage.input),
			output: nonNegativeNumber(usage.output),
			cacheRead: nonNegativeNumber(usage.cacheRead),
			cacheWrite: nonNegativeNumber(usage.cacheWrite),
			cacheWrite1h: nonNegativeNumber(usage.cacheWrite1h),
			cost: nonNegativeNumber(usage.cost?.total),
		},
	};
}

export function subagentUsageFromEntry(entry: any): PersistedSubagentUsage | undefined {
	if (entry?.type !== "custom" || entry.customType !== SUBAGENT_USAGE_ENTRY_TYPE) return undefined;
	const data = entry.data;
	if (data?.version !== 1 || !data.usage || typeof data.usage !== "object") return undefined;
	return {
		version: 1,
		provider: typeof data.provider === "string" ? data.provider : undefined,
		model: typeof data.model === "string" ? data.model : undefined,
		usage: {
			input: nonNegativeNumber(data.usage.input),
			output: nonNegativeNumber(data.usage.output),
			cacheRead: nonNegativeNumber(data.usage.cacheRead),
			cacheWrite: nonNegativeNumber(data.usage.cacheWrite),
			cacheWrite1h: nonNegativeNumber(data.usage.cacheWrite1h),
			cost: nonNegativeNumber(data.usage.cost),
		},
	};
}
