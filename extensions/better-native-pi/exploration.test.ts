import { beforeEach, describe, expect, test } from "bun:test";
import {
	enableExplorationToolRendering,
	renderExplorationCall,
	resetExplorationStateForTests,
} from "./exploration.js";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
};

function renderLines(component: { render(width: number): string[] } | undefined): string[] {
	return component?.render(120) ?? [];
}

describe("exploration live rendering", () => {
	beforeEach(() => {
		resetExplorationStateForTests();
		enableExplorationToolRendering();
	});

	test("does not render streamed path fragments before execution starts", () => {
		const partial = renderExplorationCall(
			"read",
			{ path: "/Users/stanislas.lange/.pi/agent/git/github.com/ang" },
			theme,
			{ isPartial: true, toolCallId: "call-1", executionStarted: false },
		);

		expect(renderLines(partial)).toEqual([]);

		const started = renderExplorationCall(
			"read",
			{ path: "/Users/stanislas.lange/.pi/agent/git/github.com/angristan/pi-extensions/extensions/goal/index.ts" },
			theme,
			{ isPartial: true, toolCallId: "call-1", executionStarted: true },
		);

		const rendered = renderLines(started).join("\n");
		expect(rendered).toContain("Exploring");
		expect(rendered).toContain("index.ts");
		expect(rendered).not.toContain("Read ang in");
	});
});
