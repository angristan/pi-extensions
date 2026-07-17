import { describe, expect, test } from "bun:test";
import { shouldSendHeartbeat } from "./state";

describe("shouldSendHeartbeat", () => {
	test("allows the first heartbeat", () => {
		expect(shouldSendHeartbeat(undefined, 100)).toBe(true);
	});

	test("rate limits heartbeats for sixty seconds", () => {
		expect(shouldSendHeartbeat(100, 159)).toBe(false);
		expect(shouldSendHeartbeat(100, 160)).toBe(true);
	});

	test("allows a forced final heartbeat", () => {
		expect(shouldSendHeartbeat(100, 101, true)).toBe(true);
	});
});
