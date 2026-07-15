import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ExtensionAPI, SessionInfo } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_RESULTS = 100;
const SEARCH_CONCURRENCY = 6;

export interface SessionSearchResult {
	session: SessionInfo;
	score: number;
	snippet: string;
	entryId?: string;
	entryLabel?: string;
	truncated: boolean;
}

interface SearchFragment {
	text: string;
	label: string;
	entryId?: string;
}

interface ParsedSearchArgs {
	query: string;
	scope: "all" | "current";
}

function normalize(text: string): string {
	return text.toLocaleLowerCase();
}

function compactPath(path: string, home = process.env.HOME ?? ""): string {
	return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

function stripDisplayMetadata(text: string): string {
	return text
		.replace(/<!-- pi:web-search(?:-(?:query(?:-count)?|source(?:-count)?))?:[^>]* -->/gi, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function compactText(text: string, limit: number): string {
	const normalized = stripDisplayMetadata(text).replace(/\s+/g, " ").trim();
	return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function contentText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (typeof item?.text === "string") parts.push(stripDisplayMetadata(item.text));
		if (typeof item?.thinking === "string") parts.push(stripDisplayMetadata(item.thinking));
		if (item?.type === "toolCall") {
			let args = "";
			try { args = JSON.stringify(item.arguments ?? {}); } catch { args = String(item.arguments ?? ""); }
			parts.push(`${item.name ?? "tool"} ${args}`);
		}
		if (item?.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

function entryFragments(entry: any): SearchFragment[] {
	if (entry?.type === "session") return [{ text: `${entry.id ?? ""}\n${entry.cwd ?? ""}`, label: "session header" }];
	if (entry?.type === "session_info") return [{ text: String(entry.name ?? ""), label: "session title", entryId: entry.id }];
	if (entry?.type === "compaction") return [{ text: String(entry.summary ?? ""), label: "compaction summary", entryId: entry.id }];
	if (entry?.type === "branch_summary") return [{ text: String(entry.summary ?? ""), label: "branch summary", entryId: entry.id }];
	if (entry?.type === "custom_message") return [{ text: contentText(entry.content), label: `custom message ${entry.customType ?? ""}`.trim(), entryId: entry.id }];
	if (entry?.type !== "message") return [];

	const message = entry.message ?? {};
	const fragments: SearchFragment[] = [];
	const text = contentText(message.content);
	if (text) {
		const label = message.role === "toolResult"
			? `${message.toolName ?? "tool"} result`
			: `${message.role ?? "message"} message`;
		fragments.push({ text, label, entryId: entry.id });
	}
	if (typeof message.errorMessage === "string") fragments.push({ text: message.errorMessage, label: "assistant error", entryId: entry.id });
	if (message.role === "toolResult" && message.toolName) fragments.push({ text: String(message.toolName), label: `${message.toolName} result`, entryId: entry.id });
	return fragments;
}

function queryTerms(query: string): string[] {
	return [...new Set(normalize(query).split(/\s+/).filter(Boolean))];
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let offset = 0;
	while ((offset = haystack.indexOf(needle, offset)) >= 0) {
		count += 1;
		offset += Math.max(1, needle.length);
	}
	return count;
}

export function scoreSearchText(text: string, query: string): { score: number; matchedTerms: Set<string> } {
	const haystack = normalize(text);
	const phrase = normalize(query.trim());
	const terms = queryTerms(query);
	const matchedTerms = new Set<string>();
	let score = countOccurrences(haystack, phrase) * 20;
	for (const term of terms) {
		const count = countOccurrences(haystack, term);
		if (count > 0) {
			matchedTerms.add(term);
			score += Math.min(10, count);
		}
	}
	return { score, matchedTerms };
}

function snippetAround(text: string, query: string, radius = 110): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) return "(empty match)";
	const lower = normalize(compact);
	const phrase = normalize(query.trim());
	let index = lower.indexOf(phrase);
	if (index < 0) {
		for (const term of queryTerms(query)) {
			index = lower.indexOf(term);
			if (index >= 0) break;
		}
	}
	if (index < 0) return compactText(compact, radius * 2);
	const start = Math.max(0, index - radius);
	const end = Math.min(compact.length, index + Math.max(phrase.length, 1) + radius);
	return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
}

export function parseSessionSearchArgs(args: string): ParsedSearchArgs {
	const tokens = args.trim().match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
	let scope: ParsedSearchArgs["scope"] = "all";
	const query: string[] = [];
	for (const token of tokens) {
		if (token === "--current" || token === "--project") scope = "current";
		else if (token === "--all") scope = "all";
		else query.push(token);
	}
	return { query: query.join(" ").trim(), scope };
}

export async function scanSession(session: SessionInfo, query: string): Promise<SessionSearchResult | undefined> {
	const terms = queryTerms(query);
	const foundTerms = new Set<string>();
	let score = 0;
	let bestScore = -1;
	let bestFragment: SearchFragment | undefined;
	let consumedBytes = 0;
	let truncated = false;

	const metadataFragments: SearchFragment[] = [
		{ text: session.name ?? "", label: "session title" },
		{ text: session.cwd, label: "working directory" },
		{ text: session.id, label: "session id" },
		{ text: session.firstMessage, label: "first user message" },
	];
	for (const fragment of metadataFragments) {
		const result = scoreSearchText(fragment.text, query);
		for (const term of result.matchedTerms) foundTerms.add(term);
		const weighted = result.score * (fragment.label === "session title" ? 4 : fragment.label === "first user message" ? 2 : 1);
		score += weighted;
		if (weighted > bestScore) {
			bestScore = weighted;
			bestFragment = fragment;
		}
	}

	try {
		const stream = createReadStream(session.path, { encoding: "utf8" });
		const reader = createInterface({ input: stream, crlfDelay: Infinity });
		for await (const line of reader) {
			consumedBytes += Buffer.byteLength(line, "utf8") + 1;
			if (consumedBytes > MAX_FILE_BYTES) {
				truncated = true;
				break;
			}
			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; }
			for (const fragment of entryFragments(entry)) {
				const result = scoreSearchText(fragment.text, query);
				if (result.score <= 0) continue;
				for (const term of result.matchedTerms) foundTerms.add(term);
				const weighted = result.score + (fragment.label.includes("error") ? 5 : fragment.label.includes("tool") || fragment.label.includes("result") ? 2 : 0);
				score += weighted;
				if (weighted > bestScore) {
					bestScore = weighted;
					bestFragment = fragment;
				}
			}
		}
	} catch {
		return undefined;
	}

	if (terms.some((term) => !foundTerms.has(term)) || !bestFragment) return undefined;
	return {
		session,
		score,
		snippet: snippetAround(bestFragment.text, query),
		entryId: bestFragment.entryId,
		entryLabel: bestFragment.label,
		truncated,
	};
}

async function mapConcurrent<T, U>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<U>): Promise<U[]> {
	const results = new Array<U>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

async function copyText(text: string): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	return new Promise<boolean>((resolve) => {
		const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
		child.stdin.end(text);
	});
}

function resultLabel(result: SessionSearchResult): string {
	const date = result.session.modified.toISOString().slice(0, 10);
	const title = compactText(result.session.name || result.session.firstMessage || result.session.id, 70);
	const location = compactText(compactPath(result.session.cwd), 42);
	return `${date} · ${title} · ${location} · ${result.session.id.slice(0, 8)}`;
}

function resultDetails(result: SessionSearchResult): string {
	return [
		result.session.name ? `Title: ${result.session.name}` : undefined,
		`Session: ${result.session.id}`,
		`Project: ${compactPath(result.session.cwd)}`,
		`Modified: ${result.session.modified.toLocaleString()}`,
		`Match: ${result.entryLabel ?? "session metadata"}${result.truncated ? " · file scan capped at 64 MiB" : ""}`,
		"",
		result.snippet,
	].filter((line) => line !== undefined).join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("session-search", {
		description: "Search user, assistant, tool, error, and compaction text across Pi sessions",
		handler: async (args, ctx) => {
			let parsed = parseSessionSearchArgs(args);
			if (!parsed.query) {
				const input = await ctx.ui.input("Search Pi sessions", "keywords, optionally --current");
				if (!input?.trim()) return;
				parsed = parseSessionSearchArgs(input);
			}
			if (!parsed.query) return;

			ctx.ui.setStatus("session-search", ctx.ui.theme.fg("accent", "searching sessions…"));
			try {
				const sessions = await SessionManager.listAll();
				const candidates = parsed.scope === "current"
					? sessions.filter((session) => session.cwd === ctx.cwd)
					: sessions;
				let completed = 0;
				const scanned = await mapConcurrent(candidates, SEARCH_CONCURRENCY, async (session, _index) => {
					const result = await scanSession(session, parsed.query);
					completed += 1;
					if (completed % 8 === 0 || completed === candidates.length) {
						ctx.ui.setStatus("session-search", ctx.ui.theme.fg("accent", `searching ${completed}/${candidates.length}…`));
					}
					return result;
				});
				const results = scanned
					.filter((result): result is SessionSearchResult => Boolean(result))
					.sort((a, b) => b.score - a.score || b.session.modified.getTime() - a.session.modified.getTime())
					.slice(0, MAX_RESULTS);
				if (results.length === 0) {
					ctx.ui.notify(`No ${parsed.scope === "current" ? "current-project " : ""}sessions matched “${parsed.query}”.`, "info");
					return;
				}

				const choices = results.map(resultLabel);
				const selectedLabel = await ctx.ui.select(`Session matches for “${parsed.query}” (${results.length})`, choices);
				if (!selectedLabel) return;
				const selected = results[choices.indexOf(selectedLabel)];
				if (!selected) return;
				const action = await ctx.ui.select(resultDetails(selected), [
					"Resume this session",
					"Fork through the matching entry",
					"Copy matching excerpt",
					"Put excerpt in editor",
					"Cancel",
				]);
				if (!action || action === "Cancel") return;
				if (action === "Resume this session") {
					await ctx.switchSession(selected.session.path, {
						withSession: async (replacementCtx: any) => replacementCtx.ui.notify(`Resumed match for “${parsed.query}”.`, "info"),
					});
					return;
				}
				if (action === "Fork through the matching entry") {
					const source = SessionManager.open(selected.session.path);
					const targetId = selected.entryId && source.getEntry(selected.entryId) ? selected.entryId : source.getLeafId();
					if (!targetId) {
						ctx.ui.notify("The matching session has no forkable entry.", "warning");
						return;
					}
					const forkPath = source.createBranchedSession(targetId);
					if (!forkPath) {
						ctx.ui.notify("Could not create a persisted session fork.", "error");
						return;
					}
					await ctx.switchSession(forkPath, {
						withSession: async (replacementCtx: any) => replacementCtx.ui.notify(`Forked search match from ${selected.session.id.slice(0, 8)}.`, "info"),
					});
					return;
				}
				if (action === "Copy matching excerpt") {
					if (await copyText(selected.snippet)) ctx.ui.notify("Matching excerpt copied.", "info");
					else {
						ctx.ui.setEditorText(selected.snippet);
						ctx.ui.notify("Clipboard backend unavailable; excerpt placed in the editor.", "warning");
					}
					return;
				}
				ctx.ui.setEditorText(selected.snippet);
			} finally {
				ctx.ui.setStatus("session-search", undefined);
			}
		},
	});
}
