const REGISTRY_KEY = Symbol.for("pi-extensions.process-exit-reaper.v1");

type ExitReaper = () => void;

interface ExitReaperRegistry {
	callbacks: Map<symbol, ExitReaper>;
	listener: () => void;
}

function createRegistry(): ExitReaperRegistry {
	const callbacks = new Map<symbol, ExitReaper>();
	const listener = () => {
		// Reapers may unregister themselves while running, so iterate over a stable
		// snapshot. One faulty cleanup must not prevent the remaining process trees
		// from being reaped during Node's synchronous exit phase.
		for (const callback of [...callbacks.values()]) {
			try { callback(); } catch { /* best-effort hard-exit cleanup */ }
		}
	};
	process.on("exit", listener);
	return { callbacks, listener };
}

// Jiti evaluates extension modules again on every reload. Keep the actual
// process listener in a global registry so every runtime shares one listener
// instead of retaining one old module graph per reload.
const root = globalThis as typeof globalThis & { [REGISTRY_KEY]?: ExitReaperRegistry };
const registry = (root[REGISTRY_KEY] ??= createRegistry());

/** Register synchronous hard-exit cleanup and return an idempotent disposer. */
export function registerProcessExitReaper(callback: ExitReaper): () => void {
	const token = Symbol("process-exit-reaper");
	let active = true;
	registry.callbacks.set(token, callback);
	return () => {
		if (!active) return;
		active = false;
		registry.callbacks.delete(token);
	};
}
