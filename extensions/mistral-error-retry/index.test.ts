import { expect, test } from "bun:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import mistralErrorRetry, { MAX_CONSECUTIVE_RETRIES, MISTRAL_STREAM_ERROR } from "./index";

function setup() {
	const handlers = new Map<string, (event: any) => any>();
	mistralErrorRetry({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
	const end = (message: any) => handlers.get("message_end")!({ type: "message_end", message })?.message ?? message;
	const input = () => handlers.get("input")!({ type: "input", text: "again" });
	return { end, input };
}

const failed = () => ({ role: "assistant", content: [], stopReason: "error", errorMessage: MISTRAL_STREAM_ERROR });
const succeeded = () => ({ role: "assistant", content: [], stopReason: "stop" });

test("makes the Mistral stream error retryable for Pi's classifier", () => {
	const { end } = setup();
	expect(isRetryableAssistantError(failed() as any)).toBe(false);
	expect(isRetryableAssistantError(end(failed()))).toBe(true);
});

test("leaves other errors and roles untouched", () => {
	const { end } = setup();
	const filtered = { role: "assistant", content: [], stopReason: "error", errorMessage: "Provider stopped with: content_filter" };
	expect(end(filtered)).toBe(filtered);
	const user = { role: "user", content: "hi", stopReason: "error", errorMessage: MISTRAL_STREAM_ERROR };
	expect(end(user)).toBe(user);
});

test("stops after the consecutive budget and resets on success or new input", () => {
	const { end, input } = setup();
	for (let i = 0; i < MAX_CONSECUTIVE_RETRIES; i++) expect(isRetryableAssistantError(end(failed()))).toBe(true);
	expect(isRetryableAssistantError(end(failed()))).toBe(false);

	input();
	expect(isRetryableAssistantError(end(failed()))).toBe(true);

	for (let i = 1; i < MAX_CONSECUTIVE_RETRIES; i++) end(failed());
	end(succeeded());
	expect(isRetryableAssistantError(end(failed()))).toBe(true);
});
