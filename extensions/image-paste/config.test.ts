import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, hexForeground, parseColor, parseRows, readSettings, thumbnailRows, writeSettings } from "./config.ts";

const dir = mkdtempSync(join(tmpdir(), "image-paste-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("missing or invalid values fall back to defaults", () => {
	expect(readSettings(join(dir, "missing.json"))).toEqual(DEFAULT_SETTINGS);
	const path = join(dir, "mixed.json");
	writeFileSync(path, JSON.stringify({ promptPreview: false, transcriptPreview: "no", previewRows: 99 }));
	expect(readSettings(path)).toEqual({ ...DEFAULT_SETTINGS, promptPreview: false });
});

test("rows accept auto or a bounded integer, and auto follows OpenCode's sizing", () => {
	expect([parseRows("auto"), parseRows("6"), parseRows(6), parseRows("1"), parseRows("17"), parseRows("6.5")]).toEqual(["auto", 6, 6, undefined, undefined, undefined]);
	expect([thumbnailRows("auto", 12), thumbnailRows("auto", 24), thumbnailRows("auto", 60), thumbnailRows(3, 60)]).toEqual([4, 6, 8, 3]);
});

test("token colors accept theme color names or #rrggbb", () => {
	expect([parseColor("bashMode"), parseColor("#FE8019"), parseColor("#fff"), parseColor("red;"), parseColor(3)]).toEqual(["bashMode", "#fe8019", undefined, undefined, undefined]);
	expect(hexForeground("#fe8019")).toBe("\x1b[38;2;254;128;25m");
});

test("writes keep unrelated keys and refuse to replace malformed files", () => {
	const path = join(dir, "nested", "settings.json");
	writeSettings(path, { promptPreview: false });
	writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), note: "keep" }));
	writeSettings(path, { previewRows: 5 });
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ promptPreview: false, note: "keep", previewRows: 5 });

	const broken = join(dir, "broken.json");
	writeFileSync(broken, "{ not json");
	expect(() => writeSettings(broken, { promptPreview: false })).toThrow(/Repair it/);
	expect(readFileSync(broken, "utf8")).toBe("{ not json");
	expect(readSettings(broken)).toEqual(DEFAULT_SETTINGS);
});
