import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToPng, keyHint } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getCapabilities, Image, Text, type Component } from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "node:crypto";
import {
	createReadStream,
	readFileSync,
} from "node:fs";
import {
	link,
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

const ENTRY_TYPE = "image-store-v1";
const CONTEXT_MESSAGE_TYPE = "image-store-context-v1";
export const DETAILS_KEY = "__pi_image_store";
const STORE_DIRECTORY = "image-store";
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const LIVE_REGISTRY = Symbol.for("pi.image-store.live-registry.v2");
const MARKER_SOURCE = String.raw`\[image [0-9a-f]{8}\]\(pi-image:\/\/sha256\/([0-9a-f]{64})\?mime=([^&)\s]+)&bytes=([0-9]+)\)`;
const JSON_DIGEST_SOURCE = String.raw`"digest"\s*:\s*"([0-9a-f]{64})"`;
const BLOB_FILENAME = /^([0-9a-f]{64})\.[a-z0-9]+$/;

export interface StoredImageRef {
	digest: string;
	mimeType: string;
	bytes: number;
}

interface StoredImageEntry {
	version: 1;
	ref: StoredImageRef;
	label?: string;
}

interface StoredImageDetails {
	version: 1;
	refs: StoredImageRef[];
}

interface StoredBlob {
	digest: string;
	path: string;
	bytes: number;
}

interface LiveRegistry {
	current: Set<string>;
	previous: Set<string>;
	runActive: boolean;
}

function liveRegistry(): LiveRegistry {
	const globals = globalThis as typeof globalThis & { [LIVE_REGISTRY]?: LiveRegistry };
	return globals[LIVE_REGISTRY] ??= { current: new Set(), previous: new Set(), runActive: false };
}

function beginLiveRun(): void {
	const registry = liveRegistry();
	if (registry.runActive) return;
	registry.previous = registry.current;
	registry.current = new Set();
	registry.runActive = true;
}

function endLiveRun(): void {
	liveRegistry().runActive = false;
}

function markLive(digest: string): void {
	liveRegistry().current.add(digest);
}

function clearLive(): void {
	const registry = liveRegistry();
	registry.current.clear();
	registry.previous.clear();
	registry.runActive = false;
}

export function isStoredImageLive(digest: string): boolean {
	const registry = liveRegistry();
	return registry.current.has(digest) || registry.previous.has(digest);
}

function markerPattern(): RegExp {
	return new RegExp(MARKER_SOURCE, "g");
}

function configDirectory(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return resolve(configured);
}

function extensionForMimeType(mimeType: string): string {
	switch (mimeType.toLowerCase()) {
		case "image/jpeg": return "jpg";
		case "image/png": return "png";
		case "image/gif": return "gif";
		case "image/webp": return "webp";
		case "image/bmp": return "bmp";
		default: return "img";
	}
}

export function markerFor(ref: StoredImageRef): string {
	return `[image ${ref.digest.slice(0, 8)}](pi-image://sha256/${ref.digest}?mime=${encodeURIComponent(ref.mimeType)}&bytes=${ref.bytes})`;
}

export function refsFromText(text: string): StoredImageRef[] {
	const refs: StoredImageRef[] = [];
	for (const match of text.matchAll(markerPattern())) {
		const bytes = Number.parseInt(match[3] ?? "", 10);
		if (!Number.isSafeInteger(bytes) || bytes < 0) continue;
		try {
			refs.push({ digest: match[1]!, mimeType: decodeURIComponent(match[2]!), bytes });
		} catch {
			// Keep malformed references as ordinary text.
		}
	}
	return refs;
}

class Base64Cache {
	private readonly values = new Map<string, string>();
	private bytes = 0;

	get(digest: string): string | undefined {
		const value = this.values.get(digest);
		if (value === undefined) return undefined;
		this.values.delete(digest);
		this.values.set(digest, value);
		return value;
	}

	set(digest: string, value: string): void {
		const previous = this.values.get(digest);
		if (previous !== undefined) {
			this.bytes -= previous.length;
			this.values.delete(digest);
		}
		if (value.length > MAX_CACHE_BYTES) return;
		this.values.set(digest, value);
		this.bytes += value.length;
		while (this.bytes > MAX_CACHE_BYTES) {
			const oldest = this.values.entries().next().value as [string, string] | undefined;
			if (!oldest) break;
			this.values.delete(oldest[0]);
			this.bytes -= oldest[1].length;
		}
	}

	clear(): void {
		this.values.clear();
		this.bytes = 0;
	}
}

export class ContentAddressedImageStore {
	readonly root: string;
	private readonly cache = new Base64Cache();

	constructor(agentDirectory = configDirectory()) {
		this.root = join(agentDirectory, STORE_DIRECTORY, "sha256");
	}

	pathFor(ref: StoredImageRef): string {
		return join(this.root, ref.digest.slice(0, 2), `${ref.digest}.${extensionForMimeType(ref.mimeType)}`);
	}

	async put(image: ImageContent): Promise<StoredImageRef> {
		const bytes = Buffer.from(image.data, "base64");
		if (bytes.length === 0) throw new Error("Cannot store an empty image");
		const digest = createHash("sha256").update(bytes).digest("hex");
		const ref = { digest, mimeType: image.mimeType, bytes: bytes.length };
		const target = this.pathFor(ref);
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });

		const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
		try {
			await link(temporary, target);
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
		} finally {
			await unlink(temporary).catch(() => {});
		}
		this.cache.set(digest, image.data);
		return ref;
	}

	async load(ref: StoredImageRef): Promise<string> {
		const cached = this.cache.get(ref.digest);
		if (cached !== undefined) return cached;
		const value = (await readFile(this.pathFor(ref))).toString("base64");
		this.cache.set(ref.digest, value);
		return value;
	}

	loadSync(ref: StoredImageRef): string {
		const cached = this.cache.get(ref.digest);
		if (cached !== undefined) return cached;
		const value = readFileSync(this.pathFor(ref)).toString("base64");
		this.cache.set(ref.digest, value);
		return value;
	}

	clearCache(): void {
		this.cache.clear();
	}
}

export async function externalizeContent(
	content: Array<TextContent | ImageContent>,
	store: ContentAddressedImageStore,
): Promise<{ content: Array<TextContent | ImageContent>; refs: StoredImageRef[] }> {
	const next: Array<TextContent | ImageContent> = [];
	const refs: StoredImageRef[] = [];
	for (const block of content) {
		if (block.type !== "image") {
			next.push(block);
			continue;
		}
		try {
			const ref = await store.put(block);
			refs.push(ref);
			next.push({ type: "text", text: markerFor(ref) });
		} catch {
			// Preserve the original image if sidecar persistence fails.
			next.push(block);
		}
	}
	return { content: next, refs };
}

async function rehydrateText(
	text: string,
	store: ContentAddressedImageStore,
): Promise<Array<TextContent | ImageContent> | undefined> {
	const matches = [...text.matchAll(markerPattern())];
	if (matches.length === 0) return undefined;

	const content: Array<TextContent | ImageContent> = [];
	let cursor = 0;
	for (const match of matches) {
		if (match.index! > cursor) content.push({ type: "text", text: text.slice(cursor, match.index) });
		const raw = match[0];
		const ref = refsFromText(raw)[0];
		if (!ref) {
			content.push({ type: "text", text: raw });
		} else {
			try {
				content.push({ type: "image", data: await store.load(ref), mimeType: ref.mimeType });
			} catch {
				content.push({ type: "text", text: `${raw} (sidecar unavailable)` });
			}
		}
		cursor = match.index! + raw.length;
	}
	if (cursor < text.length) content.push({ type: "text", text: text.slice(cursor) });
	return content;
}

export function refsFromDetails(message: any): StoredImageRef[] {
	const details = message?.details?.[DETAILS_KEY] as StoredImageDetails | undefined;
	if (details?.version !== 1 || !Array.isArray(details.refs)) return [];
	return details.refs.filter((ref) =>
		ref
		&& typeof ref.digest === "string"
		&& /^[0-9a-f]{64}$/.test(ref.digest)
		&& typeof ref.mimeType === "string"
		&& Number.isSafeInteger(ref.bytes)
		&& ref.bytes >= 0
	);
}

export async function rehydrateMessages(messages: any[], store: ContentAddressedImageStore): Promise<any[]> {
	return Promise.all(messages.map(async (message) => {
		if (!message || !["user", "toolResult", "custom"].includes(message.role)) return message;
		let changed = false;
		let content: any[];
		if (typeof message.content === "string") {
			const expanded = await rehydrateText(message.content, store);
			content = expanded ?? [{ type: "text", text: message.content }];
			changed = Boolean(expanded);
		} else if (Array.isArray(message.content)) {
			content = [];
			for (const block of message.content) {
				if (block?.type !== "text") {
					content.push(block);
					continue;
				}
				const expanded = await rehydrateText(block.text, store);
				if (!expanded) content.push(block);
				else {
					changed = true;
					content.push(...expanded);
				}
			}
		} else {
			return message;
		}

		for (const ref of refsFromDetails(message)) {
			try {
				content.push({ type: "image", data: await store.load(ref), mimeType: ref.mimeType });
			} catch {
				content.push({ type: "text", text: `${markerFor(ref)} (sidecar unavailable)` });
			}
			changed = true;
		}
		return changed ? { ...message, content } : message;
	}));
}

interface PreviewConversion {
	converted?: { data: string; mimeType: string };
	started: boolean;
	failed: boolean;
}

export interface StoredImagePreviewState {
	imageStoreConversions?: Map<string, PreviewConversion>;
}

export class StoredImagePreview implements Component {
	private image?: Image;
	private readonly localConversion: PreviewConversion = { started: false, failed: false };

	constructor(
		private readonly entry: StoredImageEntry,
		private readonly store: ContentAddressedImageStore,
		private readonly theme: any,
		private readonly visible: () => boolean,
		private readonly options: {
			heading?: boolean;
			hiddenWhenCollapsed?: boolean;
			invalidate?: () => void;
			state?: StoredImagePreviewState;
		} = {},
	) {}

	private conversion(): PreviewConversion {
		if (!this.options.state) return this.localConversion;
		const conversions = this.options.state.imageStoreConversions ??= new Map();
		let conversion = conversions.get(this.entry.ref.digest);
		if (!conversion) {
			conversion = { started: false, failed: false };
			conversions.set(this.entry.ref.digest, conversion);
		}
		return conversion;
	}

	render(width: number): string[] {
		const { ref, label } = this.entry;
		const summary = `${label ? `${label} · ` : ""}${ref.digest.slice(0, 8)} · ${formatBytes(ref.bytes)}`;
		if (!this.visible()) {
			this.image = undefined;
			if (this.options.hiddenWhenCollapsed) return [];
			const hint = keyHint("app.tools.expand", "preview");
			return new Text(this.theme.fg("dim", `↳ image ${summary} (${hint})`), 1, 0).render(width);
		}

		let preparing = false;
		const conversion = this.conversion();
		if (!this.image && !conversion.failed) {
			try {
				const source = conversion.converted ?? { data: this.store.loadSync(ref), mimeType: ref.mimeType };
				if (getCapabilities().images === "kitty" && source.mimeType !== "image/png") {
					preparing = true;
					if (!conversion.started) {
						conversion.started = true;
						void convertToPng(source.data, source.mimeType).then((converted) => {
							if (converted) conversion.converted = converted;
							else conversion.failed = true;
							this.options.invalidate?.();
						}).catch(() => {
							conversion.failed = true;
							this.options.invalidate?.();
						});
					}
				} else {
					this.image = new Image(source.data, source.mimeType, {
						fallbackColor: (text: string) => this.theme.fg("toolOutput", text),
					}, {
						maxWidthCells: Math.max(20, Math.min(80, width - 2)),
						maxHeightCells: 24,
					});
				}
			} catch {
				conversion.failed = true;
			}
		}
		const heading = this.options.heading === false
			? []
			: new Text(this.theme.fg("dim", `↳ image ${summary}`), 1, 0).render(width);
		if (preparing && !conversion.converted) {
			return [...heading, ...new Text(this.theme.fg("dim", "  preparing image preview…"), 0, 0).render(width)];
		}
		if (conversion.failed || !this.image) {
			return [...heading, ...new Text(this.theme.fg("warning", "  sidecar unavailable"), 0, 0).render(width)];
		}
		return [...heading, ...this.image.render(width)];
	}

	invalidate(): void {
		this.image?.invalidate();
	}
}

export function renderStoredImagePreviews(
	details: unknown,
	store: ContentAddressedImageStore,
	theme: any,
	expanded: boolean,
	invalidate?: () => void,
	state?: StoredImagePreviewState,
): Component | undefined {
	const refs = refsFromDetails({ details });
	if (refs.length === 0) return undefined;
	const previews = refs.map((ref) => new StoredImagePreview(
		{ version: 1, ref },
		store,
		theme,
		() => expanded || isStoredImageLive(ref.digest),
		{ heading: false, hiddenWhenCollapsed: true, invalidate, state },
	));
	return {
		render: (width: number) => previews.flatMap((preview) => preview.render(width)),
		invalidate: () => previews.forEach((preview) => preview.invalidate()),
	};
}

async function listFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error: any) {
			if (error?.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) files.push(path);
		}
	};
	await visit(root);
	return files;
}

async function listBlobs(store: ContentAddressedImageStore): Promise<StoredBlob[]> {
	const blobs: StoredBlob[] = [];
	for (const path of await listFiles(store.root)) {
		const match = basename(path).match(BLOB_FILENAME);
		if (!match) continue;
		blobs.push({ digest: match[1]!, path, bytes: (await stat(path)).size });
	}
	return blobs;
}

async function referencedDigests(sessionRoot: string): Promise<Set<string>> {
	const referenced = new Set<string>();
	for (const path of (await listFiles(sessionRoot)).filter((file) => extname(file) === ".jsonl")) {
		let carry = "";
		for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
			const text = carry + chunk;
			for (const ref of refsFromText(text)) referenced.add(ref.digest);
			for (const match of text.matchAll(new RegExp(JSON_DIGEST_SOURCE, "g"))) referenced.add(match[1]!);
			carry = text.slice(-256);
		}
		for (const ref of refsFromText(carry)) referenced.add(ref.digest);
		for (const match of carry.matchAll(new RegExp(JSON_DIGEST_SOURCE, "g"))) referenced.add(match[1]!);
	}
	return referenced;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function imageStoreExtension(pi: ExtensionAPI) {
	const agentDirectory = configDirectory();
	const store = new ContentAddressedImageStore(agentDirectory);

	const appendPreview = (ref: StoredImageRef, label?: string) => {
		markLive(ref.digest);
		pi.appendEntry(ENTRY_TYPE, { version: 1, ref, label } satisfies StoredImageEntry);
	};

	pi.on("session_start", () => {
		clearLive();
		store.clearCache();
	});

	pi.on("agent_start", () => beginLiveRun());
	pi.on("agent_settled", () => endLiveRun());

	pi.on("session_shutdown", () => {
		clearLive();
		store.clearCache();
	});

	pi.on("input", async (event, ctx) => {
		if (!event.images?.length) return;
		const { content, refs } = await externalizeContent(event.images, store);
		const remainingImages = content.filter((block): block is ImageContent => block.type === "image");
		for (const ref of refs) appendPreview(ref, "pasted image");
		if (refs.length === 0) {
			ctx.ui.notify("Could not externalize pasted image", "warning");
			return;
		}
		pi.sendMessage({
			customType: CONTEXT_MESSAGE_TYPE,
			content: "Attached image sidecar.",
			display: false,
			details: { [DETAILS_KEY]: { version: 1, refs } satisfies StoredImageDetails },
		});
		return {
			action: "transform" as const,
			text: event.text,
			images: remainingImages.length > 0 ? remainingImages : undefined,
		};
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!event.content.some((block) => block.type === "image")) return;
		const { content, refs } = await externalizeContent(event.content, store);
		for (const ref of refs) markLive(ref.digest);
		if (refs.length === 0) {
			ctx.ui.notify("Could not externalize tool image", "warning");
			return;
		}
		const persistedContent = content.map((block) =>
			block.type === "text" && refsFromText(block.text).length > 0
				? { type: "text" as const, text: "[image stored externally]" }
				: block
		);
		const details = event.details && typeof event.details === "object" ? event.details : {};
		return {
			content: persistedContent,
			details: { ...details, [DETAILS_KEY]: { version: 1, refs } satisfies StoredImageDetails },
		};
	});

	pi.on("context", async (event) => ({
		messages: await rehydrateMessages(event.messages, store),
	}));

	pi.registerEntryRenderer<StoredImageEntry>(ENTRY_TYPE, (entry, options, theme) => {
		const data = entry.data;
		if (data?.version !== 1 || !data.ref) return undefined;
		return new StoredImagePreview(data, store, theme, () => options.expanded || isStoredImageLive(data.ref.digest));
	});

	pi.registerCommand("image-store", {
		description: "Show image sidecar stats or garbage-collect unused blobs",
		handler: async (args, ctx) => {
			const action = args.trim() || "stats";
			const blobs = await listBlobs(store);
			const totalBytes = blobs.reduce((sum, blob) => sum + blob.bytes, 0);
			if (action === "stats") {
				ctx.ui.notify(`${blobs.length} image sidecar${blobs.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)} · ${store.root}`, "info");
				return;
			}
			if (action !== "gc") {
				ctx.ui.notify("Usage: /image-store [stats|gc]", "warning");
				return;
			}
			if (!ctx.hasUI || !await ctx.ui.confirm("Garbage-collect image sidecars?", "Delete blobs not referenced by any saved session?")) return;
			const referenced = await referencedDigests(join(agentDirectory, "sessions"));
			const unused = blobs.filter((blob) => !referenced.has(blob.digest));
			await Promise.all(unused.map((blob) => rm(blob.path, { force: true })));
			const reclaimed = unused.reduce((sum, blob) => sum + blob.bytes, 0);
			ctx.ui.notify(`Removed ${unused.length} unreferenced sidecar${unused.length === 1 ? "" : "s"} · ${formatBytes(reclaimed)} reclaimed`, "info");
		},
	});
}
