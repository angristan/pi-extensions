import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MAX_IMAGE_BYTES, sniffImageMime } from "./paste.ts";

export interface StoredImage {
	digest: string;
	mimeType: string;
	bytes: number;
}

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const DIGEST = /^[0-9a-f]{64}$/;

/** Pasted originals, keyed by SHA-256, so transcripts and the viewer outlive temporary files. */
export class PastedImageStore {
	constructor(readonly root: string = join(getAgentDir(), "image-paste")) {}

	path(image: Pick<StoredImage, "digest" | "mimeType">): string {
		if (!DIGEST.test(image.digest)) throw new Error("Invalid image digest");
		return join(this.root, `${image.digest}.${EXTENSIONS[image.mimeType] ?? "img"}`);
	}

	/** Copy an image file into the store; identical bytes are stored once. */
	async add(sourcePath: string): Promise<StoredImage> {
		const data = await readFile(sourcePath);
		if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new Error("Image is empty or too large");
		const mimeType = sniffImageMime(data);
		if (!mimeType) throw new Error("Unsupported image format");
		const image = { digest: createHash("sha256").update(data).digest("hex"), mimeType, bytes: data.length };
		const target = this.path(image);
		if (!existsSync(target)) {
			mkdirSync(this.root, { recursive: true, mode: 0o700 });
			chmodSync(this.root, 0o700);
			const temporary = `${target}.${randomUUID()}.tmp`;
			try {
				writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
				renameSync(temporary, target);
			} finally {
				rmSync(temporary, { force: true });
			}
		}
		return image;
	}

	/** Read and verify stored bytes; undefined when missing or corrupt. */
	load(image: Pick<StoredImage, "digest" | "mimeType">): Buffer | undefined {
		try {
			const data = readFileSync(this.path(image));
			return createHash("sha256").update(data).digest("hex") === image.digest ? data : undefined;
		} catch {
			return undefined;
		}
	}
}
