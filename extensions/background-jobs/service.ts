export const BASH_SESSION_ENV_GUIDELINE = "Inspect PI_* environment variables for current model and session details.";

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
