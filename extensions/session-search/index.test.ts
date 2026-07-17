import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionSearchArgs, scanSession, scoreSearchText } from "./index";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("parses quoted queries and project scope flags", () => {
	expect(parseSessionSearchArgs('--current "cache invalidation" bug')).toEqual({ query: "cache invalidation bug", scope: "current" });
	expect(parseSessionSearchArgs("--all deploy")).toEqual({ query: "deploy", scope: "all" });
});

test("rewards exact phrases while requiring every query term", () => {
	const exact = scoreSearchText("alpha beta appears twice: alpha beta", "alpha beta");
	const split = scoreSearchText("alpha then much later beta", "alpha beta");
	expect(exact.score).toBeGreaterThan(split.score);
	expect(split.matchedTerms).toEqual(new Set(["alpha", "beta"]));
});

test("scans session JSONL and returns the best matching entry", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-search-"));
	roots.push(root);
	const path = join(root, "session.jsonl");
	await writeFile(path, [
		JSON.stringify({ type: "session", id: "session-1", cwd: "/tmp/project" }),
		JSON.stringify({ id: "answer-1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "The alpha beta fix is in the router." }] } }),
		"not valid json",
	].join("\n"));
	const session: any = {
		id: "session-1",
		path,
		cwd: "/tmp/project",
		name: "Router work",
		firstMessage: "Investigate issue",
		modified: new Date("2026-01-01T00:00:00Z"),
	};

	const result = await scanSession(session, "alpha beta");
	expect(result).toMatchObject({ entryId: "answer-1", entryLabel: "assistant message", truncated: false });
	expect(result?.snippet).toContain("alpha beta");
	expect(await scanSession(session, "alpha missing")).toBeUndefined();
});
