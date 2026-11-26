import crypto from 'node:crypto';
import net from 'node:net';
import { promises as dns } from 'node:dns';

/** Hard cap on the response body we'll buffer into memory (bytes). */
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024; // 20MB

/** Hard cap on redirect hops we'll follow before giving up. */
export const MAX_REDIRECTS = 5;

export interface UrlFetchResult {
  url: string;
  title: string | null;
  text: string | null;
  mimeType: string;
  extension: string | null;
  buffer: Buffer;
  contentHash: string;
}

export interface FetchUrlSafelyOptions {
  timeoutMs?: number;
  userAgent?: string;
  maxBytes?: number;
  maxRedirects?: number;
}

/**
 * Decode common HTML entities (named and numeric) into plain text.
 */
export function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const num = parseInt(code, 10);
      return Number.isFinite(num) ? String.fromCharCode(num) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const num = parseInt(code, 16);
      return Number.isFinite(num) ? String.fromCharCode(num) : '';
    });
}

/**
 * Pure helper to extract readable text and title from raw HTML.
 * Strips script, style, noscript, svg, nav, header, and footer blocks.
 */
export function extractHtmlText(html: string): { title: string | null; text: string } {
  if (!html || typeof html !== 'string') {
    return { title: null, text: '' };
  }

  // 1. Extract <title> if present
  let title: string | null = null;
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    const rawTitle = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '')).trim();
    if (rawTitle) {
      title = rawTitle.replace(/\s+/g, ' ');
    }
  }

  // 2. Strip noise elements
  let cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ');

  // 3. Convert block breaks to line breaks
  cleaned = cleaned
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, '\n')
    .replace(/<(p|div|h[1-6]|li|tr|blockquote|section|article)[^>]*>/gi, '\n');

  // 4. Strip all remaining tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');

  // 5. Decode entities
  cleaned = decodeHtmlEntities(cleaned);

  // 6. Normalize whitespace
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0);

  const text = lines.join('\n');
  return { title, text };
}

/**
 * True if `ip` (a literal, already-resolved IPv4/IPv6 address) is in a
 * private, loopback, link-local, or otherwise non-public-routable range.
 * SSRF guard: this repo's URL-fetch sinks take user-influenceable input
 * (any captured `source_url`), so the resolved target must never land
 * inside the deploying network.
 */
export function isDisallowedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    return isDisallowedIpv4(ip);
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isDisallowedIpv4(mapped[1]);
    const firstHextet = parseInt(lower.split(':').find((part) => part.length > 0) ?? '0', 16);
    if (Number.isFinite(firstHextet)) {
      if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
      if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    }
    return false;
  }
  // Not a literal IP at all (shouldn't happen — caller only passes resolved
  // addresses or `URL#hostname` literals) — block conservatively.
  return true;
}

export function isDisallowedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

/**
 * Reject a fetch target that resolves to a private/loopback/link-local
 * address (SSRF guard). Must be called for the original URL and again for
 * every redirect hop, since a redirect can point anywhere.
 */
export async function assertFetchTargetAllowed(target: URL): Promise<void> {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`Unsupported protocol '${target.protocol}': only http and https are allowed`);
  }
  const hostname = target.hostname;
  if (net.isIP(hostname)) {
    if (isDisallowedIp(hostname)) {
      throw new Error(`Refusing to fetch private/loopback address: ${hostname}`);
    }
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`DNS lookup failed for ${hostname}: ${message}`);
  }
  if (addresses.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isDisallowedIp(address)) {
      throw new Error(`Refusing to fetch private/loopback address for host ${hostname}: ${address}`);
    }
  }
}

const DEFAULT_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; ahOS/1.0; +https://github.com/anguspersonal/ahOS)',
  Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
};

/**
 * Follow redirects manually (rather than `redirect: 'follow'`) so each hop's
 * target is re-validated against the SSRF denylist before it's requested —
 * an unguarded redirect chain can land on a private address even when the
 * original URL was public.
 */
export async function fetchWithGuards(
  initialUrl: URL,
  signal: AbortSignal,
  options?: { userAgent?: string; maxRedirects?: number },
): Promise<{ response: Response; finalUrl: URL }> {
  const maxRedirects = options?.maxRedirects ?? MAX_REDIRECTS;
  const headers = {
    ...DEFAULT_FETCH_HEADERS,
    ...(options?.userAgent ? { 'User-Agent': options.userAgent } : {}),
  };

  let currentUrl = initialUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertFetchTargetAllowed(currentUrl);
    const response = await fetch(currentUrl.toString(), {
      signal,
      headers,
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect response ${response.status} from ${currentUrl} had no Location header`);
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }
    return { response, finalUrl: currentUrl };
  }
  throw new Error(`Too many redirects (> ${maxRedirects}) fetching ${initialUrl}`);
}

/**
 * Read a fetch Response body into a Buffer, aborting once `maxBytes` is
 * exceeded so a large or slow-drip response can't exhaust memory.
 */
export async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Response too large (${declaredLength} bytes, max ${maxBytes})`);
  }
  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(`Response too large (${arrayBuffer.byteLength} bytes, max ${maxBytes})`);
    }
    return Buffer.from(arrayBuffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Response too large (exceeded ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * Safely fetch a webpage or document by URL with SSRF guards and size limits,
 * returning extracted content and metadata.
 */
export async function fetchUrlSafely(
  url: string,
  options?: FetchUrlSafelyOptions,
): Promise<UrlFetchResult> {
  if (!url || typeof url !== 'string') {
    throw new Error('URL must be a non-empty string');
  }

  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: ${trimmed}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol '${parsed.protocol}': only http and https are allowed`);
  }

  const timeoutMs = options?.timeoutMs ?? 15000;
  const maxBytes = options?.maxBytes ?? MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  let finalUrl: URL;
  try {
    ({ response, finalUrl } = await fetchWithGuards(parsed, controller.signal, {
      userAgent: options?.userAgent,
      maxRedirects: options?.maxRedirects,
    }));
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${trimmed}`);
    }
    if (err instanceof Error) throw err;
    throw new Error(`Network fetch failed for ${trimmed}: ${err?.message || String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${finalUrl}`);
  }

  const rawContentType = response.headers.get('content-type') || 'application/octet-stream';
  const mimeType = rawContentType.split(';')[0].trim().toLowerCase();
  const buffer = await readBodyWithLimit(response, maxBytes);
  const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');

  const isHtml = mimeType === 'text/html' || mimeType === 'application/xhtml+xml';
  const isPlain =
    mimeType === 'text/plain' ||
    mimeType === 'text/markdown' ||
    mimeType === 'text/csv' ||
    mimeType === 'application/json';

  let title: string | null = null;
  let text: string | null = null;
  let extension: string | null = null;

  if (isHtml) {
    extension = 'html';
    const htmlString = buffer.toString('utf-8');
    const extracted = extractHtmlText(htmlString);
    title = extracted.title;
    text = extracted.text;
  } else if (isPlain) {
    extension = mimeType === 'text/markdown' ? 'md' : mimeType === 'application/json' ? 'json' : 'txt';
    text = buffer.toString('utf-8');
  } else if (mimeType === 'application/pdf') {
    extension = 'pdf';
    text = null;
  }

  return {
    url: trimmed,
    title,
    text,
    mimeType,
    extension,
    buffer,
    contentHash,
  };
}
