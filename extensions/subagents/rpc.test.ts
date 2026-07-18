import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcProcessClient } from "./rpc";

const directories: string[] = [];
const cleanupPids = new Set<number>();

afterEach(async () => {
	for (const pid of cleanupPids) {
		try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
	}
	cleanupPids.clear();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function processExists(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

test("speaks strict JSONL RPC and cancels child dialogs without hanging", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-rpc-test-"));
	directories.push(directory);
	const script = join(directory, "fake-rpc.mjs");
	await writeFile(script, `
let buffer = "";
let pendingState;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === "get_state") {
      pendingState = message;
      process.stdout.write("null\\n");
      process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "confirm-1", method: "confirm", title: "Confirm", message: "Continue?" }) + "\\n");
    } else if (message.type === "extension_ui_response") {
      if (message.id !== "confirm-1" || message.confirmed !== false) process.exit(12);
      process.stdout.write(JSON.stringify({ type: "response", id: pendingState.id, command: "get_state", success: true, data: { isStreaming: false } }) + "\\n");
    } else if (message.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "response", id: message.id, command: "prompt", success: true }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "left right" }] } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
  }
});
`, "utf8");

	const client = new RpcProcessClient({ command: process.execPath, args: [script], cwd: directory });
	const events: any[] = [];
	client.onEvent((event) => events.push(event));
	await client.start();
	await client.prompt("hello");
	for (let attempt = 0; attempt < 100 && !events.some((event) => event.type === "agent_settled"); attempt += 1) {
		await Bun.sleep(5);
	}
	expect(events.some((event) => event.type === "agent_settled")).toBe(true);
	expect(events.find((event) => event.type === "message_end")?.message.content[0].text).toBe("left right");
	await client.stop();
});

test("stops a live child when RPC startup is rejected", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-rpc-startup-"));
	directories.push(directory);
	const pidFile = join(directory, "pid");
	const script = join(directory, "reject-rpc.mjs");
	await writeFile(script, `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  const message = JSON.parse(buffer.slice(0, newline));
  process.stdout.write(JSON.stringify({ type: "response", id: message.id, command: "get_state", success: false, error: "startup rejected" }) + "\\n");
});
setInterval(() => {}, 1000);
`, "utf8");
	const client = new RpcProcessClient({ command: process.execPath, args: [script], cwd: directory });
	await expect(client.start()).rejects.toThrow("startup rejected");
	const pid = Number(await Bun.file(pidFile).text());
	expect(processExists(pid)).toBe(false);
});

test("rejects oversized RPC records and reaps the offending child", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-rpc-oversized-"));
	directories.push(directory);
	const pidFile = join(directory, "pid");
	const script = join(directory, "oversized-rpc.mjs");
	await writeFile(script, `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.once("data", () => {
  process.stdout.write("x".repeat(2 * 1024 * 1024 + 1));
});
setInterval(() => {}, 1000);
`, "utf8");
	const client = new RpcProcessClient({ command: process.execPath, args: [script], cwd: directory });
	await expect(client.start()).rejects.toThrow("RPC record exceeded");
	const pid = Number(await Bun.file(pidFile).text());
	expect(processExists(pid)).toBe(false);
}, 5_000);

test("keeps stderr inside its advertised byte limit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-rpc-stderr-"));
	directories.push(directory);
	const script = join(directory, "stderr-rpc.mjs");
	await writeFile(script, `
process.stderr.write("é".repeat(20_000));
process.stdin.once("data", (chunk) => {
  const message = JSON.parse(String(chunk).trim());
  process.stdout.write(JSON.stringify({ type: "response", id: message.id, command: message.type, success: true, data: {} }) + "\\n");
});
setInterval(() => {}, 1000);
`, "utf8");
	const client = new RpcProcessClient({ command: process.execPath, args: [script], cwd: directory });
	await client.start();
	for (let attempt = 0; attempt < 100 && !client.getStderr().includes("earlier stderr omitted"); attempt += 1) await Bun.sleep(5);
	expect(client.getStderr()).toStartWith("[earlier stderr omitted]\n");
	expect(Buffer.byteLength(client.getStderr())).toBeLessThanOrEqual(16 * 1024);
	await client.stop();
});

test("waits for SIGKILL to close a child that ignores SIGTERM", async () => {
	if (process.platform === "win32") return;
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-rpc-kill-"));
	directories.push(directory);
	const script = join(directory, "stubborn-rpc.mjs");
	await writeFile(script, `
process.on("SIGTERM", () => {});
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  const message = JSON.parse(buffer.slice(0, newline));
  process.stdout.write(JSON.stringify({ type: "response", id: message.id, command: message.type, success: true, data: {} }) + "\\n");
});
setInterval(() => {}, 1000);
`, "utf8");
	const client = new RpcProcessClient({ command: process.execPath, args: [script], cwd: directory });
	await client.start();
	const pid = client.pid!;
	cleanupPids.add(pid);
	await client.stop();
	expect(processExists(pid)).toBe(false);
	cleanupPids.delete(pid);
}, 4_000);
