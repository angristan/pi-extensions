const REQUEST_TIMEOUT_MS = 15_000;
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_GATEWAY_URL = "wss://gateway.discord.com/?v=10&encoding=json";
const MAX_BUTTONS_PER_ROW = 5;
const MAX_ACTION_ROWS = 5;
const OPTION_CUSTOM_ID_PREFIX = "option:";
const REPLY_CUSTOM_ID = "open";
const MODAL_CUSTOM_ID = "pi_answer";
const TEXT_INPUT_CUSTOM_ID = "answer";
const MAX_TEXT_ANSWER_LENGTH = 4_000;

export interface DiscordCredentials {
	botToken: string;
	channelId: string;
}

export interface DiscordQuestion {
	options: string[];
	allowOther: boolean;
}

export interface DiscordEmbed {
	color: number;
	title: string;
	description?: string;
}

export interface SentDiscordQuestion {
	channelId: string;
	messageId: string;
}

interface DiscordButton {
	type: 2;
	style: 1 | 2;
	custom_id: string;
	label: string;
}

interface DiscordMessageResult {
	id?: unknown;
	channel_id?: unknown;
}

interface InteractionData {
	custom_id?: unknown;
	components?: unknown;
}

interface DiscordInteraction {
	id?: unknown;
	token?: unknown;
	type?: unknown;
	data?: InteractionData;
	message?: { id?: unknown; channel_id?: unknown };
}

function sanitizedDescription(description: string, botToken: string): string {
	return description.replaceAll(botToken, "[redacted]").replace(/\s+/g, " ").slice(0, 180);
}

async function discordRequest(
	credentials: DiscordCredentials,
	method: string,
	path: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
	if (!/^[^/?#\s]+$/.test(credentials.botToken)) throw new Error("Discord bot token has an invalid format.");
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	let response: Response;
	try {
		response = await fetchImpl(`${DISCORD_API_BASE}${path}`, {
			method,
			headers: {
				"Authorization": `Bot ${credentials.botToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		const name = error instanceof Error ? error.name : "";
		throw new Error(name === "TimeoutError" || timeoutSignal.aborted
			? "Discord API request timed out."
			: "Discord API network request failed.");
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		// HTTP status still provides a useful bounded error below.
	}
	if (!response.ok) {
		const description = typeof payload === "object" && payload !== null
			? sanitizedDescription(JSON.stringify(payload), credentials.botToken)
			: "";
		throw new Error(`Discord API request failed (HTTP ${response.status})${description ? `: ${description}` : ""}`);
	}
	return payload;
}

function sentFromMessage(result: unknown, credentials: DiscordCredentials): SentDiscordQuestion {
	const message = result as DiscordMessageResult;
	if (typeof message?.id !== "string" || !message.id) throw new Error("Discord API returned an invalid sent message.");
	return {
		channelId: typeof message.channel_id === "string" ? message.channel_id : credentials.channelId,
		messageId: message.id,
	};
}

export async function sendDiscordMessage(
	credentials: DiscordCredentials,
	text: string,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	await discordRequest(credentials, "POST", `/channels/${credentials.channelId}/messages`, {
		content: text,
		allowed_mentions: { parse: [] },
	}, signal, fetchImpl);
}

export async function sendDiscordEmbed(
	credentials: DiscordCredentials,
	embed: DiscordEmbed,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<SentDiscordQuestion> {
	const result = await discordRequest(credentials, "POST", `/channels/${credentials.channelId}/messages`, {
		embeds: [embed],
		components: [],
		allowed_mentions: { parse: [] },
	}, signal, fetchImpl);
	return sentFromMessage(result, credentials);
}

function buttonLabel(option: string): string {
	const normalized = option.replace(/\s+/g, " ").trim();
	const characters = [...normalized];
	return characters.length > 80 ? `${characters.slice(0, 79).join("")}…` : normalized;
}

function optionButton(index: number, label: string): DiscordButton {
	return { type: 2, style: 1, custom_id: `${OPTION_CUSTOM_ID_PREFIX}${index}`, label: buttonLabel(label) };
}

function replyButton(label: string): DiscordButton {
	return { type: 2, style: 2, custom_id: REPLY_CUSTOM_ID, label };
}

function componentsFromQuestion(question: DiscordQuestion): Array<{ type: 1; components: DiscordButton[] }> {
	const rows: Array<{ type: 1; components: DiscordButton[] }> = [];
	if (question.options.length === 0) {
		rows.push({ type: 1, components: [replyButton("Reply")] });
		return rows;
	}
	const capped = question.options.slice(0, MAX_BUTTONS_PER_ROW * MAX_ACTION_ROWS);
	for (let index = 0; index < capped.length; index += MAX_BUTTONS_PER_ROW) {
		const buttons = capped.slice(index, index + MAX_BUTTONS_PER_ROW).map((label, offset) => optionButton(index + offset, label));
		rows.push({ type: 1, components: buttons });
	}
	if (question.allowOther) {
		if (rows.length < MAX_ACTION_ROWS) {
			rows.push({ type: 1, components: [replyButton("Type another answer")] });
		} else {
			// Discord allows at most five action rows; make room by replacing the last option.
			const lastRow = rows[rows.length - 1]!;
			lastRow.components.pop();
			lastRow.components.push(replyButton("Type another answer"));
		}
	}
	return rows;
}

export async function sendDiscordQuestion(
	credentials: DiscordCredentials,
	embed: DiscordEmbed,
	question: DiscordQuestion,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<SentDiscordQuestion> {
	const result = await discordRequest(credentials, "POST", `/channels/${credentials.channelId}/messages`, {
		embeds: [embed],
		components: componentsFromQuestion(question),
		allowed_mentions: { parse: [] },
	}, signal, fetchImpl);
	return sentFromMessage(result, credentials);
}

export async function resolveDiscordQuestion(
	credentials: DiscordCredentials,
	sent: SentDiscordQuestion,
	embed: DiscordEmbed,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	await discordRequest(credentials, "PATCH", `/channels/${sent.channelId}/messages/${sent.messageId}`, {
		embeds: [embed],
		components: [],
		allowed_mentions: { parse: [] },
	}, undefined, fetchImpl);
}

async function replyToInteraction(
	credentials: DiscordCredentials,
	interaction: DiscordInteraction,
	payload: Record<string, unknown>,
	signal: AbortSignal,
	fetchImpl: typeof fetch,
): Promise<void> {
	if (typeof interaction.id !== "string" || typeof interaction.token !== "string") return;
	await discordRequest(credentials, "POST", `/interactions/${interaction.id}/${interaction.token}/callback`, payload, signal, fetchImpl);
}

function extractModalText(components: unknown): string | undefined {
	if (!Array.isArray(components)) return undefined;
	for (const row of components) {
		if (!row || typeof row !== "object") continue;
		const inner = (row as { components?: unknown }).components;
		if (!Array.isArray(inner)) continue;
		for (const input of inner) {
			if (!input || typeof input !== "object") continue;
			const candidate = input as { type?: unknown; custom_id?: unknown; value?: unknown };
			if (candidate.type === 4 && candidate.custom_id === TEXT_INPUT_CUSTOM_ID && typeof candidate.value === "string") {
				return candidate.value;
			}
		}
	}
	return undefined;
}

export type InteractionDecision =
	| { kind: "answer"; value: string }
	| { kind: "open-modal" }
	| { kind: "invalid" };

export function decideInteraction(interaction: unknown, question: DiscordQuestion): InteractionDecision {
	if (!interaction || typeof interaction !== "object") return { kind: "invalid" };
	const value = interaction as DiscordInteraction;
	const type = value.type;
	const customId = typeof value.data?.custom_id === "string" ? value.data.custom_id : "";
	if (type === 3 && customId === REPLY_CUSTOM_ID) return { kind: "open-modal" };
	if (type === 3 && customId.startsWith(OPTION_CUSTOM_ID_PREFIX)) {
		const index = Number(customId.slice(OPTION_CUSTOM_ID_PREFIX.length));
		const option = Number.isInteger(index) ? question.options[index] : undefined;
		return option !== undefined ? { kind: "answer", value: option } : { kind: "invalid" };
	}
	if (type === 4) {
		const text = extractModalText(value.data?.components);
		const answer = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
		if (answer && answer.length <= MAX_TEXT_ANSWER_LENGTH) return { kind: "answer", value: answer };
		return { kind: "invalid" };
	}
	return { kind: "invalid" };
}

function modalPayload(): Record<string, unknown> {
	return {
		type: 5,
		data: {
			custom_id: MODAL_CUSTOM_ID,
			title: "Answer in Discord",
			components: [{
				type: 1,
				components: [{
					type: 4,
					style: 1,
					custom_id: TEXT_INPUT_CUSTOM_ID,
					label: "Your answer",
					min_length: 1,
					max_length: MAX_TEXT_ANSWER_LENGTH,
					required: true,
				}],
			}],
		},
	};
}

export interface DiscordWaiter {
	channelId: string;
	messageId: string;
	handle(interaction: unknown): Promise<boolean>;
}

export interface DiscordGateway {
	subscribe(waiter: DiscordWaiter): void;
	unsubscribe(waiter: DiscordWaiter): void;
}

type WebSocketFactory = (url: string) => WebSocket;

function defaultWebSocketFactory(url: string): WebSocket {
	return new WebSocket(url);
}

class GatewayClient implements DiscordGateway {
	private readonly waiters = new Set<DiscordWaiter>();
	private socket: WebSocket | undefined;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly credentials: DiscordCredentials,
		private readonly webSocketFactory: WebSocketFactory,
	) {}

	subscribe(waiter: DiscordWaiter): void {
		this.waiters.add(waiter);
		this.connect();
	}

	unsubscribe(waiter: DiscordWaiter): void {
		this.waiters.delete(waiter);
		if (this.waiters.size === 0) this.closeSocket();
	}

	private connect(): void {
		if (this.socket) return;
		let socket: WebSocket;
		try {
			socket = this.webSocketFactory(DISCORD_GATEWAY_URL);
		} catch {
			return; // Retried on the next interaction attempt; errors surface per waiter.
		}
		this.socket = socket;
		socket.addEventListener("open", () => {});
		socket.addEventListener("message", (event) => {
			let payload: { op?: unknown; t?: unknown; d?: unknown } | undefined;
			try {
				payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
			} catch {
				return;
			}
			if (payload.op === 10) {
				const interval = Math.trunc((payload.d as { heartbeat_interval?: unknown })?.heartbeat_interval as number) || 41_250;
				this.heartbeatTimer = setInterval(() => socket.send(JSON.stringify({ op: 1, d: null })), interval);
				socket.send(JSON.stringify({
					op: 2,
					d: { token: this.credentials.botToken, intents: 0, properties: { os: "pi", browser: "pi", device: "pi" } },
				}));
			} else if (payload.op === 1) {
				socket.send(JSON.stringify({ op: 1, d: null }));
			} else if (payload.op === 0 && payload.t === "INTERACTION_CREATE") {
				void this.dispatch(payload.d);
			}
		});
		socket.addEventListener("close", () => this.onSocketClosed(socket));
		socket.addEventListener("error", () => {});
	}

	private async dispatch(interaction: unknown): Promise<void> {
		const message = (interaction as DiscordInteraction)?.message;
		if (!message || typeof message.id !== "string" || typeof message.channel_id !== "string") return;
		for (const waiter of [...this.waiters]) {
			if (waiter.messageId !== message.id || waiter.channelId !== message.channel_id) continue;
			const keepListening = await waiter.handle(interaction);
			if (!keepListening) this.waiters.delete(waiter);
		}
	}

	private onSocketClosed(socket: WebSocket): void {
		if (this.socket !== socket) return;
		this.socket = undefined;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		if (this.waiters.size > 0) this.connect();
	}

	private closeSocket(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		const socket = this.socket;
		this.socket = undefined;
		socket?.close();
	}
}

const sharedGateways = new Map<string, GatewayClient>();

function gatewayFor(credentials: DiscordCredentials, webSocketFactory?: WebSocketFactory): DiscordGateway {
	const key = `${credentials.botToken}\u0000${credentials.channelId}`;
	let gateway = sharedGateways.get(key);
	if (!gateway) {
		gateway = new GatewayClient(credentials, webSocketFactory ?? defaultWebSocketFactory);
		sharedGateways.set(key, gateway);
	}
	return gateway;
}

export async function waitForDiscordAnswer(
	credentials: DiscordCredentials,
	sent: SentDiscordQuestion,
	question: DiscordQuestion,
	signal: AbortSignal,
	gateway: DiscordGateway = gatewayFor(credentials),
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const waiter: DiscordWaiter = {
			channelId: sent.channelId,
			messageId: sent.messageId,
			handle: async (interaction) => {
				const decision = decideInteraction(interaction, question);
				if (decision.kind === "open-modal") {
					await replyToInteraction(credentials, interaction as DiscordInteraction, modalPayload(), signal, fetchImpl).catch(() => {});
					return true;
				}
				if (decision.kind === "invalid") {
					await replyToInteraction(credentials, interaction as DiscordInteraction, { type: 6, data: {} }, signal, fetchImpl).catch(() => {});
					return true;
				}
				await replyToInteraction(credentials, interaction as DiscordInteraction, { type: 6, data: {} }, signal, fetchImpl).catch(() => {});
				resolve(decision.value);
				return false;
			},
		};
		gateway.subscribe(waiter);
		signal.addEventListener("abort", () => {
			gateway.unsubscribe(waiter);
			reject(signal.reason ?? new Error("Discord answer polling was cancelled."));
		}, { once: true });
	});
}
