import {
	createDraft as coreCreateDraft,
	ensureLabel as coreEnsureLabel,
	getDraft as coreGetDraft,
	getLabelCounts as coreGetLabelCounts,
	getMessage as coreGetMessage,
	getProfile as coreGetProfile,
	getReplyContext as coreGetReplyContext,
	getThread as coreGetThread,
	listLabels as coreListLabels,
	listMessageIds as coreListMessageIds,
	modifyLabels as coreModifyLabels,
	parseAddress,
	searchMessages as coreSearchMessages,
	sendDraft as coreSendDraft,
	updateDraft as coreUpdateDraft,
	type DraftSummary,
	type GmailAuth,
	type GmailLabel,
	type GmailLabelCounts,
	type GmailMessage,
	type ParsedAddress,
	type ParsedMessage,
	type ReplyContext,
} from "@ahkms/core/adapters";
import { getGoogleAccessToken } from "./oauth.js";
import { DEFAULT_GOOGLE_ACCOUNT, GOOGLE_ACCOUNTS, type GoogleAccount } from "./accounts.js";

export {
	LABEL_INBOX,
	LABEL_UNREAD,
	buildRawMessage,
	formatMessage,
	listAttachmentParts,
	messageHeader,
	parseAddress,
	parseMessage,
	type DraftFields,
	type DraftSummary,
	type GmailAttachment,
	type GmailAttachmentPart,
	type GmailAuth,
	type GmailLabel,
	type GmailMessage,
	type ParsedAddress,
	type ParsedMessage,
	type ReplyContext,
} from "@ahkms/core/adapters";

export async function getGmailAccessToken(
	account: GoogleAccount = DEFAULT_GOOGLE_ACCOUNT,
	refreshToken?: string,
): Promise<string> {
	return getGoogleAccessToken(account, "Gmail", refreshToken);
}

const authFor = (account: GoogleAccount): GmailAuth => ({
	label: account,
	accessToken: () => getGmailAccessToken(account),
});

export function searchMessages(
	account: GoogleAccount,
	query: string,
	maxResults: number,
): Promise<ParsedMessage[]> {
	return coreSearchMessages(authFor(account), query, maxResults);
}

export function getMessage(
	account: GoogleAccount,
	messageId: string,
	opts: { accessToken?: string } = {},
): Promise<GmailMessage> {
	return coreGetMessage(authFor(account), messageId, opts);
}

export function getThread(
	account: GoogleAccount,
	threadId: string,
): Promise<ParsedMessage[]> {
	return coreGetThread(authFor(account), threadId);
}

export function getProfile(
	account: GoogleAccount,
	opts: { accessToken?: string } = {},
): Promise<{ emailAddress: string; messagesTotal: number }> {
	return coreGetProfile(authFor(account), opts);
}

export function listLabels(account: GoogleAccount): Promise<GmailLabel[]> {
	return coreListLabels(authFor(account));
}

export function getLabelCounts(account: GoogleAccount, labelId: string): Promise<GmailLabelCounts> {
	return coreGetLabelCounts(authFor(account), labelId);
}

export function ensureLabel(
	account: GoogleAccount,
	name: string,
): Promise<{ label: GmailLabel; created: boolean }> {
	return coreEnsureLabel(authFor(account), name);
}

export function modifyLabels(
	account: GoogleAccount,
	target: { kind: "message" | "thread"; id: string },
	change: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<{ id: string; labelIds: string[] }> {
	return coreModifyLabels(authFor(account), target, change);
}

export function listMessageIds(
	account: GoogleAccount,
	query: string,
	opts: { pageToken?: string; maxResults?: number; accessToken?: string } = {},
): Promise<{ ids: string[]; nextPageToken: string | null }> {
	return coreListMessageIds(authFor(account), query, opts);
}

export function getReplyContext(
	account: GoogleAccount,
	messageId: string,
): Promise<ReplyContext> {
	return coreGetReplyContext(authFor(account), messageId);
}

export function createDraft(
	account: GoogleAccount,
	raw: string,
	threadId?: string,
): Promise<DraftSummary> {
	return coreCreateDraft(authFor(account), raw, threadId);
}

export function updateDraft(
	account: GoogleAccount,
	draftId: string,
	raw: string,
	threadId?: string,
): Promise<DraftSummary> {
	return coreUpdateDraft(authFor(account), draftId, raw, threadId);
}

export function getDraft(
	account: GoogleAccount,
	draftId: string,
): Promise<ParsedMessage> {
	return coreGetDraft(authFor(account), draftId);
}

export function sendDraft(
	account: GoogleAccount,
	draftId: string,
): Promise<{ messageId: string; threadId: string }> {
	return coreSendDraft(authFor(account), draftId);
}

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export type DraftRecipients = { to: ParsedAddress[]; cc: ParsedAddress[]; bcc: ParsedAddress[] };

/** Split an RFC 5322 address-list header on commas outside quotes, angle brackets and comments. */
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

/** Read a stored draft's `To`, `Cc` and `Bcc` headers from `format=metadata`. */
export async function getDraftRecipients(account: GoogleAccount, draftId: string): Promise<DraftRecipients> {
	const token = await getGmailAccessToken(account);
	const path = `/drafts/${draftId}?format=metadata`;
	const res = await fetch(`${GMAIL_API}${path}`, {
		method: "GET",
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) {
		throw new Error(`Gmail API GET ${path} failed for account '${account}' (${res.status}): ${await res.text()}`);
	}
	const data = (await res.json()) as { id?: string; message?: GmailMessage };
	if (!data.message) throw new Error(`Draft ${draftId} in account '${account}' has no message body.`);
	const out: DraftRecipients = { to: [], cc: [], bcc: [] };
	for (const h of data.message.payload?.headers ?? []) {
		const name = h.name?.toLowerCase();
		if (name === "to" || name === "cc" || name === "bcc") out[name].push(...parseAddressList(h.value ?? ""));
	}
	return out;
}

const cachedOwnerByAccount = new Map<GoogleAccount, string>();

/** Connected-account Gmail profile addresses for the owner (ADR-104 D4). */
export async function ownerAddresses(): Promise<ReadonlySet<string>> {
	for (const account of GOOGLE_ACCOUNTS) {
		if (cachedOwnerByAccount.has(account)) continue;
		try {
			const email = (await getProfile(account)).emailAddress?.trim();
			if (email && email !== "(unknown)") cachedOwnerByAccount.set(account, email.toLowerCase());
		} catch { /* Leave uncached so the next call retries this account. */ }
	}
	const addresses = new Set(cachedOwnerByAccount.values());
	if (addresses.size === 0) throw new Error("Could not resolve any owner Gmail profile address from GOOGLE_ACCOUNTS.");
	return addresses;
}

/** Test-only reset for the `ownerAddresses` cache. */
export function resetOwnerAddressesForTests(): void {
	cachedOwnerByAccount.clear();
}
