import { apiRoot } from "./catalog";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_CHARS = 300;
/**
 * Built-in connectors to include. Mistral Vibe requests the same set by default; others, such as
 * the document library, stay off unless a caller opts in.
 */
const BUILTIN_CONNECTORS = ["web_search"];

export interface MistralRequest {
	baseUrl: string;
	apiKey: string;
	signal?: AbortSignal;
}

async function getJson(url: string, { apiKey, signal }: MistralRequest): Promise<unknown> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) {
		const body = (await response.text().catch(() => "")).trim().slice(0, MAX_ERROR_BODY_CHARS);
		throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}${body ? `: ${body}` : ""}`);
	}
	return response.json();
}

/** Lists the account's connectors, with tools for ready ones and auth actions for the rest. */
export function fetchBootstrap(request: MistralRequest): Promise<unknown> {
	const params = new URLSearchParams({ include_auth_actionable_connectors: "true", supports_mcp: "true" });
	// The API reads this as a repeated parameter; a comma-joined value would name one unknown connector.
	for (const name of BUILTIN_CONNECTORS) params.append("builtin_connectors", name);
	return getJson(`${apiRoot(request.baseUrl)}/v1/connectors/bootstrap?${params}`, request);
}

/** Returns the browser URL that connects an OAuth connector to the account. */
export async function fetchAuthUrl(request: MistralRequest, connectorId: string): Promise<string> {
	const payload = await getJson(`${apiRoot(request.baseUrl)}/v1/connectors/${encodeURIComponent(connectorId)}/auth_url`, request);
	const url = payload && typeof payload === "object" ? (payload as { auth_url?: unknown }).auth_url : undefined;
	if (typeof url !== "string" || !url) throw new Error("The API returned no auth_url.");
	return url;
}
