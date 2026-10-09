import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { blit, decodePng, encodePng, type Rgba } from "./png.ts";

const pixels = (width: number, height: number, fill: (x: number, y: number) => number[]): Rgba => {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(fill(x, y), (y * width + x) * 4);
	return { width, height, data };
};

test("RGBA round-trips through encode and decode", () => {
	const image = pixels(5, 3, (x, y) => [x * 40, y * 80, (x + y) * 20, 255 - x]);
	const decoded = decodePng(encodePng(image));
	expect(decoded.width).toBe(5);
	expect(decoded.height).toBe(3);
	expect([...decoded.data]).toEqual([...image.data]);
});

/** Build an RGB PNG whose rows use every filter type, as real encoders emit. */
function filteredRgbPng(width: number, height: number, rgb: (x: number, y: number) => number[]): Buffer {
	const bpp = 3, stride = width * bpp;
	const plain = (y: number) => Buffer.from(Array.from({ length: width }, (_, x) => rgb(x, y)).flat());
	const rows: Buffer[] = [];
	for (let y = 0; y < height; y++) {
		const filter = y % 5;
		const row = plain(y), prior = y ? plain(y - 1) : Buffer.alloc(stride);
		const out = Buffer.alloc(stride + 1);
		out[0] = filter;
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? row[i - bpp]! : 0, b = prior[i]!, c = i >= bpp ? prior[i - bpp]! : 0;
			const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
			const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]!;
			out[i + 1] = (row[i]! - predictor) & 0xff;
		}
		rows.push(out);
	}
	const chunk = (type: string, body: Buffer) => {
		const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(type, 4, "latin1");
		return Buffer.concat([head, body, Buffer.alloc(4)]); // decoder does not verify CRCs
	};
	const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

test("decodes every scanline filter of an RGB image", () => {
	const rgb = (x: number, y: number) => [(x * 37 + y * 11) & 0xff, (x * 5 + y * 90) & 0xff, (x * y * 7) & 0xff];
	const decoded = decodePng(filteredRgbPng(7, 10, rgb));
	for (let y = 0; y < 10; y++) for (let x = 0; x < 7; x++) {
		expect([...decoded.data.subarray((y * 7 + x) * 4, (y * 7 + x) * 4 + 4)]).toEqual([...rgb(x, y), 255]);
	}
});

test("rejects data that is not a supported PNG", () => {
	expect(() => decodePng(Buffer.from("not a png"))).toThrow();
});

test("blit copies a source into a target and clips at the edges", () => {
	const target = pixels(4, 2, () => [0, 0, 0, 0]);
	blit(target, pixels(3, 3, () => [9, 9, 9, 255]), 2, 1);
	const alpha = (x: number, y: number) => target.data[(y * 4 + x) * 4 + 3];
	expect([alpha(1, 1), alpha(2, 1), alpha(3, 1), alpha(2, 0)]).toEqual([0, 255, 255, 0]);
});
