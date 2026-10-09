import { expect, test } from "bun:test";
import { join } from "node:path";

test("pasted images become atomic tokens, configurable thumbnails, attachments and a viewer in a real session", async () => {
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "runtime.integration-fixture.ts")], { stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	expect(code, stderr).toBe(0);
	expect(stdout.trim()).toBe("pasted image tokens, thumbnails, attachments, viewer and settings verified");
}, 30_000);
