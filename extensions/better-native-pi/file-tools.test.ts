import { beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { DETAILS_KEY } from "../image-store/index.js";
import { EXPLORATION_DETAILS_KEY, resetExplorationStateForTests } from "./exploration.js";
import fileTools, { assertSafeRecursiveSearchRoot } from "./file-tools.js";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
};

beforeEach(() => resetExplorationStateForTests());

test("write results identify diffs that already show the complete file", async () => {
	const tools = new Map<string, any>();
	fileTools({
		on() {},
		registerTool(tool: any) { tools.set(tool.name, tool); },
	} as any);
	const directory = await mkdtemp(join(tmpdir(), "better-native-pi-write-"));
	const write = tools.get("write");

	try {
		const created = await write.execute(
			"write-create",
			{ reasoning: "create fixture", path: "fixture.ts", content: "export const value = 1;\n" },
			undefined,
			undefined,
			{ cwd: directory },
		);
		expect(created.details.diffCoversFullContent).toBe(true);

		const overwritten = await write.execute(
			"write-overwrite",
			{ reasoning: "update fixture", path: "fixture.ts", content: "export const value = 2;\n" },
			undefined,
			undefined,
			{ cwd: directory },
		);
		expect(overwritten.details.diffCoversFullContent).toBe(false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("grep and find reject the home directory before execution", async () => {
	const tools = new Map<string, any>();
	fileTools({
		on() {},
		registerTool(tool: any) { tools.set(tool.name, tool); },
	} as any);

	for (const name of ["grep", "find"] as const) {
		const args = name === "grep"
			? { reasoning: "search broadly", pattern: "needle", path: homedir() }
			: { reasoning: "find broadly", pattern: "*.ts", path: homedir() };
		await expect(tools.get(name).execute(
			`${name}-home`,
			args,
			undefined,
			undefined,
			{ cwd: tmpdir() },
		)).rejects.toThrow(`Refusing ${name} search at broad root`);
	}
});

test("recursive search guard blocks aliases and cloud-storage roots", async () => {
	const directory = await mkdtemp(join(tmpdir(), "better-native-pi-search-guard-"));
	const fakeHome = join(directory, "home");
	const homeAlias = join(directory, "home-alias");
	await mkdir(fakeHome);
	await symlink(fakeHome, homeAlias, "dir");

	try {
		const options = { homeDir: fakeHome, protectMacOSCloudRoots: true };
		for (const unsafePath of [
			"~",
			dirname(fakeHome),
			join(fakeHome, "Library"),
			join(fakeHome, "Library", "CloudStorage"),
			homeAlias,
		]) {
			await expect(assertSafeRecursiveSearchRoot(
				"grep",
				unsafePath,
				directory,
				options,
			)).rejects.toThrow("prevent mass downloads");
		}

		await expect(assertSafeRecursiveSearchRoot(
			"grep",
			join(fakeHome, "projects", "specific-repo"),
			directory,
			options,
		)).resolves.toBeUndefined();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

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
