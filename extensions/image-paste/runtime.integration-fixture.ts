import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, type TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { Editor, setCapabilities, setCellDimensions, type Component } from "@earendil-works/pi-tui";
import extension, { ENTRY_TYPE } from "./index.ts";
import { encodePng } from "./png.ts";

const root = await mkdtemp(join(tmpdir(), "pi-image-paste-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
const identity = (text: string) => text;
let invalidations = 0;
const tui = { requestRender: () => {}, invalidate: () => { invalidations++; }, getFocusedComponent: () => focused, terminal: { rows: 40, columns: 100 } };
const focused = new Editor(tui as never, { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } });
const KITTY = "\x1b_G";
let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;

async function until(check: () => boolean, label: string) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail(`timed out: ${label}`);
}

try {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
	setCellDimensions({ widthPx: 10, heightPx: 20 });
	const data = new Uint8Array(320 * 180 * 4).map((_, index) => index % 4 === 3 ? 255 : (index * 7) & 0xff);
	const shot = join(root, "client-78-clipboard-1.png");
	await writeFile(shot, encodePng({ width: 320, height: 180, data }));

	let editor = "";
	let paste: TerminalInputHandler | undefined;
	let widget: Component | undefined;
	let viewer: (Component & { handleInput(data: string): void }) | undefined;
	const notices: string[] = [];
	const services = await createAgentSessionServices({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: SettingsManager.inMemory({}),
		resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, extensionFactories: [(pi) => extension(pi)] } });
	const manager = SessionManager.inMemory(root);
	({ session } = await createAgentSessionFromServices({ services, sessionManager: manager, noTools: "all" }));
	await session.bindExtensions({ mode: "tui", uiContext: {
		...session.extensionRunner.getUIContext(),
		notify: (message) => notices.push(message),
		getEditorText: () => editor,
		setEditorText: (text) => { editor = text; },
		onTerminalInput: (handler) => { paste = handler; return () => { paste = undefined; }; },
		setWidget: ((key: string, factory: unknown) => {
			if (key === "image-paste" && typeof factory === "function") widget = factory(tui, theme);
		}) as never,
		custom: (async (factory: (...args: unknown[]) => Component & { handleInput(data: string): void }) => {
			await new Promise<void>((resolve) => { viewer = factory(tui, theme, undefined, () => resolve()); });
			viewer = undefined;
		}) as never,
	} });
	assert(paste && widget, "TUI sessions install the paste listener and draft widget");

	// Herdr and terminals paste clipboard images as file paths.
	assert.equal(paste(`\x1b[200~hello\x1b[201~`), undefined, "ordinary text passes through");
	const pasted = paste(`\x1b[200~${shot}\x1b[201~`);
	assert.deepEqual(pasted, { data: "\x1b[200~[Image 1] \x1b[201~" });
	// The paste listener made the focused editor treat the live token as one unit.
	for (const key of [pasted.data!, "\x7f", "\x7f"]) focused.handleInput(key);
	assert.equal(focused.getText(), "", "two Backspaces remove the space and the whole token");
	editor = "look [Image 1]";
	await until(() => widget!.render(100).some((line) => line.includes(KITTY)), "draft thumbnail");
	assert(!widget.render(100).join("\n").includes("[Image 1]"), "thumbnails carry no caption; the token names them");

	// Pi's own Ctrl+V inserts a temporary path; it becomes the next token.
	const piClipboard = join(root, "pi-clipboard-0b4c6a3e-2f7d-4c5e-9a1b-3c2d1e0f9a8b.png");
	await writeFile(piClipboard, encodePng({ width: 20, height: 20, data: new Uint8Array(1600).fill(200) }));
	editor = `look [Image 1] and ${piClipboard}`;
	widget.render(100);
	await until(() => editor === "look [Image 1] and [Image 2]", "Pi clipboard path normalized");

	const original = (await readFile(shot)).toString("base64");
	const input = await session.extensionRunner.emitInput(editor, undefined, "interactive");
	assert.equal(input.action, "transform");
	assert(input.action === "transform");
	assert.equal(input.text, "look [Image 1] and [Image 2]", "tokens stay in the prompt");
	assert.deepEqual(input.images?.map((image) => image.mimeType), ["image/png", "image/png"]);
	assert.equal(input.images?.[0]?.data, original, "the original bytes are attached");
	assert.equal((await session.extensionRunner.emitInput("again [Image 1]", undefined, "interactive")).action, "continue", "a submitted draft is not reused");

	const entry = manager.getEntries().find((candidate) => candidate.type === "custom" && candidate.customType === ENTRY_TYPE);
	assert(entry && entry.type === "custom");
	const strip = session.extensionRunner.getEntryRenderer(ENTRY_TYPE)!(entry, { expanded: false }, theme as never)!;
	await until(() => strip.render(100).some((line) => line.includes(KITTY)), "transcript thumbnails");
	assert.equal((strip as unknown as { renderedSlots: unknown[] }).renderedSlots.length, 2, "both transcript thumbnails are laid out");

	const viewing = session.prompt("/images");
	await until(() => viewer !== undefined, "viewer opened");
	await until(() => viewer!.render(100).some((line) => line.includes(KITTY)), "viewer image");
	assert.match(viewer!.render(100)[0]!, /Image 2 of 2/);
	viewer!.handleInput("\x1b[D");
	assert.match(viewer!.render(100)[0]!, /Image 1 of 2/);
	viewer!.handleInput("\x1b");
	await viewing;
	assert.deepEqual(notices, []);

	// Previews are configurable at runtime and persisted.
	editor = "look [Image 1]";
	assert.deepEqual(paste(`\x1b[200~${shot}\x1b[201~`), { data: "\x1b[200~[Image 1] \x1b[201~" });
	await until(() => widget!.render(100).some((line) => line.includes(KITTY)), "draft thumbnail before toggling");
	await session.prompt("/images prompt off");
	assert.deepEqual(widget.render(100), [], "prompt previews hidden");
	await session.prompt("/images transcript off");
	assert.equal(session.extensionRunner.getEntryRenderer(ENTRY_TYPE)!(entry, { expanded: false }, theme as never), undefined, "transcript previews hidden");
	await session.prompt("/images rows 4");
	await session.prompt("/images color #FE8019");
	await session.prompt("/images rows 99");
	assert.equal(invalidations, 4, "each saved change rebuilds the transcript");
	const saved = JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR, "image-paste.json"), "utf8"));
	assert.deepEqual(saved, { promptPreview: false, transcriptPreview: false, previewRows: 4, tokenColor: "#fe8019" });
	assert.match(notices.at(-2)!, /prompt off · transcript off · rows 4 · token color #fe8019/);
	assert.match(notices.at(-1)!, /^Usage: \/images/);
	console.log("pasted image tokens, thumbnails, attachments, viewer and settings verified");
} finally {
	session?.dispose();
	await rm(root, { recursive: true, force: true });
}
