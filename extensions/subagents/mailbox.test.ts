import { describe, expect, test } from "bun:test";
import { AgentMailbox } from "./mailbox";

function message(agentId: string, content: string) {
	return {
		kind: "message" as const,
		agentId,
		agentName: agentId,
		content,
		createdAt: Date.now(),
	};
}

describe("subagent mailbox", () => {
	test("coalesces per-agent progress while preserving omission counts", () => {
		const mailbox = new AgentMailbox(64 * 1024, 1);
		mailbox.publish(message("api", "one"));
		mailbox.publish(message("api", "two"));
		mailbox.publish(message("api", "three"));
		mailbox.publish(message("api", "four"));

		expect(mailbox.peek().map((event) => event.content)).toEqual(["four"]);
		expect(mailbox.peek().at(-1)?.omittedBefore).toBe(3);
		expect(mailbox.snapshot().metrics.coalesced).toBe(3);
	});

	test("bounds aggregate message bytes without dropping final results", () => {
		const mailbox = new AgentMailbox<{ output: string }>(4 * 1024, 100);
		for (let index = 0; index < 8; index += 1) mailbox.publish(message(`agent-${index}`, "x".repeat(1_000)));
		mailbox.publish({
			kind: "final",
			agentId: "api",
			agentName: "api",
			content: "final",
			createdAt: Date.now(),
			status: "completed",
			final: { output: "important result" },
		});

		expect(mailbox.snapshot().messageBytes).toBeLessThanOrEqual(4 * 1024);
		expect(mailbox.peek((event) => event.kind === "final")).toHaveLength(1);
		expect(mailbox.snapshot().metrics.dropped).toBeGreaterThan(0);
	});

	test("tracks consumed, delivered, and recovered events", () => {
		const mailbox = new AgentMailbox(16 * 1024, 4);
		mailbox.restore({ ...message("restored", "saved"), recovered: true });
		mailbox.publish(message("live", "current"));
		mailbox.take((event) => event.agentId === "restored", "delivered");
		mailbox.take(() => true, "consumed");

		expect(mailbox.snapshot()).toMatchObject({
			unread: 0,
			metrics: { published: 2, delivered: 1, consumed: 1, recovered: 1 },
		});
	});
});
