export const BASH_SESSION_ENV_GUIDELINE = "Inspect PI_* environment variables for current model and session details.";
export const BASH_MANAGED_TERMINAL_GUIDELINE = "Run long-lived commands in the foreground and let bash yield a managed terminal ID; do not use shell self-backgrounding such as &, nohup, disown, or setsid.";

/**
 * Structured `bash` result for programmatic callers such as codemode scripts,
 * which receive it instead of the model-facing text. Field names match Pi's
 * built-in bash schema, so scripts read `output` and `exit_code` the same way
 * with either tool. A managed command can outlive the yield window: then
 * `exit_code` is absent and `job_id` names the terminal that is still running.
 * Descriptions stay short because codemode declares this schema to the model.
 */
export const MANAGED_BASH_OUTPUT_SCHEMA = {
	type: "object",
	properties: {
		output: { type: "string", description: "Combined stdout and stderr; longer output keeps its last 256 KiB" },
		truncated: { type: "boolean", description: "Whether `output` omits earlier output" },
		exit_code: { type: "number", description: "Absent while the command is still running or after a signal" },
		wall_time_seconds: { type: "number" },
		status: { type: "string", enum: ["running", "stopping", "completed", "failed", "killed", "timed_out"] },
		job_id: { type: "string", description: "Terminal ID while the command is still running" },
	},
	required: ["output", "truncated", "wall_time_seconds", "status"],
} as const;

export interface ManagedBashStructuredResult {
	output: string;
	truncated: boolean;
	exit_code?: number;
	wall_time_seconds: number;
	status: "running" | "stopping" | "completed" | "failed" | "killed" | "timed_out";
	job_id?: string;
}

export interface BackgroundTerminalView {
	details: any;
	output: string;
}

export interface BackgroundTerminalService {
	execute(
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: ((result: any) => void) | undefined,
		ctx: any,
	): Promise<any>;
	getView(id: string, fallback: any, maxOutputBytes: number): BackgroundTerminalView;
	/** Subscribe to live output or status changes. Returns a no-op for historical jobs. */
	subscribe(id: string, listener: () => void): () => void;
	/** Whether the terminal is still live in this session (running or stopping). */
	isActive(id: string): boolean;
}

export interface BetterNativeBashIntegration {
	refresh(service: BackgroundTerminalService | undefined): void;
}

const SERVICE_KEY = Symbol.for("pi.background-terminal.service");
const BETTER_NATIVE_BASH_KEY = Symbol.for("pi.background-terminal.better-native-bash");

type ServiceRegistry = typeof globalThis & {
	[SERVICE_KEY]?: BackgroundTerminalService;
	[BETTER_NATIVE_BASH_KEY]?: BetterNativeBashIntegration;
};

export function setBackgroundTerminalService(service: BackgroundTerminalService): void {
	const registry = globalThis as ServiceRegistry;
	registry[SERVICE_KEY] = service;
	registry[BETTER_NATIVE_BASH_KEY]?.refresh(service);
}

export function getBackgroundTerminalService(): BackgroundTerminalService | undefined {
	return (globalThis as ServiceRegistry)[SERVICE_KEY];
}

export function clearBackgroundTerminalService(service: BackgroundTerminalService): void {
	const registry = globalThis as ServiceRegistry;
	if (registry[SERVICE_KEY] !== service) return;
	delete registry[SERVICE_KEY];
	registry[BETTER_NATIVE_BASH_KEY]?.refresh(undefined);
}

export function setBetterNativeBashIntegration(integration: BetterNativeBashIntegration): void {
	const registry = globalThis as ServiceRegistry;
	registry[BETTER_NATIVE_BASH_KEY] = integration;
	integration.refresh(registry[SERVICE_KEY]);
}

export function hasBetterNativeBashIntegration(): boolean {
	return (globalThis as ServiceRegistry)[BETTER_NATIVE_BASH_KEY] !== undefined;
}

export function clearBetterNativeBashIntegration(integration: BetterNativeBashIntegration): void {
	const registry = globalThis as ServiceRegistry;
	if (registry[BETTER_NATIVE_BASH_KEY] === integration) delete registry[BETTER_NATIVE_BASH_KEY];
}
