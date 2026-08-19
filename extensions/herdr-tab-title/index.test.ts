import { expect, test } from "bun:test";
import herdrTabTitle from "./index";

function createHarness(env: NodeJS.ProcessEnv) {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
	const requests: any[] = [];
	let sessionName: string | undefined = "Initial title";
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => Promise<void>) {
			handlers.set(name, handler);
		},
		getSessionName() {
			return sessionName;
		},
	};

	herdrTabTitle(pi as any, {
		env,
		sendRequest: async (request) => {
			requests.push(request);
		},
	});

	return {
		handlers,
		requests,
		setSessionName(name: string | undefined) {
			sessionName = name;
		},
	};
}

test("renames the Herdr tab from initial and changed Pi session names", async () => {
	const harness = createHarness({
		HERDR_ENV: "1",
		HERDR_SOCKET_PATH: "/tmp/herdr.sock",
		HERDR_TAB_ID: "wA:t2",
	});

	await harness.handlers.get("session_start")?.({}, { mode: "tui" });
	harness.setSessionName("Updated title");
	await harness.handlers.get("session_info_changed")?.({ name: "Updated title" }, { mode: "tui" });

	expect(harness.requests).toEqual([
		{
			id: "pi-session-title:1",
			method: "tab.rename",
			params: { tab_id: "wA:t2", label: "Initial title" },
		},
		{
			id: "pi-session-title:2",
			method: "tab.rename",
			params: { tab_id: "wA:t2", label: "Updated title" },
		},
	]);
});

test("does nothing outside a Herdr-managed TUI", async () => {
	const outside = createHarness({});
	expect(outside.handlers.size).toBe(0);

	const headless = createHarness({
		HERDR_ENV: "1",
		HERDR_SOCKET_PATH: "/tmp/herdr.sock",
		HERDR_TAB_ID: "wA:t2",
	});
	await headless.handlers.get("session_start")?.({}, { mode: "rpc" });
	await headless.handlers.get("session_info_changed")?.({ name: "Headless" }, { mode: "rpc" });
	await headless.handlers.get("session_info_changed")?.({ name: "   " }, { mode: "tui" });
	expect(headless.requests).toHaveLength(0);
});
