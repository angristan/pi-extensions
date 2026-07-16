import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHeartbeatArgs, sendHeartbeat } from "./heartbeat";

const temporaryDirectories: string[] = [];

afterEach(() => {
	delete process.env.PI_WAKATIME_CAPTURE;
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("buildHeartbeatArgs", () => {
	test("builds an AI coding heartbeat", () => {
		const args = buildHeartbeatArgs(
			{
				entity: "/project/src/index.ts",
				projectFolder: "/project",
				lineChanges: 4,
				isWrite: true,
			},
			"1.2.3",
		);

		expect(args).toContain("--entity");
		expect(args).toContain("/project/src/index.ts");
		expect(args).toContain("ai coding");
		expect(args).toContain("--ai-line-changes");
		expect(args).toContain("4");
		expect(args).toContain("--write");
		expect(args).toContain("--sync-ai-disabled");
		expect(
			args.slice(args.indexOf("--timeout"), args.indexOf("--timeout") + 2),
		).toEqual(["--timeout", "10"]);
		expect(
			args.find((argument) => argument.includes("pi-wakatime/")),
		).toStartWith("pi/");
	});

	test("omits zero line changes and write state", () => {
		const args = buildHeartbeatArgs(
			{
				entity: "/project/README.md",
				projectFolder: "/project",
				lineChanges: 0,
			},
			"1.2.3",
		);

		expect(args).not.toContain("--ai-line-changes");
		expect(args).not.toContain("--write");
	});

	test("executes only the supplied CLI path", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-wakatime-"));
		temporaryDirectories.push(directory);
		const cliPath = join(directory, "wakatime-cli");
		const capturePath = join(directory, "args.txt");
		writeFileSync(
			cliPath,
			'#!/bin/sh\nprintf \'%s\\n\' "$@" > "$PI_WAKATIME_CAPTURE"\n',
		);
		chmodSync(cliPath, 0o755);
		process.env.PI_WAKATIME_CAPTURE = capturePath;

		const result = await sendHeartbeat(
			cliPath,
			{
				entity: "/project/index.ts",
				projectFolder: "/project",
			},
			"1.2.3",
		);

		expect(result).toEqual({ ok: true });
		expect(readFileSync(capturePath, "utf8")).toContain("/project/index.ts");
	});
});
