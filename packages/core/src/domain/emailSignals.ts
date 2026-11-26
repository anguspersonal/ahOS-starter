/**
 * @ahkms/core/domain - emailSignals.ts
 *
 * Deterministic envelope signals for the email pipeline (ADR-118). Everything here is
 * System 1: cheap, explainable, and computed from headers, Gmail labels and short text
 * cues, never from a model.
 *
 * Gmail's own sorting (the CATEGORY_* tabs and IMPORTANT) is read as a weak prior and
 * never as a verdict. Header evidence (List-Unsubscribe, Precedence, Auto-Submitted)
 * and the owner's knowledge graph outrank it, and a disagreement between Gmail and the
 * graph is surfaced as a signal of its own so the router can send it for review.
 *
 * Isomorphic: zero Node imports.
 */

export const GMAIL_CATEGORIES = [
	"primary",
	"promotions",
	"social",
	"updates",
	"forums",
	"unknown",
] as const;

export type GmailCategory = (typeof GMAIL_CATEGORIES)[number];

const GMAIL_CATEGORY_BY_LABEL: Readonly<Record<string, GmailCategory>> = Object.freeze({
	CATEGORY_PERSONAL: "primary",
	CATEGORY_PROMOTIONS: "promotions",
	CATEGORY_SOCIAL: "social",
	CATEGORY_UPDATES: "updates",
	CATEGORY_FORUMS: "forums",
});

export const SENDER_KINDS = [
	"self",
	"known_contact",
	"human",
	"automated",
	"bulk",
] as const;

export type SenderKind = (typeof SENDER_KINDS)[number];

export interface EmailEnvelopeInput {
	from: string;
	to?: string | null;
	cc?: string | null;
	subject?: string | null;
	snippet?: string | null;
	body?: string | null;
	labelIds?: readonly string[] | null;
	listUnsubscribe?: string | null;
	listId?: string | null;
	precedence?: string | null;
	autoSubmitted?: string | null;
}

export type SenderOverrideDirection = "to_respond" | "archive";

export const MIN_SENDER_OVERRIDES_FOR_RULE = 2;

export interface EmailSenderOverrideFact {
	sender: string;
	direction?: SenderOverrideDirection | null;
	intent_category?: string | null;
	route?: string | null;
	gmail_action?: string | null;
	priority?: number | null;
	status?: string | null;
}

export interface EmailSignalOptions {
	/** Every address the owner sends and receives as (all domains). Case-insensitive. */
	ownerAddresses: readonly string[];
	/** The sender matched a person in the owner's graph. */
	knownContact?: boolean;
	/** Matched `people.id` when `knownContact` is true. */
	contactId?: string | null;
	/** True when the sender matched a `people` row by name whose `email` column is still null/empty. */
	contactMissingEmail?: boolean;
	/** The graph's relationship label for the sender, when known (e.g. "co-founder"). */
	relationship?: string | null;
	/**
	 * The owner has sent mail to this sender before, from any mailbox. `null` or absent
	 * means nobody checked, which is never read as "no".
	 */
	ownerHasWritten?: boolean | null;
	/** Past owner corrections used to promote repeated (>= 2) same-direction sender overrides. */
	senderOverrides?: readonly EmailSenderOverrideFact[];
	/** Explicit promoted sender override direction when already resolved by the caller. */
	senderOverrideDirection?: SenderOverrideDirection | null;
}

export interface EmailTextCues {
	urgency: boolean;
	ask: boolean;
	deadline: boolean;
	money: boolean;
	security: boolean;
	legal: boolean;
	meetingInvite: boolean;
	meetingResponse: boolean;
	meetingNotes: boolean;
	promo: boolean;
	receipt: boolean;
	sharedDocument: boolean;
	socialNotification: boolean;
	/** Sales-sequence language: seller job titles, "worth a quick call?", "a one-word reply is enough". */
	salesPitch: boolean;
}

export interface EmailSignals {
	senderAddress: string;
	senderName: string | null;
	senderDomain: string;
	senderKind: SenderKind;
	isFromOwner: boolean;
	isDirectRecipient: boolean;
	isCcOnly: boolean;
	gmailCategory: GmailCategory;
	gmailImportant: boolean;
	starred: boolean;
	unread: boolean;
	hasListUnsubscribe: boolean;
	hasBulkHeaders: boolean;
	isAutoSubmitted: boolean;
	isNoReplySender: boolean;
	/** A shared mailbox (hello@, info@, support@): automated unless the text asks something. */
	isRoleAddress: boolean;
	/** An alert ahOS (or another owned system) sent the owner, e.g. "[ahOS] ...". */
	isSystemAlert: boolean;
	knownContact: boolean;
	contactId: string | null;
	contactMissingEmail: boolean;
	relationship: string | null;
	/** See `EmailSignalOptions.ownerHasWritten`; `null` when unchecked. */
	ownerHasWritten: boolean | null;
	cues: EmailTextCues;
	/**
	 * Cold sales outreach: a person the graph does not know, whom the owner has never
	 * written to, using sales-sequence language, about nothing sensitive. Needs the
	 * sent-mail check to have answered "no"; an unchecked history never counts.
	 */
	isColdOutreach: boolean;
	/** Money at risk (not a receipt), security or legal: never archive on System 1 alone. */
	isSensitive: boolean;
	/**
	 * Gmail filed this outside Primary, but the graph knows the sender or the text holds
	 * a direct ask from a human. The case that makes Gmail sorting untrustworthy.
	 */
	gmailCategoryContradiction: boolean;
	/** Deterministic rule promoted when the owner corrected this sender >= 2 times in the same direction. */
	learnedSenderOverride?: SenderOverrideDirection | null;
	/** Count of same-direction owner overrides observed for this sender. */
	senderOverrideCount?: number;
}

const NO_REPLY_PATTERN =
	/(^|[._+-])(no-?reply|do-?not-?reply|donotreply|noreply|no_reply|notifications?|notify|notices|alerts?|mailer|mailer-daemon|bounce|newsletters?|digest|marketing|offers|specialoffers|promo|receipts?|[a-z]+-notes|calendar-notification)([._+-]|$)/i;

// Shared mailboxes a person sometimes writes from (a founder's hello@). Weak on their
// own: a role address only reads as a person when the text asks something and sells nothing.
const ROLE_ADDRESS_PATTERN =
	/^(info|hello|hi|hey|team|support|service|billing|accounts?|updates?|news|contact|customerservices?|care|help|admin|sales|events?|wedo)$/i;

const BULK_SENDER_DOMAIN_PATTERN =
	/(^|\.)(mail|email|e|news|newsletter|send|sender|comms|notify|notifications|mailing|marketing|updates|em|m|info|service)\.[a-z0-9-]+\.[a-z.]+$/i;

const CUE_PATTERNS: Readonly<Record<keyof EmailTextCues, RegExp>> = Object.freeze({
	urgency:
		/\b(urgent|asap|immediately|time[- ]sensitive|blocking|blocker|critical|right away)\b/i,
	// Phrases that ask the owner for something, or a question aimed at "you". A bare "?"
	// is not an ask: marketing copy is full of rhetorical questions.
	ask: /\b(can you|could you|would you|will you|are you (free|around|available|able)|do you have (time|a minute)|please (review|confirm|send|share|sign|approve|reply|let me know|advise|take a look)|let me know|thoughts\?|wdyt|when suits|what time works|does .{0,30} work for you)|\b(you|your)\b[^.?!\n]{0,80}\?/i,
	deadline:
		/\b(by (eod|end of day|tomorrow|monday|tuesday|wednesday|thursday|friday|\d{1,2}(st|nd|rd|th)?)|deadline|due (date|today|tomorrow|on)|expires? (today|tomorrow|soon|on)|overdue)\b/i,
	money:
		/\b(invoice|payment (failed|due|declined|overdue)|overdue|direct debit|refund|chargeback|tax return|hmrc|vat|payroll|payout|you('ve)? received money|bank transfer|wire transfer|outstanding balance)\b/i,
	security:
		/\b(security (alert|incident)|data breach|breach|suspicious (sign[- ]?in|activity|login)|password (reset|changed)|new sign[- ]?in|verification code|2fa|two[- ]factor|unauthori[sz]ed|account (locked|suspended|compromised)|details were accessed)\b/i,
	legal:
		/\b(contract|agreement|nda|term sheet|docusign|signature (required|requested)|please sign|legal notice|subpoena|court|tribunal|shareholder|board (resolution|consent)|cap table)\b/i,
	meetingInvite:
		/^(invitation|updated invitation|new event|invitation from google calendar)\b|\binvitation:\s/i,
	meetingResponse: /^(accepted|declined|tentatively accepted|tentative):\s/i,
	meetingNotes: /^(notes:|meeting notes|summary of|recap:)/i,
	promo:
		/(\d{1,2}% off|\b(sale|black friday|cyber monday|singles day|discount|promo( code)?|special offer|limited time|free shipping|shop now|shop the|exclusive offer|deal of|save \d+|stock up|gift guide|gifts for|win a|new arrivals|new collection|last chance|book now|tickets? (now|on sale|released)|presale|webinar|register now)\b)/i,
	receipt:
		/\b(receipt|order (confirmation|confirmed|receipt)|your order|payment received|invoice #|statement is ready|transaction summary|your (bill|statement))\b/i,
	sharedDocument:
		/\b(shared with you|share request|invited you to (edit|view|comment)|document shared|folder shared|requested access)\b/i,
	socialNotification:
		/\b(started following you|liked your|commented on your|mentioned you|new follower|connection request|endorsed you|viewed your profile)\b/i,
	// Sales sequences written by (or for) a person. Weak alone: it only archives a
	// thread together with the sent-mail check (`isColdOutreach`).
	salesPitch:
		/\b(partnerships? manager|account executive|business development (manager|representative|rep|lead)|sales (development|executive)|growth partner|worth (seeing|exploring|a (quick )?(look|chat|call))|open to an? (quick |short )?(call|chat|intro|conversation)|an? one[- ]word reply|(not|no longer) (the right|a) (fit|person)|(bumping|circling back on|following up on) (this|my (last|previous|earlier) (email|note|message))|book (a|some) time (with me|in my calendar)|grab (15|20|30) minutes|(15|20|30)[- ]min(ute)? (call|chat)|official [a-z0-9 ]{1,20}(partner|reseller)|we help (companies|startups|teams|founders|brands)|\d{1,2}% (discount|saving|savings|cheaper) on)\b/i,
});

const SYSTEM_ALERT_SUBJECT_PATTERN = /^\s*\[(ahos|ahkms|work[- ]ops)\]/i;

export function normaliseAddress(value: string | null | undefined): string {
	if (!value) return "";
	const angle = /<([^<>]+)>/.exec(value);
	const raw = (angle ? angle[1] : value).trim().toLowerCase();
	const bare = /[^\s<>"(),;]+@[^\s<>"(),;]+/.exec(raw);
	return bare ? bare[0] : "";
}

export function extractDisplayName(value: string | null | undefined): string | null {
	if (!value) return null;
	const angle = /^(.*)<[^<>]*>\s*$/.exec(value.trim());
	if (!angle) return null;
	const name = angle[1].trim().replace(/^"(.*)"$/, "$1").trim();
	return name.length > 0 ? name : null;
}

function addressList(value: string | null | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((part) => normaliseAddress(part))
		.filter((addr) => addr.length > 0);
}

/** The Gmail tab a message sits in, read from its CATEGORY_* label. */
export function resolveGmailCategory(labelIds: readonly string[] | null | undefined): GmailCategory {
	for (const label of labelIds ?? []) {
		const category = GMAIL_CATEGORY_BY_LABEL[label];
		if (category) return category;
	}
	return "unknown";
}

export function detectEmailCues(subject: string, text: string): EmailTextCues {
	const combined = `${subject}\n${text}`;
	return {
		urgency: CUE_PATTERNS.urgency.test(combined),
		ask: CUE_PATTERNS.ask.test(combined),
		deadline: CUE_PATTERNS.deadline.test(combined),
		money: CUE_PATTERNS.money.test(combined),
		security: CUE_PATTERNS.security.test(combined),
		legal: CUE_PATTERNS.legal.test(combined),
		meetingInvite: CUE_PATTERNS.meetingInvite.test(subject.trim()),
		meetingResponse: CUE_PATTERNS.meetingResponse.test(subject.trim()),
		meetingNotes: CUE_PATTERNS.meetingNotes.test(subject.trim()),
		promo: CUE_PATTERNS.promo.test(combined),
		receipt: CUE_PATTERNS.receipt.test(combined),
		sharedDocument: CUE_PATTERNS.sharedDocument.test(combined),
		socialNotification: CUE_PATTERNS.socialNotification.test(combined),
		salesPitch: CUE_PATTERNS.salesPitch.test(combined),
	};
}

const RELATIONSHIP_TAG_PRIORITY = [
	"dad",
	"mum",
	"father",
	"mother",
	"wife",
	"husband",
	"partner",
	"fiance",
	"fiancee",
	"brother",
	"sister",
	"family",
	"co-founder",
	"cofounder",
	"investor",
	"advisor",
	"board",
	"client",
	"customer",
] as const;

/**
 * Resolve a person's relationship label from `relationship`, falling back to relationship
 * tags (e.g. `tags: ["family", "dad"]` on Paul Hally) or `role` (e.g. `role: "Coaching Client"`
 * on Nick Carmont) when `relationship` is null.
 */
export function resolvePersonRelationship(row: {
	relationship?: string | null;
	role?: string | null;
	tags?: readonly string[] | null;
}): string | null {
	const direct = row.relationship?.trim();
	if (direct) return direct;
	const tags = (row.tags ?? []).map((t) => String(t).trim()).filter(Boolean);
	for (const rel of RELATIONSHIP_TAG_PRIORITY) {
		const hit = tags.find((t) => t.toLowerCase() === rel);
		if (hit) return hit;
	}
	const role = row.role?.trim();
	if (role) return role;
	return tags[0] ?? null;
}

/**
 * Compute the deterministic signal set for one message. The `body` is only read for
 * its first 2,000 characters: a cue buried under a newsletter's footer is not a cue.
 */
export function extractEmailSignals(
	input: EmailEnvelopeInput,
	options: EmailSignalOptions,
): EmailSignals {
	const owner = new Set(options.ownerAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean));
	const senderAddress = normaliseAddress(input.from);
	const senderName = extractDisplayName(input.from);
	const senderDomain = senderAddress.includes("@") ? senderAddress.split("@")[1] : "";
	const senderLocal = senderAddress.includes("@") ? senderAddress.split("@")[0] : senderAddress;
	const labels = new Set(input.labelIds ?? []);

	const toList = addressList(input.to);
	const ccList = addressList(input.cc);
	const isDirectRecipient = toList.some((a) => owner.has(a));
	const isCcOnly = !isDirectRecipient && ccList.some((a) => owner.has(a));
	const isFromOwner = owner.has(senderAddress) || labels.has("SENT");

	const subject = (input.subject ?? "").trim();
	const text = `${input.snippet ?? ""}\n${(input.body ?? "").slice(0, 2000)}`;
	const cues = detectEmailCues(subject, text);

	const hasListUnsubscribe = Boolean(input.listUnsubscribe && input.listUnsubscribe.trim());
	const precedence = (input.precedence ?? "").trim().toLowerCase();
	const hasBulkHeaders =
		hasListUnsubscribe ||
		Boolean(input.listId && input.listId.trim()) ||
		precedence === "bulk" ||
		precedence === "list" ||
		precedence === "junk";
	const autoSubmitted = (input.autoSubmitted ?? "").trim().toLowerCase();
	const isAutoSubmitted = autoSubmitted.length > 0 && autoSubmitted !== "no";
	const isNoReplySender =
		NO_REPLY_PATTERN.test(senderLocal) || BULK_SENDER_DOMAIN_PATTERN.test(senderDomain);
	const isRoleAddress = ROLE_ADDRESS_PATTERN.test(senderLocal);
	const isSystemAlert = SYSTEM_ALERT_SUBJECT_PATTERN.test(subject);

	const knownContact = options.knownContact === true && !isFromOwner;

	let senderKind: SenderKind;
	if (isFromOwner) {
		senderKind = "self";
	} else if (knownContact) {
		senderKind = "known_contact";
	} else if (hasBulkHeaders) {
		senderKind = "bulk";
	} else if (
		isSystemAlert ||
		isNoReplySender ||
		isAutoSubmitted ||
		(isRoleAddress && !(cues.ask && !cues.promo))
	) {
		senderKind = "automated";
	} else {
		senderKind = "human";
	}

	const isSensitive = (cues.money && !cues.receipt) || cues.security || cues.legal;
	const ownerHasWritten = typeof options.ownerHasWritten === "boolean" ? options.ownerHasWritten : null;
	const resolvedOverride = options.senderOverrideDirection
		? { direction: options.senderOverrideDirection, count: MIN_SENDER_OVERRIDES_FOR_RULE }
		: resolveSenderOverrideRule(senderAddress, options.senderOverrides);
	const learnedSenderOverride = resolvedOverride?.direction ?? null;
	const senderOverrideCount = resolvedOverride?.count ?? 0;
	const isColdOutreach =
		senderKind === "human" &&
		!isSensitive &&
		((ownerHasWritten === false && cues.salesPitch) || learnedSenderOverride === "archive");

	const gmailCategory = resolveGmailCategory(input.labelIds);
	// A cold pitch's question ("where does your spend lean?") is not a human's ask.
	const humanAsk =
		(senderKind === "human" || senderKind === "known_contact") && cues.ask && !isColdOutreach;
	const gmailCategoryContradiction =
		gmailCategory !== "primary" && gmailCategory !== "unknown" && (knownContact || humanAsk);

	return {
		senderAddress,
		senderName,
		senderDomain,
		senderKind,
		isFromOwner,
		isDirectRecipient,
		isCcOnly,
		gmailCategory,
		gmailImportant: labels.has("IMPORTANT"),
		starred: labels.has("STARRED"),
		unread: labels.has("UNREAD"),
		hasListUnsubscribe,
		hasBulkHeaders,
		isAutoSubmitted,
		isNoReplySender,
		isRoleAddress,
		isSystemAlert,
		knownContact,
		contactId: knownContact ? (options.contactId ?? null) : null,
		contactMissingEmail: Boolean(knownContact && options.contactMissingEmail),
		relationship: options.relationship ?? null,
		ownerHasWritten,
		cues,
		isColdOutreach,
		// A receipt mentions money without putting any at risk.
		isSensitive,
		gmailCategoryContradiction,
		learnedSenderOverride,
		senderOverrideCount,
	};
}

export function classifySenderOverrideDirection(
	fact: Omit<EmailSenderOverrideFact, "sender">,
): SenderOverrideDirection | null {
	if (fact.status && fact.status !== "modified" && fact.status !== "rejected") return null;
	if (fact.direction === "to_respond" || fact.direction === "archive") return fact.direction;
	if (
		fact.intent_category === "to_respond" ||
		fact.route === "attention" ||
		fact.route === "draft_reply" ||
		fact.gmail_action === "keep_inbox" ||
		(typeof fact.priority === "number" && fact.priority >= 5)
	) {
		return "to_respond";
	}
	if (
		fact.route === "archive" ||
		fact.route === "unsubscribe_candidate" ||
		fact.intent_category === "marketing" ||
		fact.intent_category === "notification" ||
		fact.intent_category === "actioned" ||
		fact.gmail_action === "sweep_archive" ||
		(typeof fact.priority === "number" && fact.priority <= 2)
	) {
		return "archive";
	}
	return null;
}

export function resolveSenderOverrideRule(
	senderAddress: string,
	overrides: readonly EmailSenderOverrideFact[] | undefined,
	minCount = MIN_SENDER_OVERRIDES_FOR_RULE,
): { direction: SenderOverrideDirection; count: number } | null {
	const target = normaliseAddress(senderAddress);
	if (!target || !overrides?.length) return null;
	let toRespond = 0;
	let archive = 0;
	for (const fact of overrides) {
		if (normaliseAddress(fact.sender) !== target) continue;
		const dir = classifySenderOverrideDirection(fact);
		if (dir === "to_respond") toRespond += 1;
		else if (dir === "archive") archive += 1;
	}
	if (toRespond >= minCount && archive === 0) return { direction: "to_respond", count: toRespond };
	if (archive >= minCount && toRespond === 0) return { direction: "archive", count: archive };
	return null;
}

