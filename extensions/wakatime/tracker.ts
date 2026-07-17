/**
 * Dependency graph:
 * Direct: `./heartbeat.js`, `node:fs/promises`, `node:path`.
 * Used by: `extensions/wakatime/index.ts`, `extensions/wakatime/tracker.test.ts`.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Heartbeat } from "./heartbeat.js";

interface Snapshot {
	absolutePath: string;
	existed: boolean;
	lineCount: number;
}

interface PendingActivity {
	entity: string;
	baseline?: Snapshot;
	mutated: boolean;
}

function normalizePath(cwd: string, inputPath: string): string {
	const normalized = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

async function snapshot(
	cwd: string,
	inputPath: string,
): Promise<Snapshot | undefined> {
	const absolutePath = normalizePath(cwd, inputPath);
	try {
		const content = await readFile(absolutePath, "utf8");
		return { absolutePath, existed: true, lineCount: countLines(content) };
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? error.code
				: undefined;
		if (code === "ENOENT")
			return { absolutePath, existed: false, lineCount: 0 };
		return undefined;
	}
}

export function countLines(content: string): number {
	if (content.length === 0) return 0;
	const newlines = content.match(/\n/g)?.length ?? 0;
	return content.endsWith("\n") ? newlines : newlines + 1;
}

export class ActivityTracker {
	private mutationSnapshots = new Map<string, Snapshot | undefined>();
	private pending = new Map<string, PendingActivity>();

	async beginMutation(
		toolCallId: string,
		cwd: string,
		inputPath: string,
	): Promise<void> {
		this.mutationSnapshots.set(toolCallId, await snapshot(cwd, inputPath));
	}

	completeMutation(
		toolCallId: string,
		cwd: string,
		inputPath: string,
		succeeded: boolean,
	): void {
		const baseline = this.mutationSnapshots.get(toolCallId);
		this.mutationSnapshots.delete(toolCallId);
		if (!succeeded) return;

		const entity = normalizePath(cwd, inputPath);
		const current = this.pending.get(entity);
		let firstBaseline = current?.mutated ? current.baseline : undefined;
		if (!current?.mutated && baseline?.absolutePath === entity)
			firstBaseline = baseline;
		this.pending.set(entity, {
			entity,
			baseline: firstBaseline,
			mutated: true,
		});
	}

	trackRead(cwd: string, inputPath: string): void {
		const entity = normalizePath(cwd, inputPath);
		if (this.pending.has(entity)) return;
		this.pending.set(entity, { entity, mutated: false });
	}

	hasPending(): boolean {
		return this.pending.size > 0;
	}

	async drain(projectFolder: string): Promise<Heartbeat[]> {
		const batch = this.pending;
		this.pending = new Map();
		const heartbeats: Heartbeat[] = [];

		for (const activity of batch.values()) {
			if (!activity.mutated || !activity.baseline) {
				heartbeats.push({ entity: activity.entity, projectFolder });
				continue;
			}

			try {
				const current = await readFile(activity.entity, "utf8");
				heartbeats.push({
					entity: activity.entity,
					projectFolder,
					lineChanges: countLines(current) - activity.baseline.lineCount,
					isWrite: !activity.baseline.existed,
				});
			} catch {
				heartbeats.push({ entity: activity.entity, projectFolder });
			}
		}

		return heartbeats;
	}

	clear(): void {
		this.mutationSnapshots.clear();
		this.pending.clear();
	}
}
