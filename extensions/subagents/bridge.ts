import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import net, { type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

export const BRIDGE_SOCKET_ENV = "PI_SUBAGENT_BRIDGE_SOCKET";
export const BRIDGE_TOKEN_ENV = "PI_SUBAGENT_BRIDGE_TOKEN";
export const BRIDGE_AGENT_ID_ENV = "PI_SUBAGENT_PARENT_ID";

const MAX_RECORD_BYTES = 2 * 1024 * 1024;

interface BridgeCommand {
	type: "get_state" | "prompt" | "steer" | "abort" | "shutdown";
	id: string;
	message?: string;
}

interface ChildBridgeDependencies {
	env?: NodeJS.ProcessEnv;
	connect?: (path: string) => Socket;
}

function writeRecord(socket: Pick<Socket, "write" | "destroyed"> | undefined, value: unknown): void {
	if (!socket || socket.destroyed) return;
	socket.write(`${JSON.stringify(value)}\n`);
}

/**
 * Connect a visible child TUI to its parent. Herdr remains presentation-only:
 * lifecycle events and control messages use this authenticated local channel.
 */
export function registerChildBridge(pi: ExtensionAPI, dependencies: ChildBridgeDependencies = {}): boolean {
	const env = dependencies.env ?? process.env;
	const socketPath = env[BRIDGE_SOCKET_ENV];
	const token = env[BRIDGE_TOKEN_ENV];
	const agentId = env[BRIDGE_AGENT_ID_ENV];
	if (!socketPath || !token || !agentId) return false;

	const connect = dependencies.connect ?? ((path: string) => net.createConnection(path));
	let socket: Socket | undefined;
	let activeContext: any;
	let shuttingDown = false;
	let buffer = "";
	const decoder = new StringDecoder("utf8");

	const respond = (command: BridgeCommand, success: boolean, error?: unknown) => {
		writeRecord(socket, {
			type: "response",
			id: command.id,
			command: command.type,
			success,
			...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
		});
	};

	const handleCommand = (command: BridgeCommand) => {
		if (!command || typeof command !== "object" || typeof command.id !== "string") return;
		try {
			if (!activeContext) throw new Error("Child session is not ready");
			switch (command.type) {
				case "get_state":
					respond(command, true);
					return;
				case "prompt":
					if (typeof command.message !== "string" || !command.message.trim()) throw new Error("prompt requires a message");
					if (!activeContext.isIdle()) throw new Error("Child agent is already running");
					pi.sendUserMessage(command.message);
					respond(command, true);
					return;
				case "steer":
					if (typeof command.message !== "string" || !command.message.trim()) throw new Error("steer requires a message");
					pi.sendUserMessage(command.message, activeContext.isIdle() ? undefined : { deliverAs: "steer" });
					respond(command, true);
					return;
				case "abort":
					activeContext.abort();
					respond(command, true);
					return;
				case "shutdown":
					shuttingDown = true;
					respond(command, true);
					queueMicrotask(() => activeContext?.shutdown());
					return;
				default:
					throw new Error(`Unknown child bridge command: ${(command as any).type}`);
			}
		} catch (error) {
			respond(command, false, error);
		}
	};

	const handleData = (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		if (Buffer.byteLength(buffer) > MAX_RECORD_BYTES) {
			socket?.destroy(new Error("Child bridge command exceeded the size limit"));
			return;
		}
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			try { handleCommand(JSON.parse(line)); }
			catch { /* Ignore malformed records from the private local socket. */ }
		}
	};

	const emit = (event: Record<string, unknown>) => writeRecord(socket, event);

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		shuttingDown = false;
		buffer = "";
		socket = connect(socketPath);
		socket.setNoDelay?.(true);
		socket.on("connect", () => {
			writeRecord(socket, { type: "hello", token, agentId });
		});
		socket.on("data", handleData);
		socket.on("error", () => { /* The close handler owns orphan cleanup. */ });
		socket.on("close", () => {
			socket = undefined;
			if (shuttingDown || !activeContext) return;
			// A parent crash must not leave an untracked model process running in a
			// visible pane. Abort current work before requesting graceful teardown.
			shuttingDown = true;
			activeContext.abort();
			activeContext.shutdown();
		});
	});
	pi.on("agent_start", () => emit({ type: "agent_start" }));
	pi.on("message_end", (event) => {
		if (event.message?.role === "assistant") emit({ type: "message_end", message: event.message });
	});
	pi.on("tool_execution_start", (event) => emit({
		type: "tool_execution_start",
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		args: event.args,
	}));
	pi.on("tool_execution_end", (event) => emit({
		type: "tool_execution_end",
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		isError: event.isError,
	}));
	pi.on("agent_settled", () => emit({ type: "agent_settled" }));
	pi.on("session_shutdown", () => {
		shuttingDown = true;
		emit({ type: "session_shutdown" });
		activeContext = undefined;
		socket?.end();
		socket = undefined;
	});
	return true;
}
