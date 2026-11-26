import type { Domain } from "../../../domain/domains.js";
import type {
	BatchUpdateDocumentParams,
	DocsBatchUpdateResponse,
	DocsDocument,
	DocsPort,
	GetDocumentParams,
} from "../../../ports/docs.js";
import {
	createGoogleTokenSource,
	type GoogleTokenSource,
	type GoogleTokenSourceConfig,
} from "../tokenSource.js";

const DOCS_API_BASE = "https://docs.googleapis.com/v1/documents";

export type GoogleDocsAdapterConfig = (
	| GoogleTokenSourceConfig
	| { tokenSource: GoogleTokenSource; fetchFn?: typeof fetch }
) & { sleepFn?: (ms: number) => Promise<void> };

export class DocsApiError extends Error {
	readonly status: number;
	readonly googleStatus?: string;
	readonly reason?: string;

	constructor(message: string, status: number, googleStatus?: string, reason?: string) {
		super(message);
		this.name = "DocsApiError";
		this.status = status;
		this.googleStatus = googleStatus;
		this.reason = reason;
	}
}

interface GoogleErrorBody {
	error?: {
		code?: number;
		message?: string;
		status?: string;
		reason?: string;
		errors?: Array<{ reason?: string; message?: string }>;
		details?: Array<{ reason?: string }>;
	};
}

async function throwDocsApiError(
	res: Response,
	domain: Domain,
	documentId: string,
): Promise<never> {
	const rawText = await res.text();
	let googleStatus: string | undefined;
	let reason: string | undefined;
	let detailMsg = res.statusText || "request failed";

	try {
		const parsed = JSON.parse(rawText) as GoogleErrorBody;
		if (parsed && typeof parsed === "object" && parsed.error) {
			if (typeof parsed.error.status === "string" && parsed.error.status.length > 0) {
				googleStatus = parsed.error.status;
			}
			reason =
				parsed.error.reason ??
				parsed.error.details?.[0]?.reason ??
				parsed.error.errors?.[0]?.reason;
			if (typeof parsed.error.message === "string" && parsed.error.message.length > 0) {
				detailMsg = parsed.error.message;
			}
		}
	} catch {
		// Keep statusText fallback; never echo raw unparsed body or tokens.
	}

	const statusBits = [
		`domain '${domain}'`,
		`document '${documentId}'`,
		`HTTP ${res.status}`,
		googleStatus ? `googleStatus: ${googleStatus}` : undefined,
		reason ? `reason: ${reason}` : undefined,
	].filter(Boolean).join(", ");

	throw new DocsApiError(
		`Google Docs API request failed for ${statusBits}: ${detailMsg}`,
		res.status,
		googleStatus,
		reason,
	);
}

export function createGoogleDocsAdapter(config: GoogleDocsAdapterConfig): DocsPort {
	const tokenSource =
		"tokenSource" in config ? config.tokenSource : createGoogleTokenSource(config);
	const sleep = config.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	return {
		async getDocument({
			domain,
			documentId,
			includeTabsContent = true,
			suggestionsViewMode,
			fields,
		}: GetDocumentParams): Promise<DocsDocument> {
			const accessToken = await tokenSource.accessToken(domain);
			const fetchImpl = config.fetchFn ?? globalThis.fetch;

			const qs = new URLSearchParams({ includeTabsContent: String(includeTabsContent) });
			if (suggestionsViewMode !== undefined) qs.set("suggestionsViewMode", suggestionsViewMode);
			if (fields !== undefined) qs.set("fields", fields);

			const url = `${DOCS_API_BASE}/${encodeURIComponent(documentId)}?${qs.toString()}`;
			const init = {
				method: "GET",
				headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
			};
			let res = await fetchImpl(url, init);
			// Reads only: batchUpdate is a non-idempotent POST and must never retry.
			for (let retry = 0; retry < 2 && (res.status === 429 || res.status >= 500); retry++) {
				await sleep(250 * (retry + 1));
				res = await fetchImpl(url, init);
			}

			if (!res.ok) {
				await throwDocsApiError(res, domain, documentId);
			}

			return (await res.json()) as DocsDocument;
		},

		async batchUpdate({
			domain,
			documentId,
			requests,
			writeControl,
		}: BatchUpdateDocumentParams): Promise<DocsBatchUpdateResponse> {
			const accessToken = await tokenSource.accessToken(domain);
			const fetchImpl = config.fetchFn ?? globalThis.fetch;

			const url = `${DOCS_API_BASE}/${encodeURIComponent(documentId)}:batchUpdate`;
			const body: Record<string, unknown> = { requests };
			if (writeControl !== undefined) {
				body.writeControl = writeControl;
			}
			const res = await fetchImpl(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				await throwDocsApiError(res, domain, documentId);
			}

			return (await res.json()) as DocsBatchUpdateResponse;
		},
	};
}
