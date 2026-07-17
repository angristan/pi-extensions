import { expect, test } from "bun:test";
import autoCompactContinue from "./index";

test("queues a hidden follow-up after threshold compaction during an active run", () => {
	let handler: any;
	const sent: any[] = [];
	autoCompactContinue({
		on(name: string, callback: any) { if (name === "session_compact") handler = callback; },
		sendMessage(message: any, options: any) { sent.push({ message, options }); },
	} as any);

	handler({ reason: "threshold", willRetry: false }, { isIdle: () => false });

	expect(sent).toHaveLength(1);
	expect(sent[0].message).toMatchObject({ customType: "auto-compact-continue", display: false, details: { reason: "threshold" } });
	expect(sent[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
});

test("leaves manual, retrying, and idle compactions alone", () => {
	let handler: any;
	const sent: any[] = [];
	autoCompactContinue({
		on(_name: string, callback: any) { handler = callback; },
		sendMessage(...args: any[]) { sent.push(args); },
	} as any);

	handler({ reason: "manual", willRetry: false }, { isIdle: () => false });
	handler({ reason: "threshold", willRetry: true }, { isIdle: () => false });
	handler({ reason: "threshold", willRetry: false }, { isIdle: () => true });
	expect(sent).toHaveLength(0);
});
