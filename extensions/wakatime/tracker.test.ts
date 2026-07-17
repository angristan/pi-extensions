import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityTracker, countLines } from "./tracker";

const temporaryDirectories: string[] = [];

function temporaryProject(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-wakatime-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("countLines", () => {
	test("handles empty and newline-terminated content", () => {
		expect(countLines("")).toBe(0);
		expect(countLines("one")).toBe(1);
		expect(countLines("one\ntwo\n")).toBe(2);
	});
});

describe("ActivityTracker", () => {
	test("tracks successful reads", async () => {
		const project = temporaryProject();
		const tracker = new ActivityTracker();
		tracker.trackRead(project, "README.md");

		expect(await tracker.drain(project)).toEqual([
			{ entity: join(project, "README.md"), projectFolder: project },
		]);
	});

	test("reports net line changes for an edit", async () => {
		const project = temporaryProject();
		const file = join(project, "index.ts");
		writeFileSync(file, "one\n");
		const tracker = new ActivityTracker();
		await tracker.beginMutation("edit-1", project, "index.ts");
		writeFileSync(file, "one\ntwo\nthree\n");
		tracker.completeMutation("edit-1", project, "index.ts", true);

		expect(await tracker.drain(project)).toEqual([
			{
				entity: file,
				projectFolder: project,
				lineChanges: 2,
				isWrite: false,
			},
		]);
	});

	test("marks newly written files", async () => {
		const project = temporaryProject();
		const file = join(project, "new.ts");
		const tracker = new ActivityTracker();
		await tracker.beginMutation("write-1", project, "@new.ts");
		writeFileSync(file, "one\ntwo\n");
		tracker.completeMutation("write-1", project, "@new.ts", true);

		expect(await tracker.drain(project)).toEqual([
			{
				entity: file,
				projectFolder: project,
				lineChanges: 2,
				isWrite: true,
			},
		]);
	});

	test("aggregates parallel mutations from the original baseline", async () => {
		const project = temporaryProject();
		const file = join(project, "parallel.ts");
		writeFileSync(file, "one\n");
		const tracker = new ActivityTracker();
		await Promise.all([
			tracker.beginMutation("edit-1", project, "parallel.ts"),
			tracker.beginMutation("edit-2", project, "parallel.ts"),
		]);
		writeFileSync(file, "one\ntwo\nthree\n");
		tracker.completeMutation("edit-1", project, "parallel.ts", true);
		tracker.completeMutation("edit-2", project, "parallel.ts", true);

		const heartbeats = await tracker.drain(project);
		expect(heartbeats).toHaveLength(1);
		expect(heartbeats[0]?.lineChanges).toBe(2);
	});

	test("ignores failed mutations", async () => {
		const project = temporaryProject();
		const tracker = new ActivityTracker();
		await tracker.beginMutation("edit-1", project, "missing.ts");
		tracker.completeMutation("edit-1", project, "missing.ts", false);
		expect(tracker.hasPending()).toBe(false);
	});
});
