import { expect, test } from "bun:test";
import registerSubagents from "../subagents/index.js";
import bash from "./bash.js";
import fileTools from "./file-tools.js";

/** Collect every tool an extension registers, ignoring other API surface. */
function captureTools(register: (pi: any) => void): any[] {
	const tools: any[] = [];
	const pi = new Proxy(
		{ registerTool: (tool: any) => tools.push(tool) },
		{ get: (target: any, key) => target[key] ?? (() => undefined) },
	);
	register(pi);
	return tools;
}

// Pi sends `strict: true` only for tools that opt in. A wrapped tool that loses
// the opt-in reaches providers as non-strict, and some models then misname the
// required `reasoning` field on every call.
test("tools carrying the injected reasoning field keep strict schema sampling", () => {
	const tools = [
		...captureTools(bash),
		...captureTools(fileTools),
		...captureTools((pi) => registerSubagents(pi)),
	].filter((tool) => tool.parameters?.required?.includes("reasoning"));

	expect(tools.map((tool) => tool.name)).toEqual(
		expect.arrayContaining(["bash", "read", "write", "edit", "grep", "find", "ls", "agents"]),
	);
	for (const tool of tools) {
		expect({ name: tool.name, sampling: tool.constrainedSampling }).toEqual({
			name: tool.name,
			sampling: { type: "json_schema", strict: "prefer" },
		});
	}
});
