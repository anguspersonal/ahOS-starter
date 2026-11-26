import {
  fetchUrlSafely,
  type UrlFetchResult,
  MAX_RESPONSE_BYTES,
  MAX_REDIRECTS,
  decodeHtmlEntities,
  extractHtmlText,
  isDisallowedIp,
  isDisallowedIpv4,
  assertFetchTargetAllowed,
  fetchWithGuards,
  readBodyWithLimit,
} from '@ahkms/shared';

export {
  UrlFetchResult,
  MAX_RESPONSE_BYTES,
  MAX_REDIRECTS,
  decodeHtmlEntities,
  extractHtmlText,
  isDisallowedIp,
  isDisallowedIpv4,
  assertFetchTargetAllowed,
  fetchWithGuards,
  readBodyWithLimit,
};

/**
 * Fetch a webpage or document by URL, extract content and metadata.
 * Thin wrapper over consolidated @ahkms/shared implementation with worker User-Agent.
 */
export async function fetchUrlContent(
  url: string,
  options?: { timeoutMs?: number },
): Promise<UrlFetchResult> {
  return fetchUrlSafely(url, {
    ...options,
    userAgent: 'Mozilla/5.0 (compatible; ahOS-Worker/1.0; +https://github.com/anguspersonal/ahOS)',
  });
}
