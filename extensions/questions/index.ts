import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

interface Question { id: string; question: string; options?: string[]; allow_other?: boolean; secret?: boolean }
interface Answer { id: string; question: string; answer?: string; cancelled?: boolean; secret?: boolean }
interface Details { questions: Question[]; answers: Answer[]; interrupted: boolean }

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

function recap(details: Details, theme: any): string[] {
	const answered = details.answers.filter((answer) => answer.answer !== undefined).length;
	const lines = [`${theme.fg("accent", "•")} ${theme.bold("Questions")} ${answered}/${details.questions.length} answered${details.interrupted ? theme.fg("accent", " (interrupted)") : ""}`];
	for (const question of details.questions) {
		const answer = details.answers.find((candidate) => candidate.id === question.id);
		lines.push(`  • ${question.question}${answer?.answer === undefined ? theme.fg("warning", " (unanswered)") : ""}`);
		if (answer?.answer !== undefined) lines.push(`    answer: ${theme.fg("accent", question.secret ? "••••••" : answer.answer)}`);
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
			for (const question of questions) {
				const options = Array.isArray(question.options) ? [...question.options] : [];
				if (question.allow_other !== false) options.push("Type something…");
				let answer: string | undefined;
				if (options.length) {
					const selected = await ctx.ui.select(question.question, options);
					if (selected === undefined) { interrupted = true; answers.push({ id: question.id, question: question.question, cancelled: true, secret: question.secret }); break; }
					answer = selected === "Type something…"
						? await ctx.ui.input(question.question, "Type your answer")
						: selected;
				} else {
					answer = await ctx.ui.input(question.question, "Type your answer");
				}
				if (answer === undefined) { interrupted = true; answers.push({ id: question.id, question: question.question, cancelled: true, secret: question.secret }); break; }
				answers.push({ id: question.id, question: question.question, answer, secret: question.secret });
			}
			const details: Details = { questions, answers, interrupted };
			const response = answers.filter((answer) => answer.answer !== undefined).map((answer) => `${answer.id}: ${answer.secret ? "[secret provided]" : answer.answer}`).join("\n");
			return { content: [{ type: "text", text: interrupted ? `${response}\nQuestionnaire interrupted`.trim() : response }], details };
		},
		renderCall: () => new Text("", 0, 0),
		renderResult: (result: any, _options: any, theme: any) => new Text(recap(result.details ?? { questions: [], answers: [], interrupted: false }, theme).join("\n"), 0, 0),
		renderShell: "self",
	});
}
