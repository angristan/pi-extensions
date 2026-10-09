import { deflateSync, inflateSync } from "node:zlib";

/** Straight 8-bit RGBA pixels, row-major. */
export interface Rgba {
	width: number;
	height: number;
	data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 64 * 1024 * 1024;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}

/** Encode RGBA pixels as a non-interlaced 8-bit PNG. */
export function encodePng(image: Rgba): Buffer {
	const { width, height, data } = image;
	if (data.length !== width * height * 4) throw new Error("RGBA buffer does not match its dimensions");
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bit depth
	header[9] = 6; // RGBA
	return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode an 8- or 16-bit non-interlaced PNG to RGBA. Covers the encoder output
 * of Pi's image converter; other variants throw so callers can fall back.
 */
export function decodePng(bytes: Uint8Array): Rgba {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG");
	let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
	let palette: Uint8Array | undefined;
	let transparency: Uint8Array | undefined;
	const idat: Buffer[] = [];
	for (let offset = 8; offset + 8 <= buffer.length;) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("latin1", offset + 4, offset + 8);
		const body = buffer.subarray(offset + 8, offset + 8 + length);
		if (body.length !== length) throw new Error("Truncated PNG chunk");
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			depth = body[8]!;
			colorType = body[9]!;
			interlace = body[12]!;
		} else if (type === "PLTE") palette = body;
		else if (type === "tRNS") transparency = body;
		else if (type === "IDAT") idat.push(body);
		else if (type === "IEND") break;
		offset += 12 + length;
	}
	const channels = CHANNELS[colorType];
	if (!width || !height || channels === undefined) throw new Error("Unsupported PNG header");
	if (width * height > MAX_PIXELS) throw new Error("PNG is too large to decode");
	if (interlace !== 0) throw new Error("Interlaced PNG is not supported");
	if (depth !== 8 && !(depth === 16 && colorType !== 3)) throw new Error(`Unsupported PNG bit depth ${depth}`);
	if (colorType === 3 && !palette) throw new Error("Palette PNG without PLTE");

	const sampleBytes = depth / 8;
	const bpp = channels * sampleBytes;
	const stride = width * bpp;
	const raw = inflateSync(Buffer.concat(idat));
	if (raw.length < (stride + 1) * height) throw new Error("Truncated PNG image data");
	const rows = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!;
		const source = y * (stride + 1) + 1;
		const target = y * stride;
		for (let x = 0; x < stride; x++) {
			const value = raw[source + x]!;
			const left = x >= bpp ? rows[target + x - bpp]! : 0;
			const up = y > 0 ? rows[target - stride + x]! : 0;
			const upLeft = y > 0 && x >= bpp ? rows[target - stride + x - bpp]! : 0;
			let out: number;
			switch (filter) {
				case 0: out = value; break;
				case 1: out = value + left; break;
				case 2: out = value + up; break;
				case 3: out = value + ((left + up) >> 1); break;
				case 4: out = value + paeth(left, up, upLeft); break;
				default: throw new Error(`Unknown PNG filter ${filter}`);
			}
			rows[target + x] = out & 0xff;
		}
	}

	const data = new Uint8Array(width * height * 4);
	const sample = (index: number) => rows[index * sampleBytes]!; // high byte for 16-bit
	for (let i = 0; i < width * height; i++) {
		const base = i * channels;
		const out = i * 4;
		switch (colorType) {
			case 0: {
				const v = sample(base);
				data.set([v, v, v, 255], out);
				break;
			}
			case 2:
				data.set([sample(base), sample(base + 1), sample(base + 2), 255], out);
				break;
			case 3: {
				const index = rows[i]!;
				data.set([palette![index * 3] ?? 0, palette![index * 3 + 1] ?? 0, palette![index * 3 + 2] ?? 0, transparency?.[index] ?? 255], out);
				break;
			}
			case 4: {
				const v = sample(base);
				data.set([v, v, v, sample(base + 1)], out);
				break;
			}
			default:
				data.set([sample(base), sample(base + 1), sample(base + 2), sample(base + 3)], out);
		}
	}
	return { width, height, data };
}

/** Copy `source` into `target` at (x, y), clipped to the target. */
export function blit(target: Rgba, source: Rgba, x: number, y: number): void {
	const width = Math.min(source.width, target.width - x);
	const height = Math.min(source.height, target.height - y);
	if (width <= 0 || height <= 0) return;
	for (let row = 0; row < height; row++) {
		const from = row * source.width * 4;
		const to = ((y + row) * target.width + x) * 4;
		target.data.set(source.data.subarray(from, from + width * 4), to);
	}
}
