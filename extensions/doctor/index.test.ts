import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDoctorReport,
	countReportIssues,
	discoverExtensionEntries,
	extractRecentIssues,
	findDuplicateRegistrations,
} from "./index";

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

test("headline issue counts match every rendered report item", () => {
	const statsKey = Symbol.for("pi.renderer-cache.stats");
	const root = globalThis as any;
	const previousStats = root[statsKey];
	root[statsKey] = { test: { renderCalls: 1 } };
	try {
		const snapshot = {
			agentDir: "/tmp/pi-agent",
			extensions: [],
			runtimeLoadedFiles: [],
			passiveOrUnverifiedFiles: [],
			activeTools: [],
			duplicates: [],
			settings: {},
			missingEnabledModels: [],
			unauthenticatedEnabledModels: ["provider/model"],
			defaultModelResolved: false,
			defaultModelAuthenticated: false,
			availableModels: 0,
			totalModels: 0,
			providers: [],
			startupIssues: [],
			foundryIssues: [],
			missingFeatureFiles: [],
			notificationsEnabled: false,
			session: {
				id: "session",
				entries: 0,
				branchEntries: 0,
				contextEntries: 0,
				messages: 0,
			},
		};
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const report = buildDoctorReport(snapshot, {} as any, theme);
		const counts = countReportIssues(report.items);

		expect(counts.errors).toBe(5);
		expect(counts.warnings).toBeGreaterThanOrEqual(3);
		expect(report.lines.filter((line) => line.startsWith("× "))).toHaveLength(counts.errors);
		expect(report.lines.filter((line) => line.startsWith("! "))).toHaveLength(counts.warnings);
		expect(report.items).toContainEqual(expect.objectContaining({ status: "error", label: "0 discovered extension entries" }));
		expect(report.items).toContainEqual(expect.objectContaining({ status: "warning", label: "Enabled model lacks configured auth provider/model" }));
	} finally {
		if (previousStats === undefined) delete root[statsKey];
		else root[statsKey] = previousStats;
	}
});
