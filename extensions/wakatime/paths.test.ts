/**
 * Dependency graph:
 * Direct: `./paths`, `bun:test`, `node:os`, `node:path`.
 * Used by: `Bun test runner`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { getWakatimeResourcesDir } from "./paths";

const originalWakatimeHome = process.env.WAKATIME_HOME;

afterEach(() => {
	if (originalWakatimeHome === undefined) delete process.env.WAKATIME_HOME;
	else process.env.WAKATIME_HOME = originalWakatimeHome;
});

describe("getWakatimeResourcesDir", () => {
	test("uses the standard WakaTime resource directory", () => {
		delete process.env.WAKATIME_HOME;
		expect(getWakatimeResourcesDir()).toBe(join(homedir(), ".wakatime"));
	});

	test("honors and expands WAKATIME_HOME", () => {
		process.env.WAKATIME_HOME = "/tmp/custom-wakatime";
		expect(getWakatimeResourcesDir()).toBe("/tmp/custom-wakatime");

		process.env.WAKATIME_HOME = "~/custom-wakatime";
		expect(getWakatimeResourcesDir()).toBe(join(homedir(), "custom-wakatime"));
	});
});
