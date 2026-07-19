import { describe, expect, test } from "bun:test";
import {
	sendTelegramQuestion,
	waitForTelegramAnswer,
	type SentTelegramQuestion,
	type TelegramCredentials,
} from "./bot-api";

const credentials: TelegramCredentials = {
	botToken: "123456:test-token",
	chatId: "987654321",
};

function telegramResponse(result: unknown): Response {
	return new Response(JSON.stringify({ ok: true, result }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function methodFromUrl(url: string | URL | Request): string {
	return String(url).split("/").pop()!;
}

describe("Telegram question messages", () => {
	test("renders choice questions as inline buttons", async () => {
		let body: any;
		const sent = await sendTelegramQuestion(credentials, "Choose a target", {
			options: ["staging", "production"],
			allowOther: false,
		}, undefined, async (_url, init) => {
			body = JSON.parse(String(init?.body));
			return telegramResponse({ message_id: 42, chat: { id: 987654321 } });
		});

		expect(sent).toEqual({ chatId: "987654321", messageId: 42 });
		expect(body.reply_markup).toEqual({
			inline_keyboard: [
				[{ text: "staging", callback_data: "option:0" }],
				[{ text: "production", callback_data: "option:1" }],
			],
		});
	});

	test("renders free-text questions with ForceReply", async () => {
		let body: any;
		await sendTelegramQuestion(credentials, "Explain why", {
			options: [],
			allowOther: true,
		}, undefined, async (_url, init) => {
			body = JSON.parse(String(init?.body));
			return telegramResponse({ message_id: 43, chat: { id: 987654321 } });
		});

		expect(body.reply_markup).toEqual({
			force_reply: true,
			selective: true,
			input_field_placeholder: "Type your answer",
		});
	});
});

describe("Telegram answer polling", () => {
	const sent: SentTelegramQuestion = { chatId: "987654321", messageId: 42 };

	test("maps a matching callback to the exact option and acknowledges it", async () => {
		const calls: Array<{ method: string; body: any }> = [];
		const answer = await waitForTelegramAnswer(credentials, sent, {
			options: ["staging", "production"],
			allowOther: false,
		}, new AbortController().signal, async (url, init) => {
			const method = methodFromUrl(url);
			calls.push({ method, body: JSON.parse(String(init?.body)) });
			if (method === "getUpdates") {
				return telegramResponse([
					{
						update_id: 99,
						message: { text: "unlisted", chat: { id: 987654321 }, reply_to_message: { message_id: 42 } },
					},
					{
						update_id: 100,
						callback_query: {
							id: "callback-1",
							data: "option:1",
							message: { message_id: 42, chat: { id: 987654321 } },
						},
					},
				]);
			}
			return telegramResponse(true);
		});

		expect(answer).toBe("production");
		expect(calls.map((call) => call.method)).toEqual(["getUpdates", "answerCallbackQuery"]);
		expect(calls[1]?.body).toEqual({ callback_query_id: "callback-1", text: "Selected: production" });
	});

	test("accepts only a reply to the matching bot message and chat", async () => {
		const answer = await waitForTelegramAnswer(credentials, sent, {
			options: [],
			allowOther: true,
		}, new AbortController().signal, async () => telegramResponse([
			{
				update_id: 101,
				message: { text: "wrong chat", chat: { id: 111 }, reply_to_message: { message_id: 42 } },
			},
			{
				update_id: 102,
				message: { text: "wrong message", chat: { id: 987654321 }, reply_to_message: { message_id: 41 } },
			},
			{
				update_id: 103,
				message: { text: "  the remote answer  ", chat: { id: 987654321 }, reply_to_message: { message_id: 42 } },
			},
		]));

		expect(answer).toBe("the remote answer");
	});

	test("carries the update offset into the next long poll", async () => {
		const bodies: any[] = [];
		let request = 0;
		const answer = await waitForTelegramAnswer(credentials, sent, {
			options: [],
			allowOther: true,
		}, new AbortController().signal, async (_url, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			request += 1;
			return request === 1
				? telegramResponse([{ update_id: 200, message: { text: "unrelated", chat: { id: 987654321 } } }])
				: telegramResponse([{
					update_id: 201,
					message: { text: "matched", chat: { id: 987654321 }, reply_to_message: { message_id: 42 } },
				}]);
		});

		expect(answer).toBe("matched");
		expect(bodies[0]).not.toHaveProperty("offset");
		expect(bodies[1]?.offset).toBe(201);
	});
});
