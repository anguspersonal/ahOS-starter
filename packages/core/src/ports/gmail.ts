import type { Domain } from "../domain/domains.js";

export type GmailAccount = "personal" | "work";
export const LABEL_UNREAD = "UNREAD";
export const LABEL_INBOX = "INBOX";
export const MESSAGE_FIELDS = "id,threadId,labelIds,snippet,internalDate,payload";
export const LIST_MESSAGES_FIELDS = "messages(id),nextPageToken";
export const THREAD_FIELDS = `messages(${MESSAGE_FIELDS})`;
export const PROFILE_FIELDS = "emailAddress,messagesTotal";
export const LIST_LABELS_FIELDS = "labels(id,name,type)";
export const DRAFT_FIELDS = `id,message(${MESSAGE_FIELDS})`;
export const DRAFT_METADATA_FIELDS = "id,message(id,threadId,payload(headers))";

export class GmailApiError extends Error {
	constructor(message: string, readonly status: number, readonly reason?: string, readonly googleStatus?: string) {
		super(message);
		this.name = "GmailApiError";
	}
}

export type GmailHeader = { name?: string; value?: string };
export type GmailPart = {
	partId?: string;
	mimeType?: string;
	filename?: string;
	headers?: GmailHeader[];
	body?: { size?: number; data?: string; attachmentId?: string };
	parts?: GmailPart[];
};
export type GmailMessage = { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: GmailPart };
export type GmailLabel = { id: string; name: string; type?: string };
export type GmailAttachment = { filename: string; mimeType: string; size: number; attachmentId?: string };
export type ParsedMessage = {
	id: string; threadId: string; from: string; to: string; subject: string; date: string;
	labelIds: string[]; snippet: string; body: string; links: string[]; attachments: GmailAttachment[];
	cc?: string; bcc?: string;
};
export type ParsedAddress = { name: string | null; address: string | null };
export type GmailProfile = { emailAddress: string; messagesTotal: number };
export type DraftFields = {
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	body: string;
	inReplyTo?: string;
	references?: string;
};
export type DraftSummary = { draftId: string; messageId: string; threadId: string };
export type ReplyContext = {
	threadId: string;
	messageIdHeader: string;
	references: string;
	replySubject: string;
	from: string;
};

export const SEARCH_METADATA_HEADERS = ["From", "To", "Subject", "Date"] as const;

export type GmailSearchMessagesParams = { domain: Domain; query: string; maxResults?: number; fields?: string; messageFields?: string };
export type GmailSearchPageParams = {
	domain: Domain;
	query: string;
	maxResults?: number;
	cursor?: string;
	format?: "full" | "metadata";
	metadataHeaders?: readonly string[];
	fields?: string;
	messageFields?: string;
};
export type GmailSearchPageResult = {
	messages: ParsedMessage[];
	nextCursor: string | null;
};
export type GmailGetMessageParams = {
	domain: Domain;
	messageId: string;
	fields?: string;
	format?: "full" | "metadata";
	metadataHeaders?: readonly string[];
};
export type GmailGetThreadParams = { domain: Domain; threadId: string; fields?: string };
export type GmailGetProfileParams = { domain: Domain; fields?: string };
export type GmailListLabelsParams = { domain: Domain; fields?: string };
export type GmailEnsureLabelParams = { domain: Domain; name: string; fields?: string };
export type GmailEnsureLabelResult = { label: GmailLabel; created: boolean };
export type GmailGetReplyContextParams = { domain: Domain; messageId: string; fields?: string };
export type GmailCreateDraftParams = { domain: Domain; raw: string; threadId?: string };
export type GmailUpdateDraftParams = { domain: Domain; draftId: string; raw: string; threadId?: string };
export type GmailGetDraftParams = { domain: Domain; draftId: string; format?: "full" | "metadata"; fields?: string };
export type GmailSendDraftParams = { domain: Domain; draftId: string };
export type GmailSendDraftResult = { messageId: string; threadId: string };
export type GmailModifyLabelsParams = {
	domain: Domain;
	target: { kind: "message" | "thread"; id: string };
	addLabelIds?: string[];
	removeLabelIds?: string[];
};
export type GmailModifyLabelsResult = { id: string; labelIds: string[] };

export interface GmailPort {
	searchMessages(params: GmailSearchMessagesParams): Promise<ParsedMessage[]>;
	searchMessagesPage?(params: GmailSearchPageParams): Promise<GmailSearchPageResult>;
	getMessage(params: GmailGetMessageParams): Promise<GmailMessage>;
	getThread(params: GmailGetThreadParams): Promise<ParsedMessage[]>;
	getProfile(params: GmailGetProfileParams): Promise<GmailProfile>;
	listLabels(params: GmailListLabelsParams): Promise<GmailLabel[]>;
	ensureLabel(params: GmailEnsureLabelParams): Promise<GmailEnsureLabelResult>;
	getReplyContext(params: GmailGetReplyContextParams): Promise<ReplyContext>;
	createDraft(params: GmailCreateDraftParams): Promise<DraftSummary>;
	updateDraft(params: GmailUpdateDraftParams): Promise<DraftSummary>;
	getDraft(params: GmailGetDraftParams): Promise<ParsedMessage>;
	sendDraft(params: GmailSendDraftParams): Promise<GmailSendDraftResult>;
	modifyLabels(params: GmailModifyLabelsParams): Promise<GmailModifyLabelsResult>;
}

const encodeB64 = (s: string): string =>
	btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(""));
const encodeB64Url = (s: string): string =>
	encodeB64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function assertNoHeaderInjection(field: string, value: string): void {
	if (/[\r\n]/.test(value)) {
		throw new Error(`Refusing to build a message: ${field} contains a line break, which would inject a header. Value: ${JSON.stringify(value)}`);
	}
}

function headerAddressList(field: string, addresses: string[]): string {
	for (const a of addresses) {
		assertNoHeaderInjection(field, a);
		if (!/^[\x20-\x7E]*$/.test(a)) {
			throw new Error(`Refusing to build a message: ${field} address '${a}' contains non-ASCII characters, which this client does not encode. Use a plain ASCII address.`);
		}
	}
	return addresses.join(", ");
}

export function buildRawMessage(fields: DraftFields): string {
	assertNoHeaderInjection("subject", fields.subject);
	if (fields.to.length === 0) throw new Error("Refusing to build a message with no recipient in `to`.");
	const subject = /^[\x20-\x7E]*$/.test(fields.subject) ? fields.subject : `=?UTF-8?B?${encodeB64(fields.subject)}?=`;
	const headers = [`To: ${headerAddressList("to", fields.to)}`];
	if (fields.cc?.length) headers.push(`Cc: ${headerAddressList("cc", fields.cc)}`);
	if (fields.bcc?.length) headers.push(`Bcc: ${headerAddressList("bcc", fields.bcc)}`);
	headers.push(`Subject: ${subject}`);
	if (fields.inReplyTo) { assertNoHeaderInjection("in-reply-to", fields.inReplyTo); headers.push(`In-Reply-To: ${fields.inReplyTo}`); }
	if (fields.references) { assertNoHeaderInjection("references", fields.references); headers.push(`References: ${fields.references}`); }
	headers.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
	const body = encodeB64(fields.body).replace(/(.{76})/g, "$1\r\n");
	return encodeB64Url(`${headers.join("\r\n")}\r\n\r\n${body}`);
}

const decodeB64Url = (d: string): string => {
	const s = d.replace(/-/g, "+").replace(/_/g, "/");
	return new TextDecoder().decode(Uint8Array.from(atob(s.padEnd(s.length + ((4 - (s.length % 4)) % 4), "=")), (c) => c.charCodeAt(0)));
};

const stripHtml = (h: string): string =>
	h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|tr|h[1-6])>/gi, "\n")
		.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)").replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
		.replace(/\n{3,}/g, "\n\n").trim();

export function envelopeRecipients(msg: GmailMessage): { to: string; cc?: string; bcc?: string } {
	const all = (n: string) =>
		(msg.payload?.headers ?? [])
			.filter((h) => h.name?.toLowerCase() === n && h.value)
			.map((h) => h.value as string)
			.join(", ");
	const cc = all("cc");
	const bcc = all("bcc");
	return { to: all("to"), ...(cc ? { cc } : {}), ...(bcc ? { bcc } : {}) };
}

export function parseAddress(value: string): ParsedAddress {
	const text = value.trim();
	if (!text) return { name: null, address: null };
	const angle = /^(.*)<([^<>]*)>\s*$/.exec(text);
	if (angle) {
		let name = angle[1].trim();
		if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
			name = name.slice(1, -1).replace(/\\(.)/g, "$1").trim();
		}
		const address = angle[2].trim();
		return { name: name || null, address: address.includes("@") ? address : null };
	}
	const bare = /^([^\s<>()",;]+@[^\s<>()",;]+)\s*(?:\((.*)\))?$/.exec(text);
	if (bare) return { name: bare[2]?.trim() || null, address: bare[1] };
	return { name: text, address: null };
}

export function parseAddressList(value: string): ParsedAddress[] {
	if (!value.trim()) return [];
	const parts: string[] = [];
	let current = "";
	let inQuotes = false;
	let angleDepth = 0;
	let commentDepth = 0;
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		if ((inQuotes || commentDepth > 0) && ch === "\\" && i + 1 < value.length) {
			current += ch + value[++i];
			continue;
		}
		if (commentDepth === 0 && ch === '"') inQuotes = !inQuotes;
		else if (!inQuotes) {
			if (angleDepth === 0 && ch === "(") commentDepth += 1;
			else if (commentDepth > 0 && ch === ")") commentDepth -= 1;
			else if (commentDepth === 0 && ch === "<") angleDepth += 1;
			else if (commentDepth === 0 && angleDepth > 0 && ch === ">") angleDepth -= 1;
			else if (commentDepth === 0 && angleDepth === 0 && ch === ",") {
				parts.push(current);
				current = "";
				continue;
			}
		}
		current += ch;
	}
	parts.push(current);
	return parts.map(parseAddress);
}

export function parseMessage(msg: GmailMessage): ParsedMessage {
	const hdr = (n: string) => msg.payload?.headers?.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
	const plain: string[] = [], html: string[] = [], links = new Set<string>(), attachments: GmailAttachment[] = [];
	const walk = (p: GmailPart): void => {
		if (p.filename) attachments.push({ filename: p.filename, mimeType: p.mimeType ?? "application/octet-stream", size: p.body?.size ?? 0, ...(p.body?.attachmentId ? { attachmentId: p.body.attachmentId } : {}) });
		else if (p.body?.data) {
			const t = decodeB64Url(p.body.data);
			if (p.mimeType === "text/plain") { plain.push(t); for (const m of t.matchAll(/https?:\/\/[^\s<>()[\]"]+/g)) links.add(m[0]); }
			else if (p.mimeType === "text/html") { html.push(t); for (const m of t.matchAll(/href="([^"]+)"/gi)) links.add(m[1].replace(/&amp;/g, "&")); }
		}
		for (const c of p.parts ?? []) walk(c);
	};
	if (msg.payload) walk(msg.payload);
	const body = plain.length ? plain.join("\n").trim() : html.length ? stripHtml(html.join("\n")) : "";
	return { id: msg.id, threadId: msg.threadId, from: hdr("From"), ...envelopeRecipients(msg), subject: hdr("Subject"), date: hdr("Date"), labelIds: msg.labelIds ?? [], snippet: msg.snippet ?? "", body, links: [...links], attachments };
}

export function formatMessage(m: ParsedMessage): string {
	const flags = [m.labelIds.includes(LABEL_UNREAD) ? "unread" : "read", m.labelIds.includes(LABEL_INBOX) ? "inbox" : "archived"];
	return `• [${m.id} | thread: ${m.threadId}] ${m.subject || "(no subject)"} — ${m.from} (${m.date}, ${flags.join(", ")})`;
}
