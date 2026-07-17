const OUTPUT_HEAD_BYTES = 16 * 1024;
const OUTPUT_TAIL_BYTES = 240 * 1024;
const CURSOR_TAIL_BYTES = 256 * 1024;

function markerFor(omittedBytes: number): string {
	return omittedBytes > 0 ? `[... ${omittedBytes.toLocaleString()} earlier bytes omitted ...]\n` : "";
}

const STRING_CONTROL = /\x1b[PX^_][\s\S]*?(?:\x1b\\|\x9c|$)|\x1b\][\s\S]*?(?:\x07|\x1b\\|\x9c|$)|\x9d[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g;
const CSI_SEQUENCE = /(?:\x1b\[|\x9b)([0-?]*)([ -/]*)([@-~])/g;
const ESC_SEQUENCE = /\x1b(?!\[)[ -/]*[@-~]/g;

/**
 * Return terminal output that is safe to embed in Pi-rendered tool cards.
 *
 * Managed background jobs intentionally capture raw process output, including
 * full-screen TUIs. Replaying cursor movement, mode toggles, OSC strings, or
 * BELs inside Pi's own renderer can move the outer terminal cursor and corrupt
 * the frame. Keep only SGR color/style sequences; strip all other terminal
 * controls while preserving ordinary text.
 */
export function sanitizeTerminalOutput(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(STRING_CONTROL, "")
		.replace(CSI_SEQUENCE, (_match, params: string, intermediates: string, final: string) => {
			if (final === "m" && intermediates === "" && /^[0-9;:]*$/.test(params)) return `\x1b[${params}m`;
			return "";
		})
		.replace(ESC_SEQUENCE, "")
		.replace(/\x1b(?!\[[0-9;:]*m)/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f\x80-\x9f]/g, "");
}

export class BoundedOutput {
	private head = Buffer.alloc(0);
	private tail = Buffer.alloc(0);
	private totalBytes = 0;

	append(chunk: Buffer | string): void {
		let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		this.totalBytes += bytes.length;
		if (this.head.length < OUTPUT_HEAD_BYTES) {
			const take = Math.min(OUTPUT_HEAD_BYTES - this.head.length, bytes.length);
			this.head = Buffer.concat([this.head, bytes.subarray(0, take)]);
			bytes = bytes.subarray(take);
		}
		if (bytes.length > 0) {
			this.tail = Buffer.concat([this.tail, bytes]);
			if (this.tail.length > OUTPUT_TAIL_BYTES) this.tail = this.tail.subarray(this.tail.length - OUTPUT_TAIL_BYTES);
		}
	}

	get omittedBytes(): number {
		return Math.max(0, this.totalBytes - this.head.length - this.tail.length);
	}

	text(limitBytes?: number): string {
		if (limitBytes !== undefined) {
			if (this.totalBytes === 0) return "";
			const retained = this.omittedBytes === 0 ? Buffer.concat([this.head, this.tail]) : this.tail;
			let bounded = retained.length > limitBytes ? retained.subarray(retained.length - limitBytes) : retained;
			let omitted = Math.max(0, this.totalBytes - bounded.length);
			let marker = markerFor(omitted);
			const contentLimit = Math.max(0, limitBytes - Buffer.byteLength(marker));
			if (bounded.length > contentLimit) bounded = bounded.subarray(bounded.length - contentLimit);
			omitted = Math.max(0, this.totalBytes - bounded.length);
			marker = markerFor(omitted);
			return sanitizeTerminalOutput(`${marker}${bounded.toString("utf8")}`);
		}
		const marker = this.omittedBytes > 0 ? `\n[... ${this.omittedBytes.toLocaleString()} bytes omitted ...]\n` : "";
		return sanitizeTerminalOutput(`${this.head.toString("utf8")}${marker}${this.tail.toString("utf8")}`);
	}
}

export interface CursorRead {
	text: string;
	cursor: number;
	omittedBytes: number;
}

/** Tail buffer with absolute cursors for non-repeating tool output. */
export class CursorOutput {
	private tail = Buffer.alloc(0);
	private totalBytes = 0;

	append(chunk: Buffer | string): void {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		this.totalBytes += bytes.length;
		this.tail = Buffer.concat([this.tail, bytes]);
		if (this.tail.length > CURSOR_TAIL_BYTES) this.tail = this.tail.subarray(this.tail.length - CURSOR_TAIL_BYTES);
	}

	get cursor(): number {
		return this.totalBytes;
	}

	read(cursor: number, limitBytes: number): CursorRead {
		const normalizedCursor = Math.max(0, Math.min(Number.isFinite(cursor) ? Math.floor(cursor) : 0, this.totalBytes));
		const retainedStart = this.totalBytes - this.tail.length;
		const requestedStart = Math.max(normalizedCursor, retainedStart);
		let bytes = this.tail.subarray(requestedStart - retainedStart);
		let omitted = Math.max(0, requestedStart - normalizedCursor);
		if (bytes.length > limitBytes) {
			omitted += bytes.length - limitBytes;
			bytes = bytes.subarray(bytes.length - limitBytes);
		}
		let marker = markerFor(omitted);
		const contentLimit = Math.max(0, limitBytes - Buffer.byteLength(marker));
		if (bytes.length > contentLimit) {
			omitted += bytes.length - contentLimit;
			bytes = bytes.subarray(bytes.length - contentLimit);
			marker = markerFor(omitted);
		}
		return { text: sanitizeTerminalOutput(`${marker}${bytes.toString("utf8")}`), cursor: this.totalBytes, omittedBytes: omitted };
	}

	latestLine(limitBytes = 512): string {
		const start = Math.max(0, this.tail.length - limitBytes);
		const lines = sanitizeTerminalOutput(this.tail.subarray(start).toString("utf8")).split("\n");
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = lines[index]?.trim();
			if (line) return line;
		}
		return "";
	}
}
