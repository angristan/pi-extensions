import { describe, expect, test } from "bun:test";
import {
	decideInteraction,
	resolveDiscordQuestion,
	sendDiscordEmbed,
	sendDiscordMessage,
	sendDiscordQuestion,
	waitForDiscordAnswer,
	type DiscordCredentials,
	type DiscordGateway,
	type DiscordWaiter,
	type SentDiscordQuestion,
} from "./bot-api";

const credentials: DiscordCredentials = {
	botToken: "test-token",
	channelId: "111",
};

function jsonResponse(result: unknown, status = 200): Response {
	return new Response(JSON.stringify(result), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function pathFromUrl(url: string | URL | Request): string {
	const raw = String(url);
	return raw.includes("/api/v10") ? raw.slice(raw.indexOf("/api/v10")).slice("/api/v10".length) : raw;
}

class FakeGateway implements DiscordGateway {
	waiters: DiscordWaiter[] = [];

	subscribe(waiter: DiscordWaiter): void {
		this.waiters.push(waiter);
	}

	unsubscribe(waiter: DiscordWaiter): void {
		this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
	}

	async dispatch(interaction: unknown, channelId = credentials.channelId): Promise<void> {
		const message = (interaction as { message?: { id?: unknown; channel_id?: unknown } })?.message;
		if (!message || typeof message.id !== "string") return;
		for (const waiter of [...this.waiters]) {
			if (waiter.messageId !== message.id || waiter.channelId !== channelId) continue;
			const keep = await waiter.handle(interaction);
			if (!keep) this.unsubscribe(waiter);
		}
	}
}

describe("Discord question messages", () => {
	test("renders choice questions as component buttons", async () => {
		let body: any;
		const sent = await sendDiscordQuestion(credentials, { color: 1, title: "Choose" }, {
			options: ["staging", "production"],
			allowOther: false,
		}, undefined, async (url, init) => {
			body = JSON.parse(String(init?.body));
			return mockResponse({ id: "42", channel_id: "111" });
		});

		expect(sent).toEqual({ channelId: "111", messageId: "42" });
		expect(String(body.components?.[0]?.components?.[0]?.custom_id)).toBe("option:0");
		expect(body.components[0].components.map((button: any) => button.label)).toEqual(["staging", "production"]);
		expect(body.allowed_mentions).toEqual({ parse: [] });
	});

	test("adds a free-text button when free text is allowed", async () => {
		let body: any;
		await sendDiscordQuestion(credentials, { color: 1, title: "Choose" }, {
			options: ["staging", "production"],
			allowOther: true,
		}, undefined, async (url, init) => {
			body = JSON.parse(String(init?.body));
			return mockResponse({ id: "43", channel_id: credentials.channelId });
		});

		const labels = (body.components ?? []).map((row: { components: Array<{ label: string }> }) => row.components.map((button) => button.label));
		expect(labels).toEqual([["staging", "production"], ["Type another answer"]]);
	});

	test("renders free-text-only questions as a single reply button", async () => {
		let body: any;
		await sendDiscordQuestion(credentials, { color: 1, title: "Explain" }, {
			options: [],
			allowOther: true,
		}, undefined, async (url, init) => {
			body = JSON.parse(String(init?.body));
			return mockResponse({ id: "44", channel_id: "111" });
		});

		expect(body.components?.[0]?.components?.[0]?.custom_id).toBe("open");
		expect(body.components?.[0]?.components?.[0]?.label).toBe("Reply");
	});

	test("sends plain text messages without pinging anyone", async () => {
		let body: any;
		await sendDiscordMessage(credentials, "Test message", undefined, async (url, init) => {
			body = JSON.parse(String(init?.body));
			return mockResponse({ id: "45" });
		});

		expect(body).toEqual({ content: "Test message", allowed_mentions: { parse: [] } });
	});

	test("returns the sent identity for passive embeds", async () => {
		const sent = await sendDiscordEmbed(credentials, { color: 9, title: "Secret", description: "wait" }, undefined, async (url, init) => {
			return mockResponse({ id: "46", channel_id: "999" });
		});

		expect(sent).toEqual({ channelId: "999", messageId: "46" });
	});

	test("edits resolved messages and removes their components", async () => {
		let method = "";
		let body: any;
		const sent: SentDiscordQuestion = { channelId: "111", messageId: "42" };
		await resolveDiscordQuestion(credentials, sent, { color: 2, title: "Answered" }, async (url, init) => {
			method = pathFromUrl(url);
			body = JSON.parse(String(init?.body));
			return mockResponse(true);
		});

		expect(method).toBe("/channels/111/messages/42");
		expect(body).toMatchObject({ embeds: [{ color: 2, title: "Answered" }], components: [] });
	});

	test("reports bounded API errors without exposing the token", async () => {
		const promise = sendDiscordMessage(credentials, "Hi", undefined, async () =>
			new Response(JSON.stringify({ message: `bad token ${credentials.botToken}`, code: 0 }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			}));

		await expect(promise).rejects.toThrow("Discord API request failed (HTTP 401)");
		await expect(promise).rejects.not.toThrow(credentials.botToken);
	});
});

describe("Discord interaction decisions", () => {
	const question = { options: ["staging", "production"], allowOther: false };

	function interaction(type: number, overrides: Record<string, unknown> = {}): unknown {
		return {
			id: "i1",
			token: "t1",
			type,
			data: { custom_id: "option:1", ...overrides },
			message: { id: "42", channel_id: "111" },
		};
	}

	test("maps an option button to its exact option", () => {
		expect(decideInteraction(interaction(3), question)).toEqual({ kind: "answer", value: "production" });
	});

	test("flags an out-of-range option as invalid", () => {
		expect(decideInteraction(interaction(3, { custom_id: "option:9" }), question)).toEqual({ kind: "invalid" });
	});

	test("a reply button requests the free-text modal", () => {
		expect(decideInteraction(interaction(3, { custom_id: "open" }), question)).toEqual({ kind: "open-modal" });
	});

	test("extracts the submitted text from a modal", () => {
		const modal = interaction(4, {
			custom_id: "pi_answer",
			components: [{ type: 1, components: [{ type: 4, custom_id: "answer", value: "  my answer  " }] }],
		});
		expect(decideInteraction(modal, question)).toEqual({ kind: "answer", value: "my answer" });
	});

	test("ignores unrelated interactions", () => {
		expect(decideInteraction(interaction(3, { custom_id: "other" }), question)).toEqual({ kind: "invalid" });
		expect(decideInteraction(null, question)).toEqual({ kind: "invalid" });
	});
});

describe("Discord answer polling through the gateway", () => {
	const sent: SentDiscordQuestion = { channelId: "111", messageId: "42" };

	function interaction(type: number, customId = "option:1", value?: string): Record<string, unknown> {
		return {
			id: "i1",
			token: "tk1",
			type,
			data: customId === "option:1" && value === undefined
				? { custom_id: customId }
				: (type === 4
					? { custom_id: "pi_answer", components: [{ type: 1, components: [{ type: 4, custom_id: "answer", value }] }] }
					: { custom_id: customId }),
			message: { id: "42", channel_id: "111" },
		};
	}

	function answerFetch() {
		return async (url: string | URL | Request, init?: RequestInit) => {
			expect(pathFromUrl(url)).toMatch(/^\/interactions\/i1\/tk1\/callback$/);
			return mockResponse(JSON.parse(String(init?.body ?? "null")));
		};
	}

	test("resolves when an option button for the sent message is pressed", async () => {
		const gateway = new FakeGateway();
		const promise = waitForDiscordAnswer(credentials, sent, { options: ["staging", "production"], allowOther: false }, new AbortController().signal, gateway, answerFetch());
		await Promise.resolve();
		await gateway.dispatch(interaction(3, "option:1"));

		expect(await promise).toBe("production");
		expect(gateway.waiters).toHaveLength(0);
	});

	test("opens a modal for free text and resolves on submit", async () => {
		const gateway = new FakeGateway();
		const payloads: unknown[] = [];
		const promise = waitForDiscordAnswer(credentials, sent, { options: [], allowOther: true }, new AbortController().signal, gateway, async (url, init) => {
			const body = JSON.parse(String(init?.body));
			payloads.push(body);
			return mockResponse(200);
		});
		await Promise.resolve();

		await gateway.dispatch(interaction(3, "open"));
		expect((await import("./bot-api")).decideInteraction).toBeDefined();
		expect(payloads).toEqual([{ type: 5, data: { custom_id: "pi_answer", title: "Answer in Discord", components: [{ type: 1, components: [{ type: 4, style: 1, custom_id: "answer", label: "Your answer", min_length: 1, max_length: 4_000, required: true }] }] } }]);

		await gateway.dispatch(interaction(4, undefined, "my answer"));
		expect(await promise).toBe("my answer");
		expect(payloads).toHaveLength(2);
	});

	test("ignores interactions for a different message", async () => {
		const gateway = new FakeGateway();
		const promise = waitForDiscordAnswer(credentials, sent, { options: ["staging", "production"], allowOther: false }, new AbortController().signal, gateway, answerFetch());
		await Promise.resolve();
		await gateway.dispatch({
			...interaction(3, "option:0"),
			message: { id: "other-message", channel_id: "111" },
		});

		expect(gateway.waiters).toHaveLength(1);
		expect((await Promise.race([promise, Promise.resolve("pending")])).valueOf()).toBe("pending");
	});

	test("cancels the waiter when the signal aborts", async () => {
		const gateway = new FakeGateway();
		const controller = new AbortController();
		const promise = waitForDiscordAnswer(credentials, sent, { options: ["a"], allowOther: false }, controller.signal, gateway, answerFetch());
		await Promise.resolve();

		controller.abort(new Error("Discord answer polling was cancelled."));
		expect(gateway.waiters).toHaveLength(0);
		await expect(promise).rejects.toThrow("Discord answer polling was cancelled.");
	});
});

function mockResponse(result: unknown): Response {
	return new Response(JSON.stringify({ id: "x", ...(typeof result === "object" && result !== null ? result : {}) }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}