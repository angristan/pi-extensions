import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import net from "node:net";

interface HerdrRequest {
	id: string;
	method: "tab.rename";
	params: {
		tab_id: string;
		label: string;
	};
}

interface RuntimeDependencies {
	env?: NodeJS.ProcessEnv;
	sendRequest?: (request: HerdrRequest) => Promise<void>;
}

function createSocketSender(socketEndpoint: string): (request: HerdrRequest) => Promise<void> {
	const sendAttempt = (request: HerdrRequest, timeoutMs: number): Promise<boolean> =>
		new Promise((resolve) => {
			let finished = false;
			let response = "";
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const socket = net.createConnection(socketEndpoint);

			const finish = (delivered: boolean) => {
				if (finished) return;
				finished = true;
				if (timeout) clearTimeout(timeout);
				socket.destroy();
				resolve(delivered);
			};

			socket.on("error", () => finish(false));
			socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
			socket.on("data", (chunk) => {
				response += chunk.toString();
				const newline = response.indexOf("\n");
				if (newline < 0) return;
				try {
					const parsed = JSON.parse(response.slice(0, newline));
					finish(!parsed?.error);
				} catch {
					finish(false);
				}
			});
			socket.on("end", () => finish(false));
			timeout = setTimeout(() => finish(false), timeoutMs);
			timeout.unref?.();
		});

	return async (request) => {
		if (await sendAttempt(request, 500)) return;
		await sendAttempt(request, 1500);
	};
}

/** Mirror Pi session names into the containing Herdr tab. */
export default function herdrTabTitle(pi: ExtensionAPI, deps: RuntimeDependencies = {}) {
	const env = deps.env ?? process.env;
	const socketPath = env.HERDR_SOCKET_PATH;
	const tabId = env.HERDR_TAB_ID;
	if (env.HERDR_ENV !== "1" || !socketPath || !tabId) return;

	const socketEndpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
	const sendRequest = deps.sendRequest ?? createSocketSender(socketEndpoint);
	let requestSequence = 0;

	const renameTab = async (rawTitle: unknown) => {
		const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
		if (!title) return;

		requestSequence += 1;
		await sendRequest({
			id: `pi-session-title:${requestSequence}`,
			method: "tab.rename",
			params: {
				tab_id: tabId,
				label: title,
			},
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		await renameTab(pi.getSessionName());
	});

	pi.on("session_info_changed", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		await renameTab(event.name);
	});
}
