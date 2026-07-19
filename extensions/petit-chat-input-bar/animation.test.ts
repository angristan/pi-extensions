import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseAnimationMode, pickRandomDelay } from "./animation";
import { CHAT_HEIGHT, CHAT_WIDTH, getPetitChatPose, PETIT_CHAT_POSES } from "./frames";

test("parses all animation modes and status", () => {
	expect(parseAnimationMode("")).toBe("status");
	expect(parseAnimationMode("SMART")).toBe("smart");
	expect(parseAnimationMode("working")).toBe("working");
	expect(parseAnimationMode("always")).toBe("always");
	expect(parseAnimationMode("static")).toBe("static");
	expect(parseAnimationMode("nope")).toBeUndefined();
});

test("picks delays inside the inclusive range", () => {
	const range = { min: 12_000, max: 30_000 };
	expect(pickRandomDelay(range, () => 0)).toBe(12_000);
	expect(pickRandomDelay(range, () => 1)).toBe(30_000);
});

test("keeps every pose inside the overlay bounds", () => {
	for (const pose of PETIT_CHAT_POSES) {
		expect(pose).toHaveLength(CHAT_HEIGHT);
		for (const line of pose) expect(visibleWidth(line)).toBe(CHAT_WIDTH);
	}
	expect(getPetitChatPose(-1)).toHaveLength(CHAT_HEIGHT);
});
