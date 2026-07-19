const REQUEST_TIMEOUT_MS = 15_000;
const LONG_POLL_TIMEOUT_SECONDS = 20;
const LONG_POLL_REQUEST_TIMEOUT_MS = 25_000;

export interface TelegramCredentials {
	botToken: string;
	chatId: string;
}

export interface TelegramQuestion {
	options: string[];
	allowOther: boolean;
}

export interface SentTelegramQuestion {
	chatId: string;
	messageId: number;
}

interface TelegramMessage {
	message_id?: unknown;
	text?: unknown;
	chat?: { id?: unknown };
	reply_to_message?: { message_id?: unknown };
}

interface TelegramUpdate {
	update_id?: unknown;
	message?: TelegramMessage;
	callback_query?: {
		id?: unknown;
		data?: unknown;
		message?: TelegramMessage;
	};
}

function sanitizedDescription(description: string, botToken: string): string {
	return description.replaceAll(botToken, "[redacted]").replace(/\s+/g, " ").slice(0, 180);
}

async function telegramRequest<T>(
	credentials: TelegramCredentials,
	method: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
	if (!/^[^/?#\s]+$/.test(credentials.botToken)) throw new Error("Telegram bot token has an invalid format.");
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	let response: Response;
	try {
		response = await fetchImpl(`https://api.telegram.org/bot${credentials.botToken}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: requestSignal,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		const name = error instanceof Error ? error.name : "";
		throw new Error(name === "TimeoutError" || timeoutSignal.aborted
			? "Telegram API request timed out."
			: "Telegram API network request failed.");
	}

	let payload: { ok?: unknown; result?: unknown; description?: unknown } | undefined;
	try {
		payload = await response.json() as { ok?: unknown; result?: unknown; description?: unknown };
	} catch {
		// HTTP status still provides a useful bounded error below.
	}
	if (!response.ok || payload?.ok !== true) {
		const description = typeof payload?.description === "string"
			? `: ${sanitizedDescription(payload.description, credentials.botToken)}`
			: "";
		throw new Error(`Telegram API request failed (HTTP ${response.status})${description}`);
	}
	return payload.result as T;
}

export async function sendTelegramMessage(
	credentials: TelegramCredentials,
	text: string,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	await telegramRequest(credentials, "sendMessage", { chat_id: credentials.chatId, text }, signal, fetchImpl);
}

function buttonLabel(option: string): string {
	const normalized = option.replace(/\s+/g, " ").trim();
	return normalized.length > 80 ? `${normalized.slice(0, 79)}…` : normalized;
}

export async function sendTelegramQuestion(
	credentials: TelegramCredentials,
	text: string,
	question: TelegramQuestion,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<SentTelegramQuestion> {
	const replyMarkup = question.options.length > 0
		? {
			inline_keyboard: question.options.map((option, index) => [{
				text: buttonLabel(option),
				callback_data: `option:${index}`,
			}]),
		}
		: {
			force_reply: true,
			selective: true,
			input_field_placeholder: "Type your answer",
		};
	const result = await telegramRequest<TelegramMessage>(credentials, "sendMessage", {
		chat_id: credentials.chatId,
		text,
		reply_markup: replyMarkup,
	}, signal, fetchImpl);
	if (!Number.isInteger(result?.message_id) || !result?.chat || result.chat.id === undefined) {
		throw new Error("Telegram API returned an invalid sent message.");
	}
	return { chatId: String(result.chat.id), messageId: result.message_id as number };
}

function chatMatches(message: TelegramMessage | undefined, sent: SentTelegramQuestion): boolean {
	return Boolean(message?.chat && String(message.chat.id) === sent.chatId && message.message_id === sent.messageId);
}

function replyMatches(message: TelegramMessage | undefined, sent: SentTelegramQuestion): boolean {
	return Boolean(
		message?.chat
		&& String(message.chat.id) === sent.chatId
		&& message.reply_to_message?.message_id === sent.messageId,
	);
}

async function acknowledgeCallback(
	credentials: TelegramCredentials,
	callbackQueryId: string,
	text: string,
	signal: AbortSignal,
	fetchImpl: typeof fetch,
): Promise<void> {
	try {
		await telegramRequest(credentials, "answerCallbackQuery", {
			callback_query_id: callbackQueryId,
			text,
		}, signal, fetchImpl);
	} catch (error) {
		if (signal.aborted) throw error;
		// The answer is still usable if Telegram fails to dismiss the button spinner.
	}
}

export async function waitForTelegramAnswer(
	credentials: TelegramCredentials,
	sent: SentTelegramQuestion,
	question: TelegramQuestion,
	signal: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	let offset: number | undefined;
	while (!signal.aborted) {
		const updates = await telegramRequest<TelegramUpdate[]>(credentials, "getUpdates", {
			...(offset === undefined ? {} : { offset }),
			timeout: LONG_POLL_TIMEOUT_SECONDS,
			allowed_updates: ["message", "callback_query"],
		}, signal, fetchImpl, LONG_POLL_REQUEST_TIMEOUT_MS);
		if (!Array.isArray(updates)) throw new Error("Telegram API returned invalid updates.");

		for (const update of updates) {
			if (Number.isInteger(update.update_id)) offset = Math.max(offset ?? 0, (update.update_id as number) + 1);
			const callback = update.callback_query;
			if (callback && chatMatches(callback.message, sent) && typeof callback.id === "string") {
				const match = typeof callback.data === "string" ? /^option:(\d+)$/.exec(callback.data) : undefined;
				const optionIndex = match ? Number(match[1]) : -1;
				const option = Number.isInteger(optionIndex) ? question.options[optionIndex] : undefined;
				if (option !== undefined) {
					await acknowledgeCallback(credentials, callback.id, `Selected: ${buttonLabel(option)}`, signal, fetchImpl);
					return option;
				}
				await acknowledgeCallback(credentials, callback.id, "This option is no longer available.", signal, fetchImpl);
			}

			const message = update.message;
			if (!replyMatches(message, sent) || typeof message?.text !== "string") continue;
			const answer = message.text.trim();
			if (!answer || answer.length > 4_000) continue;
			if (question.options.length > 0 && !question.allowOther) continue;
			return answer;
		}
	}
	throw signal.reason ?? new Error("Telegram answer polling was cancelled.");
}

export async function dismissTelegramQuestion(
	credentials: TelegramCredentials,
	sent: SentTelegramQuestion,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	await telegramRequest(credentials, "editMessageReplyMarkup", {
		chat_id: sent.chatId,
		message_id: sent.messageId,
		reply_markup: { inline_keyboard: [] },
	}, undefined, fetchImpl);
}
