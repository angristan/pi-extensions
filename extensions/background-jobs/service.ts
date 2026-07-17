import type { Component } from "@earendil-works/pi-tui";

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
	renderResult(result: any, options: any, theme: any, context: any): Component;
}

interface ServiceState {
	service: BackgroundTerminalService;
	bashIntegrated: boolean;
}

const SERVICE_KEY = Symbol.for("pi.background-terminal.service");

type ServiceRegistry = typeof globalThis & {
	[SERVICE_KEY]?: ServiceState;
};

export function setBackgroundTerminalService(service: BackgroundTerminalService): void {
	(globalThis as ServiceRegistry)[SERVICE_KEY] = { service, bashIntegrated: false };
}

export function getBackgroundTerminalService(): BackgroundTerminalService | undefined {
	return (globalThis as ServiceRegistry)[SERVICE_KEY]?.service;
}

export function markBackgroundTerminalBashIntegrated(service: BackgroundTerminalService): void {
	const state = (globalThis as ServiceRegistry)[SERVICE_KEY];
	if (state?.service === service) state.bashIntegrated = true;
}

export function isBackgroundTerminalBashIntegrated(service: BackgroundTerminalService): boolean {
	const state = (globalThis as ServiceRegistry)[SERVICE_KEY];
	return state?.service === service && state.bashIntegrated;
}

export function clearBackgroundTerminalService(service: BackgroundTerminalService): void {
	const registry = globalThis as ServiceRegistry;
	if (registry[SERVICE_KEY]?.service === service) delete registry[SERVICE_KEY];
}
