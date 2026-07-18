import { beforeEach, expect, test } from "bun:test";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { DETAILS_KEY } from "../image-store/index.js";
import { EXPLORATION_DETAILS_KEY, resetExplorationStateForTests } from "./exploration.js";
import fileTools from "./file-tools.js";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
};

beforeEach(() => resetExplorationStateForTests());

test("grouped read results keep sidecar previews in the rendered row", () => {
	const tools = new Map<string, any>();
	fileTools({
		on() {},
		registerTool(tool: any) { tools.set(tool.name, tool); },
	} as any);
	const callId = "read-image-call";
	const digest = "a".repeat(64);
	const rendererState: any = {};
	const result = {
		content: [{ type: "text", text: "[image stored externally]" }],
		details: {
			[EXPLORATION_DETAILS_KEY]: {
				version: 2,
				groupId: "image-group",
				leaderId: callId,
				index: 0,
				toolCallId: callId,
				toolName: "read",
				activity: { verb: "Read", detail: "preview.png", path: "preview.png" },
				isError: false,
			},
			[DETAILS_KEY]: {
				version: 1,
				refs: [{ digest, mimeType: "image/png", bytes: 42 }],
			},
		},
	};

	const rendered = tools.get("read").renderResult(
		result,
		{ expanded: true, isPartial: false },
		theme,
		{
			toolCallId: callId,
			args: { path: "preview.png" },
			cwd: "/tmp",
			state: rendererState,
		},
	).render(100).join("\n");

	expect(rendered).toContain("Explored");
	expect(rendered).toContain("sidecar unavailable");

	// Pi recreates the result component when invalidate() is called. The
	// converted PNG must live in the row's renderer state, not the discarded
	// component instance.
	rendererState.imageStoreConversions.set(digest, {
		started: true,
		failed: false,
		converted: {
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			mimeType: "image/png",
		},
	});
	const previousCapabilities = getCapabilities();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	try {
		const rerendered = tools.get("read").renderResult(
			result,
			{ expanded: true, isPartial: false },
			theme,
			{
				toolCallId: callId,
				args: { path: "preview.png" },
				cwd: "/tmp",
				state: rendererState,
			},
		).render(100);
		expect(rerendered.some((line: string) => line.startsWith("\x1b_G"))).toBe(true);
	} finally {
		setCapabilities(previousCapabilities);
	}
});
