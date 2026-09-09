import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { isPtySupported, spawnTerminal } from "./terminal-process";

test.skipIf(process.platform !== "linux")("finds and executes script from PATH", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-pty-path-"));
	const previous = process.env.PATH;
	try {
		const executable = join(directory, "script");
		await writeFile(executable, `#!${process.execPath}\nconsole.log("selected PATH script");\n`);
		await chmod(executable, 0o755);
		process.env.PATH = `${directory}${delimiter}${previous ?? ""}`;
		expect(isPtySupported()).toBe(true);
		let output = "";
		const child = spawnTerminal({
			command: "printf wrong-helper", cwd: directory, tty: true,
			onStdout: (chunk) => { output += chunk.toString(); }, onStderr() {}, onPtyPid() {},
		});
		child.stdin?.end();
		const exitCode = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
		expect(exitCode).toBe(0);
		expect(output).toContain("selected PATH script");
	} finally {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
		await rm(directory, { recursive: true, force: true });
	}
});

test.skipIf(process.platform !== "linux")("rejects non-executable files and directories named script", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-pty-missing-"));
	const previous = process.env.PATH;
	try {
		await writeFile(join(directory, "script"), "not executable", { mode: 0o600 });
		const other = join(directory, "other");
		await mkdir(join(other, "script"), { recursive: true });
		process.env.PATH = [directory, other].join(delimiter);
		expect(isPtySupported()).toBe(false);
	} finally {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
		await rm(directory, { recursive: true, force: true });
	}
});
