/**
 * Dependency graph:
 * Direct: None.
 * Used by: `extensions/background-jobs/index.ts`.
 */
const OUTPUT_HEAD_BYTES = 16 * 1024;
const OUTPUT_TAIL_BYTES = 240 * 1024;
const CURSOR_TAIL_BYTES = 256 * 1024;

function markerFor(omittedBytes: number): string {
	return omittedBytes > 0 ? `[... ${omittedBytes.toLocaleString()} earlier bytes omitted ...]\n` : "";
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
			return `${marker}${bounded.toString("utf8")}`;
		}
		const marker = this.omittedBytes > 0 ? `\n[... ${this.omittedBytes.toLocaleString()} bytes omitted ...]\n` : "";
		return `${this.head.toString("utf8")}${marker}${this.tail.toString("utf8")}`;
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
		return { text: `${marker}${bytes.toString("utf8")}`, cursor: this.totalBytes, omittedBytes: omitted };
	}

	latestLine(limitBytes = 512): string {
		const start = Math.max(0, this.tail.length - limitBytes);
		const lines = this.tail.subarray(start).toString("utf8").replace(/\r/g, "").split("\n");
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = lines[index]?.trim();
			if (line) return line;
		}
		return "";
	}
}
