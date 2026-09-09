import { StringDecoder } from "node:string_decoder";

const SOURCES_KEY = Symbol.for("pi.questionnaire.secret-sources");
type SecretSource = () => Iterable<string>;

type Registry = typeof globalThis & { [SOURCES_KEY]?: Set<SecretSource> };

function sources(): Set<SecretSource> {
	return (globalThis as Registry)[SOURCES_KEY] ??= new Set();
}

/** Register a session's in-memory secrets without making another extension own them. */
export function registerSecretSource(source: SecretSource): () => void {
	sources().add(source);
	return () => { sources().delete(source); };
}

/** A command retains its redaction rules even if questionnaire shutdown runs first. */
export class SecretRedactor {
	private readonly secrets = new Set<string>();
	private pattern?: RegExp;
	private longest = 0;

	constructor() {
		this.capture();
	}

	capture(): void {
		const previousSize = this.secrets.size;
		for (const source of sources()) {
			for (const secret of source()) {
				if (secret) this.secrets.add(secret);
			}
		}
		if (this.secrets.size === previousSize) return;
		const values = [...this.secrets].sort((a, b) => b.length - a.length);
		this.longest = values[0]?.length ?? 0;
		this.pattern = new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
	}

	text(value: string): string {
		return this.pattern ? value.replace(this.pattern, "[redacted]") : value;
	}

	/** Redact JSON string values without mutating the tool's execution arguments. */
	value<T>(value: T): T {
		if (!this.pattern) return value;
		if (typeof value === "string") return this.text(value) as T;
		if (Array.isArray(value)) return value.map((item) => this.value(item)) as T;
		if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.value(item)])) as T;
		}
		return value;
	}

	/** Leave a possible secret prefix buffered, but never split a complete match. */
	safePrefixLength(value: string): number {
		let end = value.length;
		if (!this.pattern) return end;
		const secrets = [...this.secrets];
		for (let start = Math.max(0, value.length - this.longest + 1); start < end; start += 1) {
			const suffix = value.slice(start);
			if (secrets.some((secret) => suffix.length < secret.length && secret.startsWith(suffix))) {
				end = start;
				break;
			}
		}
		for (const match of value.matchAll(this.pattern)) {
			if (match.index >= end) break;
			end = Math.max(end, match.index + match[0].length);
		}
		return end;
	}
}

/** Redact before output enters cursor buffers, truncation, partial results, or UI. */
export class SecretOutputFilter {
	private readonly decoder = new StringDecoder("utf8");
	private pending = "";

	constructor(private readonly redactor: SecretRedactor) {}

	push(chunk: Buffer): string {
		this.pending += this.decoder.write(chunk);
		const end = this.redactor.safePrefixLength(this.pending);
		const ready = this.redactor.text(this.pending.slice(0, end));
		this.pending = this.pending.slice(end);
		return ready;
	}

	flush(): string {
		const ready = this.redactor.text(this.pending + this.decoder.end());
		this.pending = "";
		return ready;
	}
}
