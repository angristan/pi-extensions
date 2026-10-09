import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PreviewSettings {
	/** Thumbnails above the editor for the draft's images (OpenCode `prompt.image_preview`). */
	promptPreview: boolean;
	/** Thumbnails under sent prompts (OpenCode `session.image_preview`). */
	transcriptPreview: boolean;
	/** Thumbnail height in terminal rows, or "auto" for a quarter of the terminal, 4–8 rows. */
	previewRows: "auto" | number;
	/** Token block color: a Pi theme color name or #rrggbb. OpenCode uses its theme's warning color. */
	tokenColor: string;
}

export const DEFAULT_SETTINGS: PreviewSettings = { promptPreview: true, transcriptPreview: true, previewRows: "auto", tokenColor: "warning" };

export function parseColor(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : /^[a-z][a-z0-9]*$/i.test(value) ? value : undefined;
}

/** Truecolor foreground escape for #rrggbb. */
export function hexForeground(hex: string): string {
	const [r, g, b] = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
	return `\x1b[38;2;${r};${g};${b}m`;
}
export const MIN_ROWS = 2;
export const MAX_ROWS = 16;

export function parseRows(value: unknown): PreviewSettings["previewRows"] | undefined {
	if (value === "auto") return "auto";
	const rows = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
	return Number.isInteger(rows) && (rows as number) >= MIN_ROWS && (rows as number) <= MAX_ROWS ? rows as number : undefined;
}

/** Same sizing as OpenCode's prompt previews when "auto". */
export function thumbnailRows(setting: PreviewSettings["previewRows"], terminalRows: number): number {
	return setting === "auto" ? Math.max(4, Math.min(8, Math.floor(terminalRows / 4))) : setting;
}

function readObject(path: string): Record<string, unknown> {
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > 64_000) throw new Error("not a small file");
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Cannot read ${path}. Repair it before changing image settings.`);
	}
}

/** Settings with defaults for missing or invalid values; unreadable files fall back to defaults. */
export function readSettings(path: string): PreviewSettings {
	let value: Record<string, unknown>;
	try { value = readObject(path); } catch { return { ...DEFAULT_SETTINGS }; }
	return {
		promptPreview: typeof value.promptPreview === "boolean" ? value.promptPreview : DEFAULT_SETTINGS.promptPreview,
		transcriptPreview: typeof value.transcriptPreview === "boolean" ? value.transcriptPreview : DEFAULT_SETTINGS.transcriptPreview,
		previewRows: parseRows(value.previewRows) ?? DEFAULT_SETTINGS.previewRows,
		tokenColor: parseColor(value.tokenColor) ?? DEFAULT_SETTINGS.tokenColor,
	};
}

/** Merge an update into the file, keeping unrelated keys; refuses to overwrite malformed JSON. */
export function writeSettings(path: string, update: Partial<PreviewSettings>): void {
	const current = readObject(path);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...current, ...update }, null, 2)}\n`);
}
