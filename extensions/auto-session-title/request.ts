const REQUEST_TIMEOUT_MS = 20_000;

export type CompleteRequest = (
	model: any,
	context: any,
	options: any,
) => Promise<any>;

function responseText(response: any): string {
	if (!Array.isArray(response?.content)) return "";
	return response.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("")
		.trim();
}

export async function requestTitleCompletion(
	completeRequest: CompleteRequest,
	model: any,
	auth: any,
	systemPrompt: string,
	prompt: string,
	sessionId: string,
	signal: AbortSignal,
): Promise<string> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const requestSignal = AbortSignal.any([signal, timeout]);
	const response = await completeRequest(
		model,
		{
			systemPrompt,
			messages: [{
				role: "user",
				content: [{ type: "text", text: prompt }],
				timestamp: Date.now(),
			}],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			maxTokens: 384,
			reasoning: "minimal",
			sessionId: `${sessionId}:title`,
			signal: requestSignal,
		},
	);
	if (response.stopReason === "aborted" || signal.aborted) return "";
	if (response.stopReason === "error") throw new Error(response.errorMessage || "Title model request failed");
	return responseText(response);
}
