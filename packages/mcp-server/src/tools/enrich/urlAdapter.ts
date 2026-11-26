import {
	fetchUrlSafely,
	decodeHtmlEntities,
	extractHtmlText,
	isDisallowedIp,
} from "@ahkms/shared";
import type { FetchedContent, PointerRef, ReadAdapter } from "@ahkms/core";

export { decodeHtmlEntities, extractHtmlText, isDisallowedIp };

/**
 * Fetch URL content directly using the shared SSRF-safe fetch utility.
 */
export async function fetchUrl(
	url: string,
	options?: { timeoutMs?: number },
): Promise<FetchedContent> {
	if (!url || typeof url !== "string") {
		throw new Error("URL must be a non-empty string");
	}

	const trimmed = url.trim();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`Invalid URL: ${trimmed}`);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Unsupported protocol '${parsed.protocol}': only http and https are allowed`);
	}

	const result = await fetchUrlSafely(trimmed, {
		timeoutMs: options?.timeoutMs ?? 15000,
		userAgent: "Mozilla/5.0 (compatible; ahOS-Enrich/1.0; +https://github.com/anguspersonal/ahOS)",
	});

	return {
		buffer: result.buffer,
		mimeType: result.mimeType,
		extension: result.extension || "html",
		contentHash: result.contentHash,
		sourceName: result.title,
		text: result.text,
	};
}

export const urlAdapter: ReadAdapter = {
	connector: "url",
	async fetch(ref: PointerRef): Promise<FetchedContent> {
		const targetUrl = ref.url || ref.externalId;
		if (!targetUrl) {
			throw new Error("No URL provided in pointer reference");
		}
		return fetchUrl(targetUrl);
	},
};
