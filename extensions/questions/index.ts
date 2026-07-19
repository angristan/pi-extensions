import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input, Text, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";

interface Question { id: string; question: string; options?: string[]; allow_other?: boolean; secret?: boolean }
interface Answer { id: string; question: string; answer?: string; provided?: boolean; cancelled?: boolean; secret?: boolean }
interface Details { questions: Question[]; answers: Answer[]; interrupted: boolean }

const TERMINAL_TITLE_EVENT = "terminal-title:override";

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

function hasAnswer(answer: Answer | undefined): boolean {
	return Boolean(answer && (answer.answer !== undefined || answer.provided));
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

function setAttentionTitle(pi: ExtensionAPI, ctx: any, index: number, total: number): void {
	if (ctx.mode !== "tui") return;
	const title = `❓ Input needed · Question ${index + 1}/${total}`;
	ctx.ui.setTitle(title);
	pi.events.emit(TERMINAL_TITLE_EVENT, { source: "questions", title });
}

function clearAttentionTitle(pi: ExtensionAPI, ctx: any): void {
	if (ctx.mode !== "tui") return;
	// The footer extension restores its contextual title when it receives the
	// clear event. "pi" is the safe standalone fallback when no owner exists.
	ctx.ui.setTitle("pi");
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

class SecretPrompt implements Component, Focusable {
	private readonly input = new MaskedInput();
	private _focused = false;

	constructor(
		private readonly question: string,
		private readonly tui: TUI,
		private readonly theme: any,
		private readonly done: (answer: string | undefined) => void,
	) {
		this.input.onSubmit = (value) => this.done(value);
		this.input.onEscape = () => this.done(undefined);
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

	render(width: number): string[] {
		const max = Math.max(1, width);
		return [
			...wrapTextWithAnsi(this.question, max),
			...wrapTextWithAnsi(this.theme.fg("dim", "Secret response (not stored in the transcript)"), max),
			...this.input.render(max),
			...wrapTextWithAnsi(this.theme.fg("dim", "Enter submit · Esc cancel"), max),
		];
	}

	invalidate(): void { this.input.invalidate(); }
}

async function secretInput(question: string, ctx: any): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Secret questions require interactive TUI mode.", "warning");
		return undefined;
	}
	return ctx.ui.custom<string | undefined>((tui: TUI, theme: any, _kb: any, done: (answer: string | undefined) => void) =>
		new SecretPrompt(question, tui, theme, done));
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
	pi.registerTool({
		name: "questionnaire",
		label: "Questions",
		description: "Ask one or more structured questions and preserve the answers in the transcript.",
		parameters,
		executionMode: "sequential",
		async execute(_id: string, params: any, _signal: AbortSignal, _update: any, ctx: any) {
			const questions: Question[] = Array.isArray(params.questions) ? params.questions : [];
			const answers: Answer[] = [];
			let interrupted = false;
			try {
				for (const [index, question] of questions.entries()) {
					const prompt = numberedPrompt(question.question, index, questions.length, ctx.mode === "tui" ? ctx.ui.theme : undefined);
					setAttentionTitle(pi, ctx, index, questions.length);
					const options = Array.isArray(question.options) ? [...question.options] : [];
					if (question.allow_other !== false) options.push("Type something…");
					let answer: string | undefined;
					if (options.length) {
						const selected = await ctx.ui.select(prompt, options);
						if (selected === undefined) { interrupted = true; answers.push({ id: question.id, question: question.question, cancelled: true, secret: question.secret }); break; }
						answer = selected === "Type something…"
							? question.secret
								? await secretInput(prompt, ctx)
								: await ctx.ui.input(prompt, "Type your answer")
							: selected;
					} else {
						answer = question.secret
							? await secretInput(prompt, ctx)
							: await ctx.ui.input(prompt, "Type your answer");
					}
					if (answer === undefined) { interrupted = true; answers.push({ id: question.id, question: question.question, cancelled: true, secret: question.secret }); break; }
					answers.push(question.secret
						? { id: question.id, question: question.question, provided: true, secret: true }
						: { id: question.id, question: question.question, answer });
				}
			} finally {
				if (questions.length > 0) clearAttentionTitle(pi, ctx);
			}
			const details: Details = { questions, answers, interrupted };
			const response = answers.filter(hasAnswer).map((answer) => `${answer.id}: ${answer.secret ? "[secret provided]" : answer.answer}`).join("\n");
			return { content: [{ type: "text", text: interrupted ? `${response}\nQuestionnaire interrupted`.trim() : response }], details };
		},
		renderCall: () => new Text("", 0, 0),
		renderResult: (result: any, _options: any, theme: any) => new Text(recap(result.details ?? { questions: [], answers: [], interrupted: false }, theme).join("\n"), 0, 0),
		renderShell: "self",
	});
}
