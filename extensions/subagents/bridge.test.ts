import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_AGENT_ID_ENV, BRIDGE_SOCKET_ENV, BRIDGE_TOKEN_ENV, registerChildBridge } from "./bridge";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

function nextRecord(socket: Socket): () => Promise<any> {
	let buffer = "";
	const queue: any[] = [];
	const waiters: Array<(value: any) => void> = [];
	socket.on("data", (chunk) => {
		buffer += chunk.toString();
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const record = JSON.parse(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			const waiter = waiters.shift();
			if (waiter) waiter(record);
			else queue.push(record);
		}
	});
	return () => queue.length > 0
		? Promise.resolve(queue.shift())
		: new Promise((resolve) => waiters.push(resolve));
}

async function listeningServer(path: string): Promise<{ server: Server; connection: Promise<Socket> }> {
	let resolveConnection!: (socket: Socket) => void;
	const connection = new Promise<Socket>((resolve) => { resolveConnection = resolve; });
	const server = net.createServer(resolveConnection);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => resolve());
	});
	return { server, connection };
}

describe("visible child bridge", () => {
	test("authenticates, forwards lifecycle events, and accepts parent commands", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-subagent-bridge-test-"));
		const socketPath = join(directory, "bridge.sock");
		const { server, connection } = await listeningServer(socketPath);
		const handlers = new Map<string, (...args: any[]) => void>();
		const userMessages: Array<{ message: string; options: any }> = [];
		let aborts = 0;
		let shutdowns = 0;
		let idle = true;
		const pi = {
			on(name: string, handler: (...args: any[]) => void) { handlers.set(name, handler); },
			sendUserMessage(message: string, options?: any) { userMessages.push({ message, options }); },
		};
		const env = {
			[BRIDGE_SOCKET_ENV]: socketPath,
			[BRIDGE_TOKEN_ENV]: "secret",
			[BRIDGE_AGENT_ID_ENV]: "reviewer-1",
		};
		expect(registerChildBridge(pi as any, { env })).toBe(true);
		const ctx = {
			isIdle: () => idle,
			abort() { aborts += 1; },
			shutdown() { shutdowns += 1; },
		};
		handlers.get("session_start")?.({}, ctx);
		const socket = await connection;
		const readRecord = nextRecord(socket);
		cleanup.push(async () => {
			socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		});

		expect(await readRecord()).toEqual({ type: "hello", token: "secret", agentId: "reviewer-1" });
		socket.write(`${JSON.stringify({ type: "prompt", id: "one", message: "Inspect this" })}\n`);
		expect(await readRecord()).toMatchObject({ type: "response", id: "one", command: "prompt", success: true });
		expect(userMessages).toEqual([{ message: "Inspect this", options: undefined }]);

		idle = false;
		socket.write(`${JSON.stringify({ type: "steer", id: "two", message: "Check errors" })}\n`);
		expect(await readRecord()).toMatchObject({ type: "response", id: "two", success: true });
		expect(userMessages.at(-1)).toEqual({ message: "Check errors", options: { deliverAs: "steer" } });

		handlers.get("tool_execution_start")?.({ toolCallId: "call-1", toolName: "read", args: { path: "index.ts" } }, ctx);
		expect(await readRecord()).toEqual({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "index.ts" } });
		handlers.get("message_end")?.({ message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }, ctx);
		expect(await readRecord()).toMatchObject({ type: "message_end", message: { role: "assistant" } });
		handlers.get("agent_settled")?.({}, ctx);
		expect(await readRecord()).toEqual({ type: "agent_settled" });

		socket.write(`${JSON.stringify({ type: "abort", id: "three" })}\n`);
		expect(await readRecord()).toMatchObject({ id: "three", success: true });
		expect(aborts).toBe(1);
		socket.write(`${JSON.stringify({ type: "shutdown", id: "four" })}\n`);
		expect(await readRecord()).toMatchObject({ id: "four", success: true });
		await Bun.sleep(0);
		expect(shutdowns).toBe(1);
	});

	test("stops the child when its authenticated parent disappears", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-subagent-bridge-orphan-test-"));
		const socketPath = join(directory, "bridge.sock");
		const { server, connection } = await listeningServer(socketPath);
		const handlers = new Map<string, (...args: any[]) => void>();
		let aborts = 0;
		let shutdowns = 0;
		const pi = {
			on(name: string, handler: (...args: any[]) => void) { handlers.set(name, handler); },
			sendUserMessage() {},
		};
		registerChildBridge(pi as any, {
			env: {
				[BRIDGE_SOCKET_ENV]: socketPath,
				[BRIDGE_TOKEN_ENV]: "secret",
				[BRIDGE_AGENT_ID_ENV]: "orphan",
			},
		});
		handlers.get("session_start")?.({}, {
			isIdle: () => false,
			abort() { aborts += 1; },
			shutdown() { shutdowns += 1; },
		});
		const socket = await connection;
		const readRecord = nextRecord(socket);
		expect(await readRecord()).toMatchObject({ type: "hello", agentId: "orphan" });
		socket.destroy();
		for (let attempt = 0; attempt < 50 && aborts === 0; attempt += 1) await Bun.sleep(1);
		expect(aborts).toBe(1);
		expect(shutdowns).toBe(1);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});

	test("stays disabled without an explicit parent socket", () => {
		expect(registerChildBridge({ on() {} } as any, { env: {} })).toBe(false);
	});
});
