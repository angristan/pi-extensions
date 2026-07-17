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
}

const SERVICE_KEY = Symbol.for("pi.background-terminal.service");

type ServiceRegistry = typeof globalThis & {
	[SERVICE_KEY]?: BackgroundTerminalService;
};

export function setBackgroundTerminalService(service: BackgroundTerminalService): void {
	(globalThis as ServiceRegistry)[SERVICE_KEY] = service;
}

export function getBackgroundTerminalService(): BackgroundTerminalService | undefined {
	return (globalThis as ServiceRegistry)[SERVICE_KEY];
}

export function clearBackgroundTerminalService(service: BackgroundTerminalService): void {
	const registry = globalThis as ServiceRegistry;
	if (registry[SERVICE_KEY] === service) delete registry[SERVICE_KEY];
}
