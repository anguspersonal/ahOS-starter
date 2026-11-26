// Thin Gmail REST client (issue #821). Raw fetch rather than the googleapis SDK, for
// the same reason calendar.ts and notion.ts are: the request is stubbable with a
// global fetch mock, so every code path here is unit-testable without a live mailbox.
//
// Scope note: the Gmail scopes live in google/scopes.ts and are minted in ONE consent
// per account alongside Drive and Calendar (ADR-045, #126). A token minted before the
// Gmail scopes joined that list is accepted by Google and then rejected by the Gmail
// API with a 403 insufficient-scope. The fix is a re-consent, never a code change.
//
// Outward writes (issue #1006, which is the issue the previous version of this comment
// asked for before anything here could send). `gmail.modify` grants drafts, send and
// permanent delete at the API level; what this file exports is narrower than that on
// purpose:
//
//   - Drafting and sending a draft: present, as two separate steps. There is no helper
//     that composes and sends in one call, and that absence IS the brake. Every send
//     goes through a draft that exists in the real mailbox first, so it can be read,
//     corrected or sent by hand in Gmail, and an accidental send costs two deliberate
//     calls rather than one.
//   - Permanent delete: still absent. Nothing has asked for it, and modifyLabels already
//     archives, which is the reversible version of what callers usually mean. Do not add
//     one without an issue that asks for it.
//
// An earlier version of this comment justified the absence as "the same tool-layer human
// gate outwardWrite.ts applies to outward writes". outwardWrite.ts has no such gate: it
// is one narrow error type about whether an interrupted write landed (#653). The claim
// was wrong when written, and is recorded here so it is not reinvented.

import { GmailApiError } from "../../../ports/gmail.js";
export { GmailApiError };

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Gmail's own system labels; these two are the ones the modify tool manipulates. */
export const LABEL_UNREAD = "UNREAD";
export const LABEL_INBOX = "INBOX";

/**
 * Account-labelled token handle for Gmail API calls.
 * `label` is used in error messages; `accessToken()` mints or returns a short-lived token.
 */
export type GmailAuth = {
	label: string;
	accessToken(): Promise<string>;
	fetchFn?: typeof fetch;
};

const MAX_READ_RETRIES = 2;

function retryDelayMs(res: Response, attempt: number): number {
	const raw = res.headers?.get?.("Retry-After");
	if (raw !== null && raw !== undefined) {
		const trimmed = raw.trim();
		if (/^\d+(\.\d+)?$/.test(trimmed)) {
			return Math.max(0, Math.round(Number(trimmed) * 1000));
		}
		const parsed = Date.parse(trimmed);
		if (!Number.isNaN(parsed)) {
			return Math.max(0, parsed - Date.now());
		}
	}
	return 250 * 2 ** attempt;
}

/**
 * `accessToken` skips the per-call mint. Every interactive call site mints its own, which
 * is right for a handful of requests; a discover sweep makes one request per message, and
 * minting a token per request there is one extra OAuth round-trip per message (#1210).
 *
 * Read requests (GET) retry up to 2 times on 429/5xx, honouring Retry-After; write
 * requests (POST/PUT/DELETE/PATCH) never retry so non-idempotent mutations cannot double-fire.
 */
async function gmailFetch<T>(
	auth: GmailAuth,
	path: string,
	init?: { method?: string; body?: unknown; accessToken?: string },
): Promise<T> {
	const method = (init?.method ?? "GET").toUpperCase();
	const isRead = method === "GET";
	const maxRetries = isRead ? MAX_READ_RETRIES : 0;

	for (let attempt = 0; ; attempt++) {
		const token = init?.accessToken ?? (await auth.accessToken());
		const res = await (auth.fetchFn ?? fetch)(`${GMAIL_API}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(init?.body ? { "Content-Type": "application/json" } : {}),
			},
			...(init?.body ? { body: JSON.stringify(init.body) } : {}),
		});
		if (!res.ok) {
			if (
				attempt < maxRetries &&
				(res.status === 429 || (res.status >= 500 && res.status < 600))
			) {
				const delay = retryDelayMs(res, attempt);
				await new Promise((resolve) => setTimeout(resolve, delay));
				continue;
			}
			const detail = await res.text();
			// The account is named in the error because the commonest failure here is a
			// correct call against the wrong mailbox, which Gmail reports as a bare 404.
			//
			// `status` rides on the error (#1210) so a caller can tell a vanished message
			// (404) from a throttle (429/5xx) without parsing this text; backoff.ts's
			// httpStatusOf reads exactly this property. The message is unchanged.
			let reason: string | undefined;
			let googleStatus: string | undefined;
			try {
				const err = (JSON.parse(detail) as { error?: { reason?: string; status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } }).error;
				reason = err?.errors?.[0]?.reason ?? err?.details?.[0]?.reason ?? err?.reason;
				googleStatus = err?.status;
			} catch { /* non-JSON error body */ }
			throw new GmailApiError(
				`Gmail API ${method} ${path} failed for account '${auth.label}' (${res.status}): ${detail}`,
				res.status,
				reason,
				googleStatus,
			);
		}
		if (res.status === 204) return undefined as T;
		return (await res.json()) as T;
	}
}

// ---- wire shapes (only the fields we read) ---------------------------------

type GmailHeader = { name?: string; value?: string };

type GmailPart = {
	partId?: string;
	mimeType?: string;
	filename?: string;
	headers?: GmailHeader[];
	body?: { size?: number; data?: string; attachmentId?: string };
	parts?: GmailPart[];
};

export type GmailMessage = {
	id: string;
	threadId: string;
	labelIds?: string[];
	snippet?: string;
	internalDate?: string;
	payload?: GmailPart;
};

export type GmailLabel = {
	id: string;
	name: string;
	type?: string;
};

export type GmailAttachment = {
	filename: string;
	mimeType: string;
	size: number;
	attachmentId?: string;
};

export type GmailAttachmentData = {
	attachmentId: string | null;
	filename: string;
	mimeType: string;
	size: number;
	data: Buffer;
};

/** A message flattened into the fields a caller actually reasons about. */
export type ParsedMessage = {
	id: string;
	threadId: string;
	from: string;
	to: string;
	subject: string;
	date: string;
	labelIds: string[];
	snippet: string;
	body: string;
	/** Every URL in the message, from the HTML hrefs as well as the plain part. */
	links: string[];
	attachments: GmailAttachment[];
	/**
	 * Envelope headers the email pipeline's signals read (ADR-118). Each is present only
	 * when the message carries it, so a message without them parses exactly as before.
	 */
	cc?: string;
	listUnsubscribe?: string;
	listId?: string;
	precedence?: string;
	autoSubmitted?: string;
};

// ---- decoding ---------------------------------------------------------------

function decodeBase64UrlBuffer(data: string): Buffer {
	return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Gmail encodes body data as base64url (RFC 4648 section 5), not standard base64. */
function decodeBase64Url(data: string): string {
	return decodeBase64UrlBuffer(data).toString("utf-8");
}

function header(part: GmailPart | undefined, name: string): string {
	const found = part?.headers?.find(
		(h) => h.name?.toLowerCase() === name.toLowerCase(),
	);
	return found?.value ?? "";
}

/**
 * Depth-first walk for the best text representation of a message.
 *
 * Prefers text/plain over text/html: multipart/alternative carries both, and the HTML
 * twin of a Gemini meeting-note mail is mostly layout markup. Falls back to HTML with
 * tags stripped when a sender ships no plain part at all, which is common for
 * transactional mail.
 */
function collectBody(part: GmailPart | undefined): string {
	if (!part) return "";
	const plain: string[] = [];
	const html: string[] = [];

	const walk = (p: GmailPart): void => {
		// A part with a filename is an attachment, not body text, even when textual.
		if (!p.filename && p.body?.data) {
			if (p.mimeType === "text/plain") plain.push(decodeBase64Url(p.body.data));
			else if (p.mimeType === "text/html") html.push(decodeBase64Url(p.body.data));
		}
		for (const child of p.parts ?? []) walk(child);
	};
	walk(part);

	if (plain.length) return plain.join("\n").trim();
	if (html.length) return stripHtml(html.join("\n"));
	return "";
}

/**
 * Reduce an HTML body to readable text.
 *
 * Anchors keep their href rather than only their text, because meeting-note mail puts
 * the document URL in the href behind a bare label like "Open in Docs" — dropping the
 * href would throw away the one field the whole pipeline is trying to reach.
 */
function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
		// Parentheses, not angle brackets: the generic tag-strip on the next line would
		// treat `<https://...>` as a tag and delete the URL it had just rescued.
		.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		// Ampersand last, so an escaped entity like &amp;lt; does not become a tag.
		.replace(/&amp;/g, "&")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Every URL in the message, gathered independently of which body part won.
 *
 * This has to be separate from collectBody, and the reason is concrete: Gemini's
 * meeting-note mail renders the document link as an anchor reading "Open meeting
 * notes". The text/plain twin keeps the words and drops the URL entirely. Since
 * collectBody rightly prefers text/plain for readability, extracting links from the
 * chosen body alone finds nothing at all — which is exactly the failure this fixes.
 */
function collectLinks(part: GmailPart | undefined): string[] {
	const out = new Set<string>();
	const walk = (p: GmailPart): void => {
		if (!p.filename && p.body?.data) {
			const text = decodeBase64Url(p.body.data);
			if (p.mimeType === "text/html") {
				for (const m of text.matchAll(/href="([^"]+)"/gi)) {
					out.add(m[1].replace(/&amp;/g, "&"));
				}
			} else if (p.mimeType === "text/plain") {
				for (const m of text.matchAll(/https?:\/\/[^\s<>()[\]"]+/g)) out.add(m[0]);
			}
		}
		for (const child of p.parts ?? []) walk(child);
	};
	if (part) walk(part);
	return [...out];
}

function collectAttachments(part: GmailPart | undefined): GmailAttachment[] {
	const out: GmailAttachment[] = [];
	const walk = (p: GmailPart): void => {
		if (p.filename) {
			out.push({
				filename: p.filename,
				mimeType: p.mimeType ?? "application/octet-stream",
				size: p.body?.size ?? 0,
				...(p.body?.attachmentId ? { attachmentId: p.body.attachmentId } : {}),
			});
		}
		for (const child of p.parts ?? []) walk(child);
	};
	if (part) walk(part);
	return out;
}

function findAttachmentPart(
	part: GmailPart | undefined,
	selector: { attachmentId?: string; filename?: string },
): GmailPart | undefined {
	if (!part) return undefined;
	const candidates: GmailPart[] = [];
	const walk = (p: GmailPart): void => {
		if (p.filename || p.body?.attachmentId) {
			candidates.push(p);
		}
		for (const child of p.parts ?? []) walk(child);
	};
	walk(part);

	if (selector.attachmentId && selector.filename) {
		const both = candidates.find(
			(p) => p.body?.attachmentId === selector.attachmentId && p.filename === selector.filename,
		);
		if (both) return both;
	}
	if (selector.attachmentId) {
		const byId = candidates.find((p) => p.body?.attachmentId === selector.attachmentId);
		if (byId) return byId;
	}
	if (selector.filename) {
		const byName = candidates.find((p) => p.filename === selector.filename);
		if (byName) return byName;
	}
	return undefined;
}

export function parseMessage(msg: GmailMessage): ParsedMessage {
	return {
		id: msg.id,
		threadId: msg.threadId,
		from: header(msg.payload, "From"),
		to: header(msg.payload, "To"),
		subject: header(msg.payload, "Subject"),
		date: header(msg.payload, "Date"),
		labelIds: msg.labelIds ?? [],
		snippet: msg.snippet ?? "",
		body: collectBody(msg.payload),
		links: collectLinks(msg.payload),
		attachments: collectAttachments(msg.payload),
		...optionalHeaders(msg),
	};
}

const OPTIONAL_ENVELOPE_HEADERS = [
	["cc", "Cc"],
	["listUnsubscribe", "List-Unsubscribe"],
	["listId", "List-Id"],
	["precedence", "Precedence"],
	["autoSubmitted", "Auto-Submitted"],
] as const;

function optionalHeaders(msg: GmailMessage): Partial<ParsedMessage> {
	const out: Record<string, string> = {};
	for (const [key, name] of OPTIONAL_ENVELOPE_HEADERS) {
		const value = header(msg.payload, name);
		if (value) out[key] = value;
	}
	return out as Partial<ParsedMessage>;
}

/**
 * One top-level header of a message, or "" when it has none. The cheap read for a
 * caller that wants the envelope and not the body: parseMessage also decodes every
 * text part and collects every link, which a sweep over a mailbox does not need.
 */
export function messageHeader(msg: GmailMessage, name: string): string {
	return header(msg.payload, name);
}

/** The two halves of one address as a header writes it. Either is null when absent. */
export type ParsedAddress = { name: string | null; address: string | null };

/**
 * Split ONE address header value (a `From`, or a single recipient) into its display
 * name and its address, in the shapes mail actually carries (RFC 5322):
 *
 *   `Angus Hally <owner@example.com>`, `"Hally, Angus" <owner@example.com>`,
 *   `<owner@example.com>`, `owner@example.com`, `owner@example.com (Angus Hally)`.
 *
 * Nothing is guessed. A value with no address in it (a bare name, a group such as
 * `undisclosed-recipients:;`, or a list of several mailboxes) keeps its text as the
 * name and gives `address: null`. Both halves are the header's own text, trimmed and
 * unquoted, never case-folded.
 */
export function parseAddress(value: string): ParsedAddress {
	const text = value.trim();
	if (!text) return { name: null, address: null };

	const angle = /^(.*)<([^<>]*)>\s*$/.exec(text);
	if (angle) {
		const address = angle[2].trim();
		return {
			name: unquoteDisplayName(angle[1]),
			address: address.includes("@") ? address : null,
		};
	}

	const bare = /^([^\s<>()",;]+@[^\s<>()",;]+)\s*(?:\((.*)\))?$/.exec(text);
	if (bare) return { name: bare[2]?.trim() || null, address: bare[1] };

	return { name: text, address: null };
}

function unquoteDisplayName(raw: string): string | null {
	let name = raw.trim();
	if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
		name = name.slice(1, -1).replace(/\\(.)/g, "$1").trim();
	}
	return name || null;
}

// ---- operations --------------------------------------------------------------

/**
 * Search messages with a Gmail query string, then fetch each hit in full.
 *
 * `messages.list` returns bare ids, so the per-hit `messages.get` is not optional — it
 * is the only way to get subject and sender. Sequential rather than parallel: a
 * detection sweep runs over a handful of results, and Gmail rate-limits per user.
 */
export async function searchMessages(
	auth: GmailAuth,
	query: string,
	maxResults: number,
	opts: { fields?: string; messageFields?: string } = {},
): Promise<ParsedMessage[]> {
	const page = await searchMessagesPage(auth, query, maxResults, {
		...opts,
		format: "full",
	});
	return page.messages;
}

export async function searchMessagesPage(
	auth: GmailAuth,
	query: string,
	maxResults: number,
	opts: {
		cursor?: string;
		format?: "full" | "metadata";
		metadataHeaders?: readonly string[];
		fields?: string;
		messageFields?: string;
	} = {},
): Promise<{ messages: ParsedMessage[]; nextCursor: string | null }> {
	const pageParam = opts.cursor ? `&pageToken=${encodeURIComponent(opts.cursor)}` : "";
	const fieldsParam = opts.fields ? `&fields=${encodeURI(opts.fields)}` : "";
	const list = await gmailFetch<{ messages?: { id: string }[]; nextPageToken?: string }>(
		auth,
		`/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}${pageParam}${fieldsParam}`,
	);
	const out: ParsedMessage[] = [];
	const format = opts.format ?? "metadata";
	for (const { id } of list.messages ?? []) {
		out.push(
			parseMessage(
				await getMessage(auth, id, {
					format,
					metadataHeaders: opts.metadataHeaders,
					fields: opts.messageFields,
				}),
			),
		);
	}
	return { messages: out, nextCursor: list.nextPageToken ?? null };
}

export async function getMessage(
	auth: GmailAuth,
	messageId: string,
	opts: {
		accessToken?: string;
		fields?: string;
		format?: "full" | "metadata";
		metadataHeaders?: readonly string[];
	} = {},
): Promise<GmailMessage> {
	const format = opts.format ?? "full";
	const headerParams = (opts.metadataHeaders ?? [])
		.map((h) => `&metadataHeaders=${encodeURIComponent(h)}`)
		.join("");
	const fieldsParam = opts.fields ? `&fields=${encodeURI(opts.fields)}` : "";
	return gmailFetch<GmailMessage>(
		auth,
		`/messages/${messageId}?format=${format}${headerParams}${fieldsParam}`,
		{ accessToken: opts.accessToken },
	);
}

export async function getMessageAttachment(
	auth: GmailAuth,
	messageId: string,
	selector: { attachmentId?: string; filename?: string },
	opts: { accessToken?: string } = {},
): Promise<GmailAttachmentData> {
	if (!selector.attachmentId && !selector.filename) {
		throw new Error("getMessageAttachment requires attachmentId or filename");
	}
	const msg = await getMessage(auth, messageId, opts);
	const part = findAttachmentPart(msg.payload, selector);
	if (!part) {
		const desc = selector.attachmentId
			? `attachmentId=${selector.attachmentId}`
			: `filename=${selector.filename}`;
		throw new Error(`Attachment not found on message ${messageId} (${desc})`);
	}

	const filename = part.filename || selector.filename || "attachment";
	const mimeType = part.mimeType ?? "application/octet-stream";
	const attachmentId = part.body?.attachmentId ?? selector.attachmentId ?? null;

	if (part.body?.data) {
		const data = decodeBase64UrlBuffer(part.body.data);
		return {
			attachmentId,
			filename,
			mimeType,
			size: part.body?.size ?? data.byteLength,
			data,
		};
	}

	if (!attachmentId) {
		throw new Error(
			`Attachment "${filename}" on message ${messageId} has neither inline data nor an attachmentId`,
		);
	}

	const res = await gmailFetch<{ data?: string; size?: number }>(
		auth,
		`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
		{ accessToken: opts.accessToken },
	);
	if (!res.data) {
		throw new Error(
			`Gmail attachment ${attachmentId} on message ${messageId} returned no data`,
		);
	}
	const data = decodeBase64UrlBuffer(res.data);
	return {
		attachmentId,
		filename,
		mimeType,
		size: res.size ?? part.body?.size ?? data.byteLength,
		data,
	};
}

export async function getThread(
	auth: GmailAuth,
	threadId: string,
	opts: { fields?: string } = {},
): Promise<ParsedMessage[]> {
	const fieldsParam = opts.fields ? `&fields=${encodeURI(opts.fields)}` : "";
	const thread = await gmailFetch<{ messages?: GmailMessage[] }>(
		auth,
		`/threads/${threadId}?format=full${fieldsParam}`,
	);
	return (thread.messages ?? []).map(parseMessage);
}

/**
 * The mailbox's own address, from Gmail's profile endpoint.
 *
 * Worth a call of its own because "which account is this token actually for?" is the
 * question that keeps biting: the --account flag names an env var, but the account is
 * decided by whoever approved the consent screen, and approving as the wrong user
 * produces a token that works perfectly against the wrong mailbox.
 */
export async function getProfile(
	auth: GmailAuth,
	opts: { accessToken?: string; fields?: string } = {},
): Promise<{ emailAddress: string; messagesTotal: number }> {
	const fieldsParam = opts.fields ? `?fields=${encodeURI(opts.fields)}` : "";
	const res = await gmailFetch<{ emailAddress?: string; messagesTotal?: number }>(
		auth,
		`/profile${fieldsParam}`,
		{ accessToken: opts.accessToken },
	);
	return {
		emailAddress: res.emailAddress ?? "(unknown)",
		messagesTotal: res.messagesTotal ?? 0,
	};
}

/** A label's thread counts: what the email pipeline's inbox and unread metrics read. */
export type GmailLabelCounts = {
	id: string;
	threadsTotal: number;
	threadsUnread: number;
	messagesTotal: number;
	messagesUnread: number;
};

/** `labels.get`: unlike `labels.list`, it carries counts. `INBOX` is the usual id. */
export async function getLabelCounts(auth: GmailAuth, labelId: string): Promise<GmailLabelCounts> {
	const res = await gmailFetch<Partial<GmailLabelCounts> & { id?: string }>(
		auth,
		`/labels/${encodeURIComponent(labelId)}`,
	);
	return {
		id: res.id ?? labelId,
		threadsTotal: res.threadsTotal ?? 0,
		threadsUnread: res.threadsUnread ?? 0,
		messagesTotal: res.messagesTotal ?? 0,
		messagesUnread: res.messagesUnread ?? 0,
	};
}

export async function listLabels(auth: GmailAuth): Promise<GmailLabel[]> {
	const res = await gmailFetch<{ labels?: GmailLabel[] }>(auth, "/labels");
	return res.labels ?? [];
}

/**
 * Create a label, or return the existing one with that name.
 *
 * Idempotent by lookup-then-create because Gmail rejects a duplicate name with a 409
 * and the caller (label setup in the meeting-note pipeline) is expected to run
 * repeatedly. Name matching is case-insensitive: Gmail treats "Meeting_Note" and
 * "meeting_note" as colliding names, so a case-sensitive check would find nothing and
 * then fail on create.
 */
export async function ensureLabel(
	auth: GmailAuth,
	name: string,
): Promise<{ label: GmailLabel; created: boolean }> {
	const existing = (await listLabels(auth)).find(
		(l) => l.name.toLowerCase() === name.toLowerCase(),
	);
	if (existing) return { label: existing, created: false };

	const label = await gmailFetch<GmailLabel>(auth, "/labels", {
		method: "POST",
		body: {
			name,
			labelListVisibility: "labelShow",
			messageListVisibility: "show",
		},
	});
	return { label, created: true };
}

/**
 * Add and remove labels on one message or one whole thread.
 *
 * Marking read (remove UNREAD) and archiving (remove INBOX) are label edits in Gmail's
 * model, so callers express them as label ids rather than through separate endpoints.
 * There is no delete path here on purpose — see the file header.
 */
export async function modifyLabels(
	auth: GmailAuth,
	target: { kind: "message" | "thread"; id: string },
	change: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<{ id: string; labelIds: string[] }> {
	const path = target.kind === "thread" ? "threads" : "messages";
	const res = await gmailFetch<{
		id: string;
		labelIds?: string[];
		messages?: GmailMessage[];
	}>(auth, `/${path}/${target.id}/modify`, {
		method: "POST",
		body: {
			addLabelIds: change.addLabelIds ?? [],
			removeLabelIds: change.removeLabelIds ?? [],
		},
	});
	// The thread endpoint answers with the thread and its messages, not a top-level
	// labelIds field; read the labels off the first message so both shapes agree.
	const labelIds = res.labelIds ?? res.messages?.[0]?.labelIds ?? [];
	return { id: res.id, labelIds };
}

// ---- discovery (issue #1210) -------------------------------------------------

/**
 * One page of `messages.list`: bare ids plus the cursor for the next page.
 *
 * Unlike searchMessages this fetches nothing per hit. The attachment discover sweep lists
 * its whole window first (ids are cheap, 500 a page) and then fetches under its own
 * per-run bound, so a large first run cannot turn into thousands of fetches in one go.
 */
export async function listMessageIds(
	auth: GmailAuth,
	query: string,
	opts: { pageToken?: string; maxResults?: number; accessToken?: string } = {},
): Promise<{ ids: string[]; nextPageToken: string | null }> {
	const page = opts.pageToken ? `&pageToken=${encodeURIComponent(opts.pageToken)}` : "";
	const res = await gmailFetch<{ messages?: { id: string }[]; nextPageToken?: string }>(
		auth,
		`/messages?q=${encodeURIComponent(query)}&maxResults=${opts.maxResults ?? 500}${page}`,
		{ accessToken: opts.accessToken },
	);
	return {
		ids: (res.messages ?? []).map((m) => m.id),
		nextPageToken: res.nextPageToken ?? null,
	};
}

/** One file-bearing MIME part of a message: what the attachment discover sweep records. */
export type GmailAttachmentPart = {
	/**
	 * Position in the MIME tree ("1", "0.2", ...), or "" for a single-part message whose
	 * whole body is the file. A message never changes after delivery, so this is stable
	 * for the life of the message, which is why the sweep keys on it.
	 */
	partId: string;
	filename: string;
	mimeType: string;
	size: number;
	/**
	 * The handle `messages.attachments.get` takes, valid for the fetch that served it.
	 * It is NOT an identifier: Gmail does not promise it is stable across `messages.get`
	 * calls, and in practice it changes, so nothing keys on it or stores it. A reader
	 * re-fetches the message, finds the part by `partId`, and uses the fresh handle.
	 */
	attachmentId: string | null;
	/**
	 * The disposition type the part's Content-Disposition declares, lower-cased
	 * ("attachment", "inline"), or null when the part declares none.
	 */
	disposition: string | null;
	/**
	 * The part carries a Content-ID, so the message body can reference it as `cid:`.
	 * With an inline image that is an embedded body resource (a signature logo, a pasted
	 * screenshot); Gmail also stamps one on ordinary attachments, so on its own it says
	 * nothing about whether the sender attached a file.
	 */
	hasContentId: boolean;
};

/**
 * Every file-bearing part of a message, depth-first.
 *
 * The same test collectAttachments applies (a part with a filename is a file, whatever
 * its MIME type), but it keeps the fields a pointer needs: the part id to key on, the
 * attachment handle, the disposition and whether the part has a Content-ID. Pure, so
 * the sweep's mapping is testable without a mailbox.
 */
export function listAttachmentParts(msg: GmailMessage): GmailAttachmentPart[] {
	const out: GmailAttachmentPart[] = [];
	const walk = (p: GmailPart): void => {
		if (p.filename) {
			const disposition = /^\s*([a-z-]+)/i.exec(header(p, "Content-Disposition"))?.[1];
			out.push({
				partId: p.partId ?? "",
				filename: p.filename,
				mimeType: p.mimeType ?? "application/octet-stream",
				size: p.body?.size ?? 0,
				attachmentId: p.body?.attachmentId ?? null,
				disposition: disposition ? disposition.toLowerCase() : null,
				hasContentId: header(p, "Content-ID").trim() !== "",
			});
		}
		for (const child of p.parts ?? []) walk(child);
	};
	if (msg.payload) walk(msg.payload);
	return out;
}

// ---- composing (issue #1006) -------------------------------------------------

/** The fields a draft is built from. `From` is deliberately absent: Gmail sets it from
 * the authenticated account, so a draft cannot claim to be from someone else. */
export type DraftFields = {
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	body: string;
	/** The `Message-ID` of the message being replied to, verbatim including angle brackets. */
	inReplyTo?: string;
	/** The reply chain: the original's References followed by its own Message-ID. */
	references?: string;
};

export type DraftSummary = {
	draftId: string;
	messageId: string;
	threadId: string;
};

/**
 * Reject a header value that could inject additional headers.
 *
 * A newline in a recipient or subject ends the header and starts a new one, so an
 * unchecked value could add a Bcc nobody approved to a message the caller thought they
 * had read. The tool layer above builds these values from model output, which makes this
 * the boundary where that stops being theoretical.
 */
function assertNoHeaderInjection(field: string, value: string): void {
	if (/[\r\n]/.test(value)) {
		throw new Error(
			`Refusing to build a message: ${field} contains a line break, which would inject a header. Value: ${JSON.stringify(value)}`,
		);
	}
}

/**
 * An address list, checked.
 *
 * ASCII-only, because correct non-ASCII addressing needs per-phrase RFC 2047 encoding of
 * the display name while the address itself needs IDN punycode, and getting that subtly
 * wrong produces mail that silently fails to deliver. Refusing loudly is better than
 * guessing; nothing in this system has needed it yet.
 */
function headerAddressList(field: string, addresses: string[]): string {
	for (const a of addresses) {
		assertNoHeaderInjection(field, a);
		if (!/^[\x20-\x7E]*$/.test(a)) {
			throw new Error(
				`Refusing to build a message: ${field} address '${a}' contains non-ASCII characters, which this client does not encode. Use a plain ASCII address.`,
			);
		}
	}
	return addresses.join(", ");
}

/** RFC 2047 encoded-word, applied only when the value is not already plain ASCII. */
function encodeHeaderText(value: string): string {
	if (/^[\x20-\x7E]*$/.test(value)) return value;
	return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * An RFC 2822 message, base64url-encoded the way Gmail's `raw` field wants it.
 *
 * The body is base64 with an explicit UTF-8 charset rather than sent as-is. That sidesteps
 * the two things that bite a hand-rolled MIME builder: a line longer than 998 octets, and
 * any non-ASCII character in an 8-bit body. Both produce mail that looks fine locally and
 * arrives mangled.
 */
export function buildRawMessage(fields: DraftFields): string {
	assertNoHeaderInjection("subject", fields.subject);
	if (fields.to.length === 0) {
		throw new Error("Refusing to build a message with no recipient in `to`.");
	}

	const headers = [`To: ${headerAddressList("to", fields.to)}`];
	if (fields.cc?.length) headers.push(`Cc: ${headerAddressList("cc", fields.cc)}`);
	if (fields.bcc?.length) headers.push(`Bcc: ${headerAddressList("bcc", fields.bcc)}`);
	headers.push(`Subject: ${encodeHeaderText(fields.subject)}`);
	if (fields.inReplyTo) {
		assertNoHeaderInjection("in-reply-to", fields.inReplyTo);
		headers.push(`In-Reply-To: ${fields.inReplyTo}`);
	}
	if (fields.references) {
		assertNoHeaderInjection("references", fields.references);
		headers.push(`References: ${fields.references}`);
	}
	headers.push(
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="UTF-8"',
		"Content-Transfer-Encoding: base64",
	);

	// 76-character lines: the limit base64 in mail is expected to wrap at.
	const body = Buffer.from(fields.body, "utf8")
		.toString("base64")
		.replace(/(.{76})/g, "$1\r\n");

	return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString(
		"base64url",
	);
}

/** What a reply needs from the message it is replying to, so it threads correctly. */
export type ReplyContext = {
	threadId: string;
	/** The original's `Message-ID` header, for `In-Reply-To`. */
	messageIdHeader: string;
	/** The chain to put in `References`: the original's own References, then its Message-ID. */
	references: string;
	/** The original subject, already `Re:`-prefixed unless it was one. */
	replySubject: string;
	/** The original sender, the default recipient of a reply. */
	from: string;
};

/**
 * Read the threading headers off a message.
 *
 * Gmail's `threadId` alone is not enough. It puts the reply in the right Gmail
 * conversation, but every other mail client threads on `In-Reply-To` and `References`,
 * so a reply carrying only threadId arrives at the recipient as a new conversation. Both
 * halves are needed, which is why this exists rather than callers passing threadId around.
 */
export async function getReplyContext(
	auth: GmailAuth,
	messageId: string,
): Promise<ReplyContext> {
	const msg = await getMessage(auth, messageId);
	const messageIdHeader = header(msg.payload, "Message-ID");
	const priorReferences = header(msg.payload, "References");
	const subject = header(msg.payload, "Subject");

	return {
		threadId: msg.threadId,
		messageIdHeader,
		references: [priorReferences, messageIdHeader].filter(Boolean).join(" "),
		replySubject: /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`,
		from: header(msg.payload, "From"),
	};
}

// ---- drafts and sending ------------------------------------------------------

type DraftWire = { id: string; message?: { id?: string; threadId?: string } };

/** Create a draft. `threadId` puts it in an existing Gmail conversation. */
export async function createDraft(
	auth: GmailAuth,
	raw: string,
	threadId?: string,
): Promise<DraftSummary> {
	const res = await gmailFetch<DraftWire>(auth, "/drafts", {
		method: "POST",
		body: { message: { raw, ...(threadId ? { threadId } : {}) } },
	});
	return summariseDraft(res);
}

/** Replace an existing draft's content. Same draft id, new body. */
export async function updateDraft(
	auth: GmailAuth,
	draftId: string,
	raw: string,
	threadId?: string,
): Promise<DraftSummary> {
	const res = await gmailFetch<DraftWire>(auth, `/drafts/${draftId}`, {
		method: "PUT",
		body: { id: draftId, message: { raw, ...(threadId ? { threadId } : {}) } },
	});
	return summariseDraft(res);
}

/** Read a draft back as a parsed message, so a caller can show what will go out. */
export async function getDraft(
	auth: GmailAuth,
	draftId: string,
): Promise<ParsedMessage> {
	const res = await gmailFetch<{ id: string; message?: GmailMessage }>(
		auth,
		`/drafts/${draftId}?format=full`,
	);
	if (!res.message) {
		throw new Error(`Draft ${draftId} in account '${auth.label}' has no message body.`);
	}
	return parseMessage(res.message);
}

/**
 * Send an existing draft.
 *
 * Takes a draft id and nothing else: it cannot compose, so there is no path from "some
 * text" to "sent mail" that does not pass through a draft sitting in the mailbox first,
 * paired with the owner approval gate on outward sends above this client.
 */
export async function sendDraft(
	auth: GmailAuth,
	draftId: string,
): Promise<{ messageId: string; threadId: string }> {
	const res = await gmailFetch<{ id?: string; threadId?: string }>(
		auth,
		"/drafts/send",
		{ method: "POST", body: { id: draftId } },
	);
	return { messageId: res.id ?? "(unknown)", threadId: res.threadId ?? "(unknown)" };
}

function summariseDraft(res: DraftWire): DraftSummary {
	return {
		draftId: res.id,
		messageId: res.message?.id ?? "(unknown)",
		threadId: res.message?.threadId ?? "(unknown)",
	};
}

/** `• [id | thread: threadId] Subject — From (date, flags)`, matching drive.ts's formatFile convention. */
export function formatMessage(m: ParsedMessage): string {
	const flags = [
		m.labelIds.includes(LABEL_UNREAD) ? "unread" : "read",
		m.labelIds.includes(LABEL_INBOX) ? "inbox" : "archived",
	];
	return `• [${m.id} | thread: ${m.threadId}] ${m.subject || "(no subject)"} — ${m.from} (${m.date}, ${flags.join(", ")})`;
}
