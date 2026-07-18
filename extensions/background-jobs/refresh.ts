export const LIVE_REFRESH_QUIET_MS = 250;
export const LIVE_REFRESH_MAX_WAIT_MS = 500;
export const LIVE_REFRESH_FALLBACK_MS = 5_000;

/** Coalesce output bursts while guaranteeing a trailing refresh after quiet. */
export class CoalescedRefresh {
	private quietTimer?: ReturnType<typeof setTimeout>;
	private maxWaitTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;

	constructor(
		private readonly refresh: () => void,
		private readonly quietMs = LIVE_REFRESH_QUIET_MS,
		private readonly maxWaitMs = LIVE_REFRESH_MAX_WAIT_MS,
	) {}

	trigger(): void {
		if (this.disposed) return;
		if (!this.maxWaitTimer) {
			this.maxWaitTimer = setTimeout(() => this.flush(), this.maxWaitMs);
			this.maxWaitTimer.unref?.();
		}
		if (this.quietTimer) clearTimeout(this.quietTimer);
		this.quietTimer = setTimeout(() => this.flush(), this.quietMs);
		this.quietTimer.unref?.();
	}

	flush(): void {
		if (this.disposed || (!this.quietTimer && !this.maxWaitTimer)) return;
		this.clearTimers();
		this.refresh();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clearTimers();
	}

	private clearTimers(): void {
		if (this.quietTimer) clearTimeout(this.quietTimer);
		if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
		this.quietTimer = undefined;
		this.maxWaitTimer = undefined;
	}
}
