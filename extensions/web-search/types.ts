export type WebProvider = "exa" | "firecrawl" | "mistral";
export type SearchTool = "web_search" | "news_search";
export type AttemptStatus = "success" | "empty" | "failed" | "skipped";

export interface ProviderAttempt {
	provider: WebProvider;
	status: AttemptStatus;
	elapsedMs: number;
	error?: string;
	resultCount?: number;
	creditsUsed?: number;
}

export interface RagResult {
	id: string;
	url: string | null;
	title: string | null;
	description: string | null;
	snippets: string[];
	date: string | null;
	rank: number;
	source: string;
	metadata: Record<string, unknown> | null;
	canOpen: boolean;
}

interface SearchResultBase {
	provider: WebProvider;
	query: string;
	startDate?: string;
	endDate?: string;
	limit: number;
	results: RagResult[];
	elapsedMs: number;
	attempts?: ProviderAttempt[];
	creditsUsed?: number;
}

export interface WebSearchResult extends SearchResultBase {
	tool: "web_search";
}

export interface NewsSearchResult extends SearchResultBase {
	tool: "news_search";
	lang?: string;
}

export interface OpenUrlResult {
	provider: WebProvider;
	tool: "open_url";
	url: string;
	content: string;
	elapsedMs: number;
	truncated: boolean;
	originalBytes: number;
	originalLines: number;
	attempts?: ProviderAttempt[];
	creditsUsed?: number;
}

export interface SearchDisplayItem {
	title?: string;
	url?: string;
	website?: string;
	searchEngine?: string;
	/** Legacy field retained for older persisted tool results. */
	source?: string;
	rank?: number;
	date?: string;
	description?: string;
	snippets: string[];
	canOpen?: boolean;
}

export interface SearchDisplayDetails {
	query?: string;
	startDate?: string;
	endDate?: string;
	lang?: string;
	provider?: WebProvider;
	attempts?: ProviderAttempt[];
	creditsUsed?: number;
	searchEngine?: string;
	elapsedMs?: number;
	resultCount: number;
	results: SearchDisplayItem[];
}

export interface OpenDisplayDetails {
	url?: string;
	provider?: WebProvider;
	attempts?: ProviderAttempt[];
	creditsUsed?: number;
	elapsedMs?: number;
	truncated?: boolean;
	originalBytes?: number;
	originalLines?: number;
	content?: string;
}

export interface WebSearchArgs {
	query: string;
	startDate?: string;
	endDate?: string;
	limit?: number;
}

export interface NewsSearchArgs extends WebSearchArgs {
	lang?: string;
}

export interface OpenUrlArgs {
	url: string;
}

export interface ProviderOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}
