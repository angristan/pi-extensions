import { beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("ambiguous edits show original line context without writing any replacements", async () => {
	const tools = new Map<string, any>();
	fileTools({ on() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
	const directory = await mkdtemp(join(tmpdir(), "better-native-pi-edit-"));
	const path = join(directory, "fixture.ts");
	const original = '\ufeffconst title = "original";\r\n\r\nfunction first() {\r\n  return value;\r\n}\r\n\r\nfunction second() {\r\n  return value;\r\n}\r\n';
	await writeFile(path, original);
	const edit = (edits: any[]) => tools.get("edit").execute(
		"edit-fixture", { reasoning: "update fixture", path, edits }, undefined, undefined, { cwd: directory },
	);
	const titleEdit = { oldText: 'const title = "original";', newText: 'const title = "changed";' };
	try {
		const failed = edit([titleEdit, { oldText: "  return value;\r\n}", newText: "  return nextValue;\r\n}" }]);
		await expect(failed).rejects.toThrow("edits[1]");
		await expect(failed).rejects.toThrow("3: function first() {");
		await expect(failed).rejects.toThrow("7: function second() {");
		expect(await readFile(path, "utf8")).toBe(original);

		await edit([titleEdit, {
			oldText: "function second() {\n  return value;\n}",
			newText: "function second() {\n  return nextValue;\n}",
		}]);
		expect(await readFile(path, "utf8")).toBe(original
			.replace('title = "original"', 'title = "changed"')
			.replace("function second() {\r\n  return value;", "function second() {\r\n  return nextValue;"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("ambiguous edit context limits locations and long lines", async () => {
	const tools = new Map<string, any>();
	fileTools({ on() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
	const directory = await mkdtemp(join(tmpdir(), "better-native-pi-edit-bounded-"));
	const path = join(directory, "fixture.ts");
	const content = Array.from({ length: 20 }, () => `${"x".repeat(1000)}\nneedle\nnext\n`).join("");
	await writeFile(path, content);
	try {
		let message = "";
		try {
			await tools.get("edit").execute("ambiguous", {
				reasoning: "update repeated line", path, edits: [{ oldText: "needle", newText: "replacement" }],
			}, undefined, undefined, { cwd: directory });
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("Found 20 occurrences");
		expect(message).toContain("1: ");
		expect(message).toContain("8: needle");
		expect(message).not.toContain("11: needle");
		expect(message.length).toBeLessThan(2500);
		expect(await readFile(path, "utf8")).toBe(content);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("normalized ambiguity asks for a fresh read when no exact locations exist", async () => {
	const tools = new Map<string, any>();
	fileTools({ on() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
	const directory = await mkdtemp(join(tmpdir(), "better-native-pi-edit-normalized-"));
	const path = join(directory, "fixture.ts");
	const content = 'const first = “hello”;\nconst second = “hello”;\n';
	await writeFile(path, content);
	try {
		const failed = tools.get("edit").execute("normalized", {
			reasoning: "update repeated string", path, edits: [{ oldText: '"hello"', newText: '"world"' }],
		}, undefined, undefined, { cwd: directory });
		await expect(failed).rejects.toThrow("Found 2 occurrences");
		await expect(failed).rejects.toThrow("Read the current file");
		expect(await readFile(path, "utf8")).toBe(content);
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
