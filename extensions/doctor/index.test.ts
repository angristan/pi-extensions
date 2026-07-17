import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverExtensionEntries, extractRecentIssues, findDuplicateRegistrations } from "./index";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("discovers only loadable extension entrypoints", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-doctor-test-"));
	roots.push(root);
	await writeFile(join(root, "single.ts"), "export default () => {}\n");
	await writeFile(join(root, "types.d.ts"), "export {};\n");
	await mkdir(join(root, "package"));
	await writeFile(join(root, "package", "index.ts"), "export default () => {}\n");
	await mkdir(join(root, "support"));

	const entries = await discoverExtensionEntries(root);
	expect(entries.map((entry) => [entry.name, entry.kind])).toEqual([
		["package/index.ts", "package"],
		["single.ts", "file"],
	]);
});

test("finds duplicate commands and shortcuts without conflating their kinds", () => {
	const duplicates = findDuplicateRegistrations([
		{ file: "a.ts", source: 'pi.registerCommand("doctor", {}); pi.registerShortcut("ctrl+x", {});' },
		{ file: "b.ts", source: 'pi.registerCommand("doctor", {}); pi.registerShortcut("ctrl+x", {});' },
		{ file: "c.ts", source: 'pi.registerShortcut("doctor", {});' },
	]);

	expect(duplicates).toEqual([
		{ kind: "command", name: "doctor", files: ["a.ts", "b.ts"] },
		{ kind: "shortcut", name: "ctrl+x", files: ["a.ts", "b.ts"] },
	]);
});

test("deduplicates and classifies recent startup and provider evidence", () => {
	const issues = extractRecentIssues([
		"\x1b[31mFailed to load extension foo\x1b[0m",
		"Failed to load extension foo",
		"Foundry OpenAI error: HTTP 429 rate limit",
	]);
	expect(issues.startup).toEqual(["Failed to load extension foo"]);
	expect(issues.foundry).toEqual(["Foundry OpenAI error: HTTP 429 rate limit"]);
});
