export class WebProviderError extends Error {
	readonly status?: number;
	readonly retriable: boolean;
	readonly blocked: boolean;

	constructor(message: string, options: { status?: number; retriable?: boolean; blocked?: boolean; cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.name = "WebProviderError";
		this.status = options.status;
		this.retriable = options.retriable ?? true;
		this.blocked = options.blocked ?? false;
	}
}

export function compactProviderError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 300) || "Unknown provider error";
}

export function providerStatus(error: unknown): number | undefined {
	return error instanceof WebProviderError ? error.status : undefined;
}

export function isRetriableProviderError(error: unknown): boolean {
	if (error instanceof WebProviderError) return error.retriable || error.blocked;
	return true;
}

export function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
