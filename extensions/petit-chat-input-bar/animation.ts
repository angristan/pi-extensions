export type AnimationMode = "smart" | "working" | "always" | "static";

export interface DelayRange {
	readonly min: number;
	readonly max: number;
}

export const FRAME_DURATION_MS = 160;
export const SMART_IDLE_DELAY_MS: DelayRange = { min: 12_000, max: 30_000 };
export const SMART_WORKING_DELAY_MS: DelayRange = { min: 1_500, max: 4_000 };

export function pickRandomDelay(range: DelayRange, random: () => number = Math.random): number {
	const sample = Math.max(0, Math.min(0.999_999_999, random()));
	return Math.floor(range.min + sample * (range.max - range.min + 1));
}

export function parseAnimationMode(input: string): AnimationMode | "status" | undefined {
	const command = input.trim().toLowerCase();
	if (!command || command === "status") return "status";
	if (command === "smart" || command === "working" || command === "always" || command === "static") {
		return command;
	}
	return undefined;
}
