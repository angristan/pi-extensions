import { expect, mock, test } from "bun:test";

function wrapText(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		let current = "";
		for (const word of paragraph.split(/\s+/).filter(Boolean)) {
			if (!current) {
				current = word;
			} else if (current.length + 1 + word.length <= width) {
				current += ` ${word}`;
			} else {
				lines.push(current);
				current = word;
			}
		}
		lines.push(current);
	}
	return lines;
}

class Text {
	constructor(private readonly text: string) {}
	render(): string[] { return this.text.split("\n"); }
	invalidate(): void {}
}

mock.module("@earendil-works/pi-tui", () => ({
	Text,
	truncateToWidth: (text: string, width: number) => text.slice(0, width),
	visibleWidth: (text: string) => text.length,
	wrapTextWithAnsi: wrapText,
}));

mock.module("../overlay-stack/index.js", () => ({
	registerOverlayCard: () => ({ invalidate() {}, unregister() {} }),
}));

const { default: planProgress } = await import("./index");

const tools: any[] = [];
planProgress({
	appendEntry() {},
	events: { emit() {}, on() {} },
	on() {},
	registerCommand() {},
	registerTool(tool: any) { tools.push(tool); },
} as any);

const updatePlan = tools.find((tool) => tool.name === "update_plan");
const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
};

test("wrapped plan result lines retain their left padding", () => {
	const component = updatePlan.renderResult({
		details: {
			explanation: "Alpha beta gamma delta",
			items: [{ step: "Do more work now", status: "in_progress" }],
		},
	}, {}, theme);

	expect(component.render(18)).toEqual([
		"• Updated Plan",
		"  Alpha beta gamma",
		"  delta",
		"  └ ● Do more work",
		"      now",
	]);
});

test("terminates ANSI styles before overlay compositor padding", () => {
	const ansiTheme = {
		...theme,
		fg: (_color: string, text: string) => `\x1b[38m${text}\x1b[39m`,
		strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
	};
	const component = updatePlan.renderResult({
		details: { items: [{ step: "Completed step", status: "completed" }] },
	}, {}, ansiTheme);

	const completedLine = component.render(80)[1];
	expect(completedLine).toContain("\x1b[29m");
	expect(completedLine).toEndWith("\x1b[0m ");
});

test("malformed plan result details render as an empty plan", () => {
	const component = updatePlan.renderResult({ details: {} }, {}, theme);

	expect(component.render(18)).toEqual([
		"• Updated Plan",
		"  └ (no steps)",
	]);
});
