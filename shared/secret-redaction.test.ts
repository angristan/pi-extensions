import { expect, test } from "bun:test";
import { registerSecretSource, SecretOutputFilter, SecretRedactor } from "./secret-redaction";

test("redacts overlapping literals across every byte boundary without corrupting Unicode", () => {
	const unregister = registerSecretSource(() => ["token.$[short]", "token.$[short]-long", "秘密🔑"]);
	try {
		const bytes = Buffer.from("ready> token.$[short]-long / token.$[short] / 秘密🔑 / café🙂 done");
		for (let boundary = 0; boundary <= bytes.length; boundary += 1) {
			const filter = new SecretOutputFilter(new SecretRedactor());
			const first = filter.push(bytes.subarray(0, boundary));
			expect(first).not.toContain("token.$[");
			const text = first + filter.push(bytes.subarray(boundary)) + filter.flush();
			expect(text).toBe("ready> [redacted] / [redacted] / [redacted] / café🙂 done");
		}
	} finally {
		unregister();
	}
});

test("does not delay ordinary prompts and flushes an incomplete prefix at exit", () => {
	const unregister = registerSecretSource(() => ["sensitive-value"]);
	try {
		const filter = new SecretOutputFilter(new SecretRedactor());
		expect(filter.push(Buffer.from("ready> "))).toBe("ready> ");
		expect(filter.push(Buffer.from("sens"))).toBe("");
		expect(filter.flush()).toBe("sens");
	} finally {
		unregister();
	}
});

test("keeps captured rules after shutdown and captures later interactive secrets", () => {
	const secrets = new Set(["first-private-value"]);
	const unregister = registerSecretSource(() => secrets);
	const redactor = new SecretRedactor();
	secrets.add("later-private-value");
	redactor.capture();
	unregister();
	secrets.clear();
	expect(redactor.text("first-private-value / later-private-value")).toBe("[redacted] / [redacted]");
	expect(new SecretRedactor().text("first-private-value")).toBe("first-private-value");
});

test("redacts nested result values without changing execution input", () => {
	const unregister = registerSecretSource(() => ["nested-private-value", ""]);
	try {
		const input = { content: [{ type: "text", text: "nested-private-value" }], details: { command: "use nested-private-value", code: 0 } };
		const result = new SecretRedactor().value(input);
		expect(result).toEqual({ content: [{ type: "text", text: "[redacted]" }], details: { command: "use [redacted]", code: 0 } });
		expect(input.details.command).toBe("use nested-private-value");
	} finally {
		unregister();
	}
});
