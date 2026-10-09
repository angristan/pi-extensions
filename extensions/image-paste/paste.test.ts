import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bracketedPasteContent, imageToken, parsePastedImages, PI_CLIPBOARD_PATH, referencedLabels, sniffImageMime, splitPastedPaths } from "./paste.ts";
import { layoutSlots } from "./strip.ts";

const dir = mkdtempSync(join(tmpdir(), "image-paste-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const png = join(dir, "shot one.png");
const jpg = join(dir, "photo.jpg");
const text = join(dir, "notes.png");
writeFileSync(png, PNG);
writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]));
writeFileSync(text, "not an image");

test("sniffs supported formats from magic bytes", () => {
	expect(sniffImageMime(PNG)).toBe("image/png");
	expect(sniffImageMime(Buffer.from("RIFF0000WEBP"))).toBe("image/webp");
	expect(sniffImageMime(Buffer.from("GIF89a"))).toBe("image/gif");
	expect(sniffImageMime(Buffer.from("hello"))).toBeUndefined();
});

test("splits quoted, escaped and multi-line pasted paths", () => {
	expect(splitPastedPaths(`'/a b.png' "/c d.png" /e\\ f.png\n/g.png`)).toEqual(["/a b.png", "/c d.png", "/e f.png", "/g.png"]);
	expect(splitPastedPaths(`'/unterminated`)).toBeUndefined();
});

test("accepts pastes made only of image files", () => {
	const herdr = parsePastedImages(`${png.replace(" ", "\\ ")} '${jpg}' `, "/");
	expect(herdr?.map((image) => image.mimeType)).toEqual(["image/png", "image/jpeg"]);
	expect(parsePastedImages(pathToFileURL(png).href, "/")?.[0]?.path).toBe(png);
	expect(parsePastedImages("photo.jpg", dir)?.[0]?.path).toBe(jpg);
});

test("leaves ordinary text, non-images and mixed pastes alone", () => {
	expect(parsePastedImages("hello world", dir)).toBeUndefined();
	expect(parsePastedImages(text, dir)).toBeUndefined();
	expect(parsePastedImages(`${jpg} and more`, dir)).toBeUndefined();
	expect(parsePastedImages(join(dir, "missing.png"), dir)).toBeUndefined();
});

test("unwraps exactly one bracketed paste", () => {
	expect(bracketedPasteContent("\x1b[200~/tmp/a.png\x1b[201~")).toBe("/tmp/a.png");
	expect(bracketedPasteContent("a")).toBeUndefined();
	expect(bracketedPasteContent("\x1b[200~a\x1b[201~\x1b[200~b\x1b[201~")).toBeUndefined();
});

test("finds referenced labels once, in order", () => {
	expect(referencedLabels(`toto ${imageToken(2)} tata ${imageToken(1)} ${imageToken(2)} [Image x]`)).toEqual([2, 1]);
});

test("recognizes Pi's temporary clipboard image paths", () => {
	const path = "/tmp/pi-clipboard-0b4c6a3e-2f7d-4c5e-9a1b-3c2d1e0f9a8b.png";
	expect(`see ${path} now`.replace(PI_CLIPBOARD_PATH, "[Image 1]")).toBe("see [Image 1] now");
	expect("/tmp/other.png".replace(PI_CLIPBOARD_PATH, "x")).toBe("/tmp/other.png");
});

test("lays thumbnails out left to right and reports overflow", () => {
	const all = layoutSlots([20, 4, 30], 100);
	expect(all.slots.map((slot) => [slot.start, slot.columns])).toEqual([[0, 20], [22, 4], [28, 30]]);
	expect(all.hidden).toBe(0);
	const narrow = layoutSlots([20, 20, 20], 50);
	expect(narrow.slots.length).toBe(2);
	expect(narrow.hidden).toBe(1);
	expect(narrow.columns).toBeLessThanOrEqual(50);
});
