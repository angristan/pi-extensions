export type MailboxEventKind = "message" | "final";

export interface AgentMailboxEvent<TFinal = unknown> {
	sequence: number;
	kind: MailboxEventKind;
	agentId: string;
	agentName: string;
	content: string;
	createdAt: number;
	persistenceKey?: string;
	status?: string;
	final?: TFinal;
	omittedBefore?: number;
	recovered?: boolean;
}

export interface MailboxMetrics {
	published: number;
	delivered: number;
	consumed: number;
	coalesced: number;
	dropped: number;
	recovered: number;
}

export interface MailboxSnapshot {
	unread: number;
	messageBytes: number;
	byAgent: Record<string, number>;
	metrics: MailboxMetrics;
}

export class AgentMailbox<TFinal = unknown> {
	private sequence = 0;
	private readonly events: AgentMailboxEvent<TFinal>[] = [];
	private readonly pendingOmissions = new Map<string, number>();
	private readonly counters: MailboxMetrics = {
		published: 0,
		delivered: 0,
		consumed: 0,
		coalesced: 0,
		dropped: 0,
		recovered: 0,
	};

	constructor(
		private readonly maxMessageBytes: number,
		private readonly maxMessagesPerAgent: number,
	) {}

	publish(input: Omit<AgentMailboxEvent<TFinal>, "sequence" | "omittedBefore">): AgentMailboxEvent<TFinal> {
		const event: AgentMailboxEvent<TFinal> = {
			...input,
			sequence: ++this.sequence,
		};
		const pending = this.pendingOmissions.get(event.agentId) ?? 0;
		if (pending > 0) {
			event.omittedBefore = pending;
			this.pendingOmissions.delete(event.agentId);
		}
		this.events.push(event);
		this.counters.published += 1;
		if (event.recovered) this.counters.recovered += 1;
		if (event.kind === "message") this.enforceMessageBounds(event.agentId);
		return event;
	}

	restore(input: Omit<AgentMailboxEvent<TFinal>, "sequence">): AgentMailboxEvent<TFinal> {
		return this.publish({ ...input, recovered: true });
	}

	peek(predicate: (event: AgentMailboxEvent<TFinal>) => boolean = () => true): AgentMailboxEvent<TFinal>[] {
		return this.events.filter(predicate);
	}

	has(predicate: (event: AgentMailboxEvent<TFinal>) => boolean = () => true): boolean {
		return this.events.some(predicate);
	}

	take(
		predicate: (event: AgentMailboxEvent<TFinal>) => boolean = () => true,
		outcome: "consumed" | "delivered" = "consumed",
	): AgentMailboxEvent<TFinal>[] {
		const taken: AgentMailboxEvent<TFinal>[] = [];
		for (let index = this.events.length - 1; index >= 0; index -= 1) {
			const event = this.events[index]!;
			if (!predicate(event)) continue;
			taken.push(event);
			this.events.splice(index, 1);
		}
		taken.reverse();
		this.counters[outcome] += taken.length;
		return taken;
	}

	remove(sequence: number): AgentMailboxEvent<TFinal> | undefined {
		const index = this.events.findIndex((event) => event.sequence === sequence);
		if (index < 0) return undefined;
		return this.events.splice(index, 1)[0];
	}

	clear(): void {
		this.events.length = 0;
		this.pendingOmissions.clear();
	}

	reset(): void {
		this.clear();
		this.sequence = 0;
		for (const key of Object.keys(this.counters) as (keyof MailboxMetrics)[]) this.counters[key] = 0;
	}

	snapshot(): MailboxSnapshot {
		const byAgent: Record<string, number> = {};
		for (const event of this.events) byAgent[event.agentName] = (byAgent[event.agentName] ?? 0) + 1;
		return {
			unread: this.events.length,
			messageBytes: this.messageBytes(),
			byAgent,
			metrics: { ...this.counters },
		};
	}

	private eventBytes(event: AgentMailboxEvent<TFinal>): number {
		return event.kind === "message" ? Buffer.byteLength(event.content) + 128 : 0;
	}

	private messageBytes(): number {
		return this.events.reduce((total, event) => total + this.eventBytes(event), 0);
	}

	private noteOmission(agentId: string, amount: number): void {
		const latest = [...this.events].reverse().find((event) => event.agentId === agentId);
		if (latest) latest.omittedBefore = (latest.omittedBefore ?? 0) + amount;
		else this.pendingOmissions.set(agentId, (this.pendingOmissions.get(agentId) ?? 0) + amount);
	}

	private dropMessage(event: AgentMailboxEvent<TFinal>, reason: "coalesced" | "dropped"): void {
		this.remove(event.sequence);
		this.counters[reason] += 1;
		this.noteOmission(event.agentId, (event.omittedBefore ?? 0) + 1);
	}

	private enforceMessageBounds(agentId: string): void {
		for (;;) {
			const messages = this.events.filter((event) => event.kind === "message" && event.agentId === agentId);
			if (messages.length <= this.maxMessagesPerAgent) break;
			this.dropMessage(messages[0]!, "coalesced");
		}
		while (this.messageBytes() > this.maxMessageBytes) {
			const oldest = this.events.find((event) => event.kind === "message");
			if (!oldest) break;
			this.dropMessage(oldest, "dropped");
		}
	}
}
