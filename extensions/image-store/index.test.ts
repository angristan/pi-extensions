import { afterEach, describe, expect, test } from "bun:test";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import imageStoreExtension, {
	ContentAddressedImageStore,
	externalizeContent,
	markerFor,
	refsFromText,
	rehydrateMessages,
	renderStoredImagePreviews,
} from "./index";

const temporaryDirectories: string[] = [];
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-image-store-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("content-addressed storage", () => {
	test("replaces image payloads with stable references and deduplicates blobs", async () => {
		const directory = await temporaryDirectory();
		const store = new ContentAddressedImageStore(directory);
		const data = Buffer.from("small png fixture").toString("base64");
		const image = { type: "image" as const, data, mimeType: "image/png" };

		const first = await externalizeContent([image], store);
		const second = await externalizeContent([image], store);

		expect(first.refs).toEqual(second.refs);
		expect(JSON.stringify(first.content)).not.toContain(data);
		expect(first.content).toEqual([{ type: "text", text: markerFor(first.refs[0]!) }]);
		expect(await readFile(store.pathFor(first.refs[0]!))).toEqual(Buffer.from("small png fixture"));
		const shardFiles = await readdir(join(store.root, first.refs[0]!.digest.slice(0, 2)));
		expect(shardFiles).toHaveLength(1);
	});

	test("rehydrates references only in the temporary model context", async () => {
		const directory = await temporaryDirectory();
		const store = new ContentAddressedImageStore(directory);
		const data = Buffer.from("context image").toString("base64");
		const { content, refs } = await externalizeContent([
			{ type: "text", text: "before " },
			{ type: "image", data, mimeType: "image/webp" },
			{ type: "text", text: " after" },
		], store);
		const persisted = { role: "toolResult", content };

		const [rehydrated] = await rehydrateMessages([persisted], store);

		expect(persisted.content).not.toEqual(rehydrated.content);
		expect(rehydrated.content).toEqual([
			{ type: "text", text: "before " },
			{ type: "image", data, mimeType: "image/webp" },
			{ type: "text", text: " after" },
		]);
		expect(refsFromText(JSON.stringify(persisted))).toEqual(refs);
	});

	test("keeps missing sidecars as readable references", async () => {
		const directory = await temporaryDirectory();
		const store = new ContentAddressedImageStore(directory);
		const ref = { digest: "a".repeat(64), mimeType: "image/png", bytes: 42 };
		const marker = markerFor(ref);

		const [message] = await rehydrateMessages([{ role: "user", content: `look\n\n${marker}` }], store);

		expect(message.content).toEqual([
			{ type: "text", text: "look\n\n" },
			{ type: "text", text: `${marker} (sidecar unavailable)` },
		]);
	});
});

describe("extension hooks", () => {
	test("externalizes tool images, renders an immediate preview, and restores provider context", async () => {
		const directory = await temporaryDirectory();
		process.env.PI_CODING_AGENT_DIR = directory;
		const handlers = new Map<string, (...args: any[]) => any>();
		const pi = {
			on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
			appendEntry() {},
			registerEntryRenderer() {},
			registerCommand() {},
		};
		imageStoreExtension(pi as any);
		await handlers.get("session_start")?.({}, {});
		await handlers.get("agent_start")?.({}, {});
		const data = Buffer.from("tool image").toString("base64");
		const result = await handlers.get("tool_result")?.({
			content: [{ type: "image", data, mimeType: "image/png" }],
			input: { path: "screenshot.png" },
		}, { ui: { notify() {} } });

		expect(JSON.stringify(result)).not.toContain(data);

		const context = await handlers.get("context")?.({
			messages: [{ role: "toolResult", content: result.content, details: result.details }],
		});
		expect(context.messages[0].content).toEqual([
			{ type: "text", text: "[image stored externally]" },
			{ type: "image", data, mimeType: "image/png" },
		]);

		const stored = new ContentAddressedImageStore(directory);
		const theme = { fg: (_color: string, text: string) => text };
		const live = renderStoredImagePreviews(result.details, stored, theme, false);
		expect(live).toBeDefined();
		const previousCapabilities = getCapabilities();
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			expect(live!.render(100).join("\n")).toContain("\x1b_G");
		} finally {
			setCapabilities(previousCapabilities);
		}

		await handlers.get("session_start")?.({}, {});
		stored.clearCache();
		await rm(stored.pathFor(result.details.__pi_image_store.refs[0]), { force: true });
		const collapsed = renderStoredImagePreviews(result.details, stored, theme, false);
		const expanded = renderStoredImagePreviews(result.details, stored, theme, true);
		expect(collapsed!.render(100)).toEqual([]);
		expect(expanded!.render(100).join("\n")).toContain("sidecar unavailable");
	});

	test("keeps immediate images from the current and previous visible runs", async () => {
		const directory = await temporaryDirectory();
		process.env.PI_CODING_AGENT_DIR = directory;
		const handlers = new Map<string, (...args: any[]) => any>();
		const pi = {
			on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
			appendEntry() {},
			registerEntryRenderer() {},
			registerCommand() {},
		};
		imageStoreExtension(pi as any);
		await handlers.get("session_start")?.({}, {});
		const store = new ContentAddressedImageStore(directory);
		const theme = { fg: (_color: string, text: string) => text };
		const render = (result: any) => renderStoredImagePreviews(result.details, store, theme, false)!.render(100);
		const addImage = (label: string) => handlers.get("tool_result")?.({
			content: [{ type: "image", data: Buffer.from(label).toString("base64"), mimeType: "image/png" }],
			input: { path: `${label}.png` },
		}, { ui: { notify() {} } });
		const previousCapabilities = getCapabilities();
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		try {
			await handlers.get("agent_start")?.({}, {});
			const first = await addImage("first");
			await handlers.get("agent_start")?.({}, {}); // retry: same visible run
			await handlers.get("agent_settled")?.({}, {});

			await handlers.get("agent_start")?.({}, {});
			const second = await addImage("second");
			expect(render(first).join("\n")).toContain("[Image");
			expect(render(second).join("\n")).toContain("[Image");
			await handlers.get("agent_settled")?.({}, {});

			await handlers.get("agent_start")?.({}, {});
			const third = await addImage("third");
			expect(render(first)).toEqual([]);
			expect(render(second).join("\n")).toContain("[Image");
			expect(render(third).join("\n")).toContain("[Image");
		} finally {
			setCapabilities(previousCapabilities);
			await handlers.get("session_shutdown")?.({}, {});
		}
	});

	test("externalizes pasted images without retaining base64", async () => {
		const directory = await temporaryDirectory();
		process.env.PI_CODING_AGENT_DIR = directory;
		const handlers = new Map<string, (...args: any[]) => any>();
		const sent: any[] = [];
		const pi = {
			on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
			appendEntry() {},
			sendMessage(message: any) { sent.push(message); },
			registerEntryRenderer() {},
			registerCommand() {},
		};
		imageStoreExtension(pi as any);
		const data = Buffer.from("pasted image").toString("base64");
		const result = await handlers.get("input")?.({
			text: "inspect this",
			images: [{ type: "image", data, mimeType: "image/jpeg" }],
		}, { ui: { notify() {} } });

		expect(result.action).toBe("transform");
		expect(result.text).toBe("inspect this");
		expect(result.images).toBeUndefined();
		expect(sent).toHaveLength(1);
		expect(JSON.stringify(sent)).not.toContain(data);
		const context = await handlers.get("context")?.({
			messages: [{ role: "custom", content: sent[0].content, details: sent[0].details }],
		});
		expect(context.messages[0].content).toEqual([
			{ type: "text", text: "Attached image sidecar." },
			{ type: "image", data, mimeType: "image/jpeg" },
		]);
	});

	test("garbage collection removes only confirmed unreferenced blobs", async () => {
		const directory = await temporaryDirectory();
		process.env.PI_CODING_AGENT_DIR = directory;
		const store = new ContentAddressedImageStore(directory);
		const kept = await store.put({
			type: "image",
			data: Buffer.from("kept").toString("base64"),
			mimeType: "image/png",
		});
		const unused = await store.put({
			type: "image",
			data: Buffer.from("unused").toString("base64"),
			mimeType: "image/png",
		});
		const sessionDirectory = join(directory, "sessions", "project");
		await mkdir(sessionDirectory, { recursive: true });
		await writeFile(join(sessionDirectory, "session.jsonl"), `${JSON.stringify({ details: { ref: kept } })}\n`);

		let command: ((args: string, ctx: any) => Promise<void>) | undefined;
		const notifications: string[] = [];
		const pi = {
			on() {},
			appendEntry() {},
			registerEntryRenderer() {},
			registerCommand(_name: string, options: any) { command = options.handler; },
		};
		imageStoreExtension(pi as any);
		await command?.("gc", {
			hasUI: true,
			ui: {
				confirm: async () => true,
				notify: (message: string) => notifications.push(message),
			},
		});

		expect(await readFile(store.pathFor(kept), "utf8")).toBe("kept");
		expect(readFile(store.pathFor(unused))).rejects.toThrow();
		expect(notifications.at(-1)).toContain("1 unreferenced sidecar");
	});
});
