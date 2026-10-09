import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";
/** Larger files are left as plain paths; providers reject them anyway. */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** Identify a supported image from its first bytes. */
export function sniffImageMime(header: Uint8Array): string | undefined {
	const starts = (...bytes: number[]) => bytes.every((byte, index) => header[index] === byte);
	if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
	if (starts(0x52, 0x49, 0x46, 0x46) && header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) return "image/webp";
	return undefined;
}

/** Synchronously confirm that a path is a regular, readable, supported image. */
export function imageFileMime(path: string): string | undefined {
	let fd: number | undefined;
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) return undefined;
		fd = openSync(path, "r");
		const header = new Uint8Array(12);
		readSync(fd, header, 0, header.length, 0);
		return sniffImageMime(header);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Split pasted text into path candidates, honoring quotes and backslash escapes. */
export function splitPastedPaths(text: string): string[] | undefined {
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;
	let started = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i]!;
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			started = true;
		} else if (char === "\\" && i + 1 < text.length && text[i + 1] !== "\n") {
			current += text[++i];
			started = true;
		} else if (/\s/.test(char)) {
			if (started) tokens.push(current);
			current = "";
			started = false;
		} else {
			current += char;
			started = true;
		}
	}
	if (quote) return undefined;
	if (started) tokens.push(current);
	return tokens;
}

function toPath(token: string, cwd: string): string | undefined {
	if (token.startsWith("file://")) {
		try { return fileURLToPath(token); } catch { return undefined; }
	}
	if (token === "~" || token.startsWith("~/")) return resolve(homedir(), token.slice(2));
	return isAbsolute(token) ? token : resolve(cwd, token);
}

export interface PastedImage {
	path: string;
	mimeType: string;
}

/**
 * Return the images when pasted text consists only of image file paths, as
 * terminals and Herdr produce for clipboard images and dropped files.
 */
export function parsePastedImages(text: string, cwd: string): PastedImage[] | undefined {
	if (!text.trim() || text.length > 16_384) return undefined;
	const tokens = splitPastedPaths(text.trim());
	if (!tokens?.length || tokens.length > 20) return undefined;
	const images: PastedImage[] = [];
	for (const token of tokens) {
		const path = toPath(token, cwd);
		const mimeType = path && imageFileMime(path);
		if (!path || !mimeType) return undefined;
		images.push({ path, mimeType });
	}
	return images;
}

/** Unwrap one complete bracketed paste, or return undefined for other input. */
export function bracketedPasteContent(data: string): string | undefined {
	if (!data.startsWith(PASTE_START) || !data.endsWith(PASTE_END)) return undefined;
	const content = data.slice(PASTE_START.length, -PASTE_END.length);
	return content.includes(PASTE_START) || content.includes(PASTE_END) ? undefined : content;
}

const TOKEN = /\[Image (\d+)\]/g;

/** Image labels referenced in text, in first-appearance order without duplicates. */
export function referencedLabels(text: string): number[] {
	const seen = new Set<number>();
	for (const match of text.matchAll(TOKEN)) seen.add(Number(match[1]));
	return [...seen];
}

export function imageToken(label: number): string {
	return `[Image ${label}]`;
}

/** Temporary files Pi's own Ctrl+V writes before inserting their path. */
export const PI_CLIPBOARD_PATH = /(?:^|(?<=\s))(\/[^\s]*\/pi-clipboard-[0-9a-f-]{36}\.(?:png|jpe?g|gif|webp))(?=\s|$)/g;
