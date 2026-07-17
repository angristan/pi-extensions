import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

const PTY_PID_MARKER = "__PI_BACKGROUND_PTY_PID__";

export interface TerminalSpawnOptions {
	command: string;
	cwd: string;
	tty: boolean;
	onStdout: (chunk: Buffer) => void;
	onStderr: (chunk: Buffer) => void;
	onPtyPid: (pid: number) => void;
}

class PidMarkerFilter {
	private pending = "";
	private resolved = false;

	constructor(
		private readonly onData: (chunk: Buffer) => void,
		private readonly onPid: (pid: number) => void,
	) {}

	push(chunk: Buffer): void {
		if (this.resolved) {
			this.onData(chunk);
			return;
		}
		this.pending += chunk.toString("utf8");
		const newline = this.pending.indexOf("\n");
		if (newline < 0 && this.pending.length < 1024) return;
		const lineEnd = newline >= 0 ? newline : this.pending.length;
		const firstLine = this.pending.slice(0, lineEnd).replace(/\r$/, "");
		const match = firstLine.match(new RegExp(`^${PTY_PID_MARKER}(\\d+)$`));
		this.resolved = true;
		if (match) {
			this.onPid(Number.parseInt(match[1]!, 10));
			const remainder = this.pending.slice(newline >= 0 ? newline + 1 : lineEnd);
			if (remainder) this.onData(Buffer.from(remainder));
		} else {
			this.onData(Buffer.from(this.pending));
		}
		this.pending = "";
	}

	flush(): void {
		if (this.pending) this.onData(Buffer.from(this.pending));
		this.pending = "";
		this.resolved = true;
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function linuxScriptPath(): string | undefined {
	if (existsSync("/usr/bin/script")) return "/usr/bin/script";
	if (existsSync("/bin/script")) return "/bin/script";
	return undefined;
}

export function isPtySupported(): boolean {
	if (process.platform === "darwin") return existsSync("/usr/bin/expect");
	if (process.platform === "linux") return linuxScriptPath() !== undefined;
	return false;
}

export function spawnTerminal(options: TerminalSpawnOptions): ChildProcess {
	const shell = getShellConfig();
	const env = { ...process.env };
	let child: ChildProcess;
	let markerFilter: PidMarkerFilter | undefined;

	if (!options.tty) {
		child = spawn(shell.shell, [...shell.args, options.command], {
			cwd: options.cwd,
			env,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stdout?.on("data", options.onStdout);
		child.stderr?.on("data", options.onStderr);
		return child;
	}

	if (process.platform === "darwin" && existsSync("/usr/bin/expect")) {
		const expectProgram = [
			"set timeout -1",
			"spawn -noecho $env(PI_BACKGROUND_SHELL) -lc $env(PI_BACKGROUND_COMMAND)",
			`puts stderr \"${PTY_PID_MARKER}[exp_pid]\"`,
			"flush stderr",
			"trap {catch {exec /bin/kill -TERM -- -[exp_pid]}; exit 143} SIGTERM",
			"interact",
			"catch wait result",
			"exit [lindex $result 3]",
		].join("; ");
		markerFilter = new PidMarkerFilter(options.onStderr, options.onPtyPid);
		child = spawn("/usr/bin/expect", ["-c", expectProgram], {
			cwd: options.cwd,
			env: {
				...env,
				PI_BACKGROUND_SHELL: shell.shell,
				PI_BACKGROUND_COMMAND: options.command,
			},
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout?.on("data", options.onStdout);
		child.stderr?.on("data", (chunk: Buffer) => markerFilter?.push(chunk));
	} else if (process.platform === "linux" && linuxScriptPath()) {
		const script = linuxScriptPath()!;
		const wrapped = `printf '${PTY_PID_MARKER}%s\\n' \"$$\"; exec ${shellQuote(shell.shell)} -lc ${shellQuote(options.command)}`;
		markerFilter = new PidMarkerFilter(options.onStdout, options.onPtyPid);
		child = spawn(script, ["-q", "-e", "-f", "-c", wrapped, "/dev/null"], {
			cwd: options.cwd,
			env,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout?.on("data", (chunk: Buffer) => markerFilter?.push(chunk));
		child.stderr?.on("data", options.onStderr);
	} else {
		throw new Error("PTY mode is unavailable on this platform (requires expect on macOS or script on Linux)");
	}

	child.once("close", () => markerFilter?.flush());
	return child;
}
