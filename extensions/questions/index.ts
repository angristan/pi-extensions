import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Input, Markdown, Spacer, Text, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
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

	// Native extension dialogs reserve one column on each side of their content.
	protected contentWidth(width: number): number { return Math.max(1, width - (width > 1 ? 2 : 0)); }
	protected inset(lines: string[], width: number): string[] {
		const padding = width > 1 ? " " : "";
		return lines.map((line) => padding + line);
	}

	protected panel(lines: string[], width: number): string[] {
		return lines.map((line) => this.theme.bg("customMessageBg",
			line + " ".repeat(Math.max(0, width - visibleWidth(line)))));
	}

	render(width: number): string[] {
		const inner = this.contentWidth(width);
		return this.panel(["", ...this.inset([
			...wrapTextWithAnsi(this.theme.fg("accent", this.theme.bold(this.progress)), inner),
			...this.question.render(inner),
			"",
		], width)], width);
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
		const inner = this.contentWidth(max);
		return [
			...super.render(max),
			...this.panel(this.inset([
				...(this.secret ? wrapTextWithAnsi(this.theme.fg("dim", "Secret response (not stored in the transcript)"), inner) : []),
				...this.input.render(inner),
				"",
				...wrapTextWithAnsi(this.theme.fg("dim", "Enter submit · Esc cancel"), inner),
			], max), max),
			...this.panel([""], max),
		];
	}

	override invalidate(): void { super.invalidate(); this.input.invalidate(); }
}

class ChoicePanel extends MarkdownPrompt implements Component {
	private readonly choices: Markdown[];

	constructor(
		progress: string,
		question: string,
		choices: string[],
		theme: any,
		protected selected = 0,
		private readonly completed = false,
	) {
		super(progress, question, theme);
		this.choices = choices.map((choice) => new Markdown(choice || "(empty answer)", 0, 0, getMarkdownTheme()));
	}

	override render(width: number): string[] {
		const max = Math.max(1, width);
		const lines = super.render(max);
		const inner = this.contentWidth(max);
		const start = Math.max(0, Math.min(this.selected - 2, this.choices.length - 5));
		const indent = inner > 2 ? "  " : "";
		for (let i = start; i < Math.min(start + 5, this.choices.length); i++) {
			if (i > start) lines.push(...this.panel([""], max));
			const selected = i === this.selected;
			const marker = indent
				? this.theme.fg(selected ? "accent" : "dim", selected ? "▌ " : "○ ")
				: "";
			const rendered = this.choices[i].render(inner - indent.length);
			const choiceLines = rendered.map((line, index) => (index === 0 || selected ? marker : indent) + line);
			if (i === this.selected) {
				// Keep the panel-colored inset around the selected Markdown block.
				const left = max > 1 ? " " : "";
				const right = " ".repeat(Math.max(0, max - left.length - inner));
				lines.push(...choiceLines.map((line) =>
					this.theme.bg("customMessageBg", left)
					+ this.theme.bg("selectedBg", line + " ".repeat(Math.max(0, inner - visibleWidth(line))))
					+ this.theme.bg("customMessageBg", right)));
			} else {
				lines.push(...this.panel(this.inset(choiceLines, max), max));
			}
		}
		if (this.choices.length > 5 && !this.completed) lines.push(...this.panel(this.inset(wrapTextWithAnsi(this.theme.fg("dim", `  (${this.selected + 1}/${this.choices.length})`), inner), max), max));
		lines.push(...this.panel([""], max));
		if (!this.completed) {
			lines.push(...this.panel(this.inset(wrapTextWithAnsi(this.theme.fg("dim", "↑/↓ select · Enter confirm · Esc cancel"), inner), max), max));
			lines.push(...this.panel([""], max));
		}
		return lines;
	}

	override invalidate(): void {
		super.invalidate();
		for (const choice of this.choices) choice.invalidate();
	}
}

class ChoicePrompt extends ChoicePanel {
	constructor(
		progress: string,
		question: string,
		choices: string[],
		private readonly tui: TUI,
		theme: any,
		private readonly keys: KeybindingsManager,
		private readonly done: (index: number | undefined) => void,
	) {
		super(progress, question, choices, theme);
	}

	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.up")) this.selected = (this.selected + this.choices.length - 1) % this.choices.length;
		else if (this.keys.matches(data, "tui.select.down")) this.selected = (this.selected + 1) % this.choices.length;
		else if (this.keys.matches(data, "tui.select.confirm")) return this.done(this.selected);
		else if (this.keys.matches(data, "tui.select.cancel")) return this.done(undefined);
		this.tui.requestRender();
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

function indentComponent(child: Component, columns: number): Component {
	return {
		render(width: number): string[] {
			const indent = " ".repeat(Math.min(columns, Math.max(0, width - 1)));
			return child.render(Math.max(1, width - indent.length)).map((line) => indent + line);
		},
		invalidate(): void { child.invalidate(); },
	};
}

function recap(details: Details, theme: any): Component {
	const answered = details.answers.filter(hasAnswer).length;
	const content = new Container();
	content.addChild(new Text(`${theme.fg("accent", "•")} ${theme.bold("Questions")} ${answered}/${details.questions.length} answered${details.interrupted ? theme.fg("accent", " (interrupted)") : ""}`, 0, 0));
	for (const [index, question] of details.questions.entries()) {
		const answer = details.answers.find((candidate) => candidate.id === question.id);
		content.addChild(new Spacer(1));
		if (hasAnswer(answer) && !question.secret && typeof answer?.answer === "string") {
			const choices = Array.isArray(question.options) ? [...question.options] : [];
			let selected = choices.indexOf(answer.answer);
			if (selected < 0) {
				selected = choices.length;
				choices.push(answer.answer);
			}
			content.addChild(new ChoicePanel(`Question ${index + 1}/${details.questions.length} · Answered`, question.question, choices, theme, selected, true));
			continue;
		}
		content.addChild(indentComponent(new Text(`${theme.fg("accent", `Question ${index + 1}`)}${!hasAnswer(answer) ? theme.fg("warning", " (unanswered)") : ""}`, 0, 0), 2));
		content.addChild(indentComponent(new Markdown(question.question, 0, 0, getMarkdownTheme()), 4));
		if (hasAnswer(answer)) {
			content.addChild(new Spacer(1));
			content.addChild(indentComponent(new Text(theme.fg("accent", "Answer"), 0, 0), 4));
			content.addChild(indentComponent(new Markdown(question.secret ? "••••••" : answer?.answer ?? "", 0, 0, getMarkdownTheme()), 4));
		}
	}
	return content;
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
		renderResult: (result: any, _options: any, theme: any) => recap(result.details ?? { questions: [], answers: [], interrupted: false }, theme),
		renderShell: "self",
	});
}
