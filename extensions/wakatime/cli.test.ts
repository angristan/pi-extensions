import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executableNames, findExecutableOnPath } from "./cli";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("findExecutableOnPath", () => {
	test("finds an executable without installing anything", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-wakatime-"));
		temporaryDirectories.push(directory);
		const executable = join(directory, "wakatime-cli");
		writeFileSync(executable, "#!/bin/sh\nexit 0\n");
		chmodSync(executable, 0o755);

		expect(
			findExecutableOnPath("wakatime-cli", { PATH: directory }, "linux"),
		).toBe(executable);
	});

	test("returns undefined when PATH has no CLI", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-wakatime-"));
		temporaryDirectories.push(directory);
		expect(
			findExecutableOnPath("wakatime-cli", { PATH: directory }, "linux"),
		).toBeUndefined();
	});

	test("uses PATHEXT on Windows", () => {
		expect(executableNames("wakatime-cli", "win32", ".EXE;.CMD")).toEqual([
			"wakatime-cli.EXE",
			"wakatime-cli.CMD",
		]);
	});
});
