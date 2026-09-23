import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, Text, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { registerSecretSource, SecretRedactor } from "../../shared/secret-redaction.js";

interface Question { id: string; question: string; options?: string[]; allow_other?: boolean; secret?: boolean }
interface Answer { id: string; question: string; answer?: string; reference?: string; provided?: boolean; cancelled?: boolean; secret?: boolean }
interface Details { questions: Question[]; answers: Answer[]; interrupted: boolean }

const TERMINAL_TITLE_EVENT = "terminal-title:override";
const HERDR_BLOCKED_EVENT = "herdr:blocked";
export const QUESTION_WAITING_EVENT = "questions:waiting";
export const QUESTION_ANSWER_EVENT = "questions:answer";
export const QUESTION_RESOLVED_EVENT = "questions:resolved";

const parameters = {
	type: "object",
	properties: {
		questions: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string", description: "Stable short identifier" },
					question: { type: "string" },
					options: { type: "array", items: { type: "string" } },
					allow_other: { type: "boolean" },
					secret: { type: "boolean" },
				},
				required: ["id", "question"],
			},
		},
	},
	required: ["questions"],
} as any;

const SECRET_REFERENCE_PATTERN = /\{\{questionnaire-secret:[0-9a-f-]{36}\}\}/g;

function hasAnswer(answer: Answer | undefined): boolean {
	return Boolean(answer && (answer.answer !== undefined || answer.provided));
}

function secretReference(): string {
	return `{{questionnaire-secret:${randomUUID()}}}`;
}

function findSecretReferences(value: unknown, references = new Set<string>()): Set<string> {
	if (typeof value === "string") {
		for (const match of value.matchAll(SECRET_REFERENCE_PATTERN)) references.add(match[0]);
		return references;
	}
	if (Array.isArray(value)) {
		for (const item of value) findSecretReferences(item, references);
		return references;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) findSecretReferences(item, references);
	}
	return references;
}

function substituteSecretReferences(value: unknown, secrets: ReadonlyMap<string, string>): unknown {
	if (typeof value === "string") {
		return value.replace(SECRET_REFERENCE_PATTERN, (reference) => secrets.get(reference) ?? reference);
	}
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) value[index] = substituteSecretReferences(value[index], secrets);
		return value;
	}
	if (value && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) {
			(value as Record<string, unknown>)[key] = substituteSecretReferences(item, secrets);
		}
	}
	return value;
}

function numberedPrompt(question: string, index: number, total: number, theme?: any): string {
	const progress = `Question ${index + 1}/${total}`;
	if (!theme) return `${progress} · ${question}`;
	return [
		theme.fg("accent", theme.bold(progress)),
		theme.fg("dim", " · "),
		theme.fg("text", question),
	].join("");
}

function sessionTitle(pi: ExtensionAPI): string {
	return pi.getSessionName()?.trim() || "pi";
}

function setAttentionTitle(pi: ExtensionAPI, ctx: any): void {
	if (ctx.mode !== "tui") return;
	const title = `❓ ${sessionTitle(pi)}`;
	ctx.ui.setTitle(title);
	pi.events.emit(TERMINAL_TITLE_EVENT, { source: "questions", title });
}

function clearAttentionTitle(pi: ExtensionAPI, ctx: any): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setTitle(sessionTitle(pi));
	pi.events.emit(TERMINAL_TITLE_EVENT, { source: "questions", title: undefined });
}

class MaskedInput extends Input {
	override render(width: number): string[] {
		// Input's cursor bookkeeping is private, but its runtime field is a normal
		// property. Swap in an equal-length mask only while rendering so editing,
		// paste handling, undo, and IME cursor placement remain native.
		const runtime = this as unknown as { value: string };
		const value = runtime.value;
		runtime.value = "•".repeat(value.length);
		try {
			return super.render(width);
		} finally {
			runtime.value = value;
		}
	}
}

class MarkdownPrompt {
	private readonly question: Markdown;

	constructor(private readonly progress: string, question: string, protected readonly theme: any) {
		this.question = new Markdown(question, 0, 0, getMarkdownTheme());
	}

	render(width: number): string[] {
		return [
			...wrapTextWithAnsi(this.theme.fg("accent", this.theme.bold(this.progress)), width),
			...this.question.render(width),
			"",
		];
	}

	invalidate(): void { this.question.invalidate(); }
}

class AnswerPrompt extends MarkdownPrompt implements Component, Focusable {
	private readonly input: Input;
	private _focused = false;

	constructor(
		progress: string,
		question: string,
		private readonly secret: boolean,
		private readonly tui: TUI,
		theme: any,
		done: (answer: string | undefined) => void,
	) {
		super(progress, question, theme);
		this.input = secret ? new MaskedInput() : new Input();
		this.input.onSubmit = done;
		this.input.onEscape = () => done(undefined);
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	override render(width: number): string[] {
		const max = Math.max(1, width);
		return [
			...super.render(max),
			...(this.secret ? wrapTextWithAnsi(this.theme.fg("dim", "Secret response (not stored in the transcript)"), max) : []),
			...this.input.render(max),
			...wrapTextWithAnsi(this.theme.fg("dim", "Enter submit · Esc cancel"), max),
		];
	}

	override invalidate(): void { super.invalidate(); this.input.invalidate(); }
}

class ChoicePrompt extends MarkdownPrompt implements Component {
	private readonly choices: Markdown[];
	private selected = 0;

	constructor(
		progress: string,
		question: string,
		choices: string[],
		private readonly tui: TUI,
		theme: any,
		private readonly keys: KeybindingsManager,
		private readonly done: (index: number | undefined) => void,
	) {
		super(progress, question, theme);
		this.choices = choices.map((choice) => new Markdown(choice, 0, 0, getMarkdownTheme()));
	}

	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.up")) this.selected = (this.selected + this.choices.length - 1) % this.choices.length;
		else if (this.keys.matches(data, "tui.select.down")) this.selected = (this.selected + 1) % this.choices.length;
		else if (this.keys.matches(data, "tui.select.confirm")) return this.done(this.selected);
		else if (this.keys.matches(data, "tui.select.cancel")) return this.done(undefined);
		this.tui.requestRender();
	}

	override render(width: number): string[] {
		const max = Math.max(1, width);
		const lines = super.render(max);
		const start = Math.max(0, Math.min(this.selected - 2, this.choices.length - 5));
		const indent = max > 2 ? "  " : "";
		for (let i = start; i < Math.min(start + 5, this.choices.length); i++) {
			const prefix = i === this.selected && indent ? this.theme.fg("accent", "→ ") : indent;
			const rendered = this.choices[i].render(max - indent.length);
			for (const [lineIndex, line] of rendered.entries()) lines.push((lineIndex === 0 ? prefix : indent) + line);
		}
		if (this.choices.length > 5) lines.push(...wrapTextWithAnsi(this.theme.fg("dim", `  (${this.selected + 1}/${this.choices.length})`), max));
		lines.push(...wrapTextWithAnsi(this.theme.fg("dim", "↑/↓ select · Enter confirm · Esc cancel"), max));
		return lines;
	}

	override invalidate(): void {
		super.invalidate();
		for (const choice of this.choices) choice.invalidate();
	}
}

async function secretInput(progress: string, question: string, ctx: any): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Secret questions require interactive TUI mode.", "warning");
		return undefined;
	}
	return ctx.ui.custom<string | undefined>((tui: TUI, theme: any, _kb: any, done: (answer: string | undefined) => void) =>
		new AnswerPrompt(progress, question, true, tui, theme, done));
}

interface CollectedAnswer {
	answer?: string;
	cancelled: boolean;
	source: "tui" | "remote";
}

async function collectAnswer(
	pi: ExtensionAPI,
	requestId: string,
	question: Question,
	prompt: string,
	progress: string,
	ctx: any,
	onReady: () => void,
): Promise<CollectedAnswer> {
	const dialogController = new AbortController();
	let dismissDialog: (() => void) | undefined;
	const customDialog = <T>(factory: (tui: TUI, theme: any, keys: KeybindingsManager, done: (answer: T) => void) => Component) =>
		ctx.ui.custom<T>((tui: TUI, theme: any, keys: KeybindingsManager, done: (answer: T) => void) => {
			const dismiss = () => done(undefined as T);
			dismissDialog = dismiss;
			return factory(tui, theme, keys, (answer) => { dismissDialog = undefined; done(answer); });
		}).finally(() => { dismissDialog = undefined; });
	let resolveRemote!: (answer: string) => void;
	let remoteSettled = false;
	const remoteAnswer = new Promise<string>((resolve) => { resolveRemote = resolve; });
	const options = Array.isArray(question.options) ? [...question.options] : [];
	const allowOther = question.allow_other !== false || options.length === 0;
	const stopRemoteListener = pi.events.on(QUESTION_ANSWER_EVENT, (event: unknown) => {
		if (remoteSettled || question.secret || !event || typeof event !== "object") return;
		const value = event as { requestId?: unknown; answer?: unknown };
		if (value.requestId !== requestId || typeof value.answer !== "string") return;
		const answer = value.answer.trim();
		if (!answer || answer.length > 4_000) return;
		if (options.length > 0 && !allowOther && !options.includes(answer)) return;
		remoteSettled = true;
		resolveRemote(answer);
		dismissDialog?.();
	});

	const raceRemote = async <T>(startLocal: () => Promise<T>): Promise<{ source: "local"; value: T } | { source: "remote"; value: string }> => {
		if (remoteSettled) return { source: "remote", value: await remoteAnswer };
		const result = await Promise.race([
			startLocal().then((value) => ({ source: "local" as const, value })),
			remoteAnswer.then((value) => ({ source: "remote" as const, value })),
		]);
		if (result.source === "remote") dialogController.abort();
		return result;
	};

	try {
		onReady();
		if (options.length > 0) {
			const choices = question.allow_other !== false ? [...options, "Type something…"] : options;
			if (ctx.mode === "tui") {
				// Use the index so a real option named "Type something…" stays selectable.
				const selected = await raceRemote(() => customDialog<number | undefined>((tui, theme, keys, done) =>
					new ChoicePrompt(progress, question.question, choices, tui, theme, keys, done)));
				if (selected.source === "remote") return { answer: selected.value, cancelled: false, source: "remote" };
				if (selected.value === undefined) return { cancelled: true, source: "tui" };
				if (selected.value < options.length) return { answer: options[selected.value], cancelled: false, source: "tui" };
			} else {
				const selected = await raceRemote(() => ctx.ui.select(prompt, choices, { signal: dialogController.signal }));
				if (selected.source === "remote") return { answer: selected.value, cancelled: false, source: "remote" };
				if (selected.value === undefined) return { cancelled: true, source: "tui" };
				if (selected.value !== "Type something…") return { answer: selected.value, cancelled: false, source: "tui" };
			}
		}

		if (question.secret) {
			const answer = await secretInput(progress, question.question, ctx);
			return answer === undefined
				? { cancelled: true, source: "tui" }
				: { answer, cancelled: false, source: "tui" };
		}
		const entered = await raceRemote(() => ctx.mode === "tui"
			? customDialog<string | undefined>((tui, theme, _keys, done) => new AnswerPrompt(progress, question.question, false, tui, theme, done))
			: ctx.ui.input(prompt, "Type your answer", { signal: dialogController.signal }));
		return entered.source === "remote"
			? { answer: entered.value, cancelled: false, source: "remote" }
			: entered.value === undefined
				? { cancelled: true, source: "tui" }
				: { answer: entered.value, cancelled: false, source: "tui" };
	} finally {
		dialogController.abort();
		stopRemoteListener();
	}
}

function recap(details: Details, theme: any): string[] {
	const answered = details.answers.filter(hasAnswer).length;
	const lines = [`${theme.fg("accent", "•")} ${theme.bold("Questions")} ${answered}/${details.questions.length} answered${details.interrupted ? theme.fg("accent", " (interrupted)") : ""}`];
	for (const question of details.questions) {
		const answer = details.answers.find((candidate) => candidate.id === question.id);
		lines.push(`  • ${question.question}${!hasAnswer(answer) ? theme.fg("warning", " (unanswered)") : ""}`);
		if (hasAnswer(answer)) lines.push(`    answer: ${theme.fg("accent", question.secret ? "••••••" : answer?.answer ?? "")}`);
	}
	return lines;
}

export default function (pi: ExtensionAPI) {
	const secrets = new Map<string, string>();
	const unregisterSecrets = registerSecretSource(() => secrets.values());

	pi.on("tool_call", (event) => {
		const references = findSecretReferences(event.input);
		if (references.size === 0) return;
		const unavailable = [...references].filter((reference) => !secrets.has(reference));
		if (unavailable.length > 0) {
			return { block: true, reason: "A questionnaire secret reference expired. Ask the user for the secret again." };
		}
		substituteSecretReferences(event.input, secrets);
	});
	pi.on("tool_result", (event) => {
		const redactor = new SecretRedactor();
		return { content: redactor.value(event.content), details: redactor.value(event.details) };
	});
	pi.on("session_shutdown", () => {
		unregisterSecrets();
		secrets.clear();
	});

	pi.registerTool({
		name: "questionnaire",
		label: "Questions",
		description: "Ask structured questions. Secret answers return opaque references; copy them unchanged into later tool arguments.",
		parameters,
		executionMode: "sequential",
		async execute(toolCallId: string, params: any, _signal: AbortSignal, _update: any, ctx: any) {
			const questions: Question[] = Array.isArray(params.questions) ? params.questions : [];
			const answers: Answer[] = [];
			let interrupted = false;
			if (questions.length > 0) setAttentionTitle(pi, ctx);
			try {
				for (const [index, question] of questions.entries()) {
					const prompt = numberedPrompt(question.question, index, questions.length, ctx.mode === "tui" ? ctx.ui.theme : undefined);
					const requestId = `${toolCallId}:${index}`;
					let resolution: { outcome: "answered" | "cancelled"; source: "tui" | "remote" } = { outcome: "cancelled", source: "tui" };
					try {
						const collected = await collectAnswer(pi, requestId, question, prompt, `Question ${index + 1}/${questions.length}`, ctx, () => {
							// Herdr's agent-state integration treats this optional event as an
							// authoritative wait signal. Keep the label generic so secret question
							// text never leaves the questionnaire UI.
							pi.events.emit(HERDR_BLOCKED_EVENT, { active: true, label: "Waiting for user input" });
							pi.events.emit(QUESTION_WAITING_EVENT, {
								requestId,
								questionnaireId: toolCallId,
								question: question.question,
								options: Array.isArray(question.options) ? [...question.options] : [],
								allowOther: question.allow_other !== false,
								index: index + 1,
								total: questions.length,
								secret: question.secret === true,
							});
						});
						resolution = { outcome: collected.cancelled ? "cancelled" : "answered", source: collected.source };
						if (collected.cancelled) {
							interrupted = true;
							answers.push({ id: question.id, question: question.question, cancelled: true, secret: question.secret });
							break;
						}
						if (question.secret) {
							const reference = secretReference();
							secrets.set(reference, collected.answer ?? "");
							answers.push({ id: question.id, question: question.question, reference, provided: true, secret: true });
						} else {
							answers.push({ id: question.id, question: question.question, answer: collected.answer });
						}
					} finally {
						// Balance every blocked report before publishing resolution. The state
						// integration reference-counts nested waits.
						pi.events.emit(HERDR_BLOCKED_EVENT, { active: false });
						pi.events.emit(QUESTION_RESOLVED_EVENT, {
							requestId,
							questionnaireId: toolCallId,
							index: index + 1,
							total: questions.length,
							...resolution,
						});
					}
				}
			} finally {
				if (questions.length > 0) clearAttentionTitle(pi, ctx);
			}
			const details: Details = { questions, answers, interrupted };
			const response = answers.filter(hasAnswer).map((answer) => `${answer.id}: ${answer.secret ? answer.reference : answer.answer}`).join("\n");
			return { content: [{ type: "text", text: interrupted ? `${response}\nQuestionnaire interrupted`.trim() : response }], details };
		},
		renderCall: () => new Text("", 0, 0),
		renderResult: (result: any, _options: any, theme: any) => new Text(recap(result.details ?? { questions: [], answers: [], interrupted: false }, theme).join("\n"), 0, 0),
		renderShell: "self",
	});
}
