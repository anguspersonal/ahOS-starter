// Pure rules behind `gmail_reconcile`: label names and ids, the owner-sender test,
// the waiting-on test and the artifact-to-thread reference extractor (#2339, packet 1
// of 5 moving the tool into core per ADR-101 section 1 and ADR-100).
//
// No SDK, no environment variable, no network or database call. The closed status
// names (`CLOSED_STATUS_NAMES`, tasks/createTaskRules.ts) and the owner addresses
// (`DEFAULT_OWNER_ADDRESSES`, google/gmailPriorityTriage.ts) are not copied here:
// core already owns both.

import type { GmailAccount } from "../../ports/gmail.js";
import { DEFAULT_OWNER_ADDRESSES } from "../google/gmailPriorityTriage.js";

/** The four workflow labels the reconcile sweep reads and applies, by name. */
export const GMAIL_RECONCILE_LABEL_NAMES = {
	AHOS: "AhOS",
	AHOS_PROCESSED: "AhOSProcessed",
	PENDING_ACTION: "Pending Action",
	AWAITING_REPLY: "6: awaiting reply",
} as const;

/** The manually created ids of those labels on the personal account. */
export const GMAIL_RECONCILE_PERSONAL_LABEL_IDS = {
	AHOS: "Label_329",
	AHOS_PROCESSED: "Label_330",
	PENDING_ACTION: "Label_331",
	AWAITING_REPLY: "Label_314",
} as const;

export type GmailReconcileDecision =
	| "archive_read"
	| "pending_action"
	| "awaiting_reply"
	| "captured_only";

export interface GmailReconcileLabels {
	ahosId: string;
	ahosProcessedId: string;
	pendingActionId: string;
	awaitingReplyId: string;
}

export interface GmailReconcileThreadResult {
	threadId: string;
	account: GmailAccount;
	decision: GmailReconcileDecision;
	addLabelIds: string[];
	removeLabelIds: string[];
	applied: boolean;
	hasEntityLinks: boolean;
	hasOpenTask: boolean;
	lastMessageFromAngus: boolean;
	error?: string;
}

export interface GmailReconcileSummary {
	scanned: number;
	updated: number;
	archived: number;
	pendingAction: number;
	awaitingReply: number;
	capturedOnly: number;
	unchanged: number;
	errors: number;
	dryRun: boolean;
	details: GmailReconcileThreadResult[];
}

/** True when the From header names one of the owner's addresses (case-insensitive). */
export function isSentByAngus(fromHeader: string | undefined): boolean {
	if (!fromHeader) return false;
	const lower = fromHeader.toLowerCase();
	return DEFAULT_OWNER_ADDRESSES.some((email) => lower.includes(email.toLowerCase()));
}

/** True when a task status name means the task is waiting on someone else. */
export function isTaskWaitingOn(statusName: string | undefined): boolean {
	if (!statusName) return false;
	const lower = statusName.trim().toLowerCase();
	return (
		lower.includes("waiting") ||
		lower.includes("awaiting") ||
		lower === "6: awaiting reply"
	);
}

/**
 * Find the Gmail thread an artifact was captured from, and which account holds it.
 * Precedence: external link, processing metadata, `mail.google.com` source URL,
 * then `Thread: <id>` in the text. Account tags are read first; the default is personal.
 */
export function extractThreadReference(
	artifact: {
		id: string;
		source_channel?: string | null;
		source_url?: string | null;
		processing_metadata?: Record<string, unknown> | null;
		tags?: string[] | null;
		text?: string | null;
	},
	externalLinks: Array<{
		artifact_id: string;
		provider: string;
		kind: string;
		external_id: string;
		external_url?: string | null;
	}> = [],
): { threadId: string; account: GmailAccount } | null {
	let threadId: string | null = null;
	let account: GmailAccount = "personal";

	// Check tags for account preference
	if (artifact.tags?.includes("account:work")) {
		account = "work";
	} else if (artifact.tags?.includes("account:personal")) {
		account = "personal";
	}

	// 1. Check external links
	for (const link of externalLinks) {
		if (link.artifact_id !== artifact.id) continue;
		const prov = link.provider.toLowerCase();
		const kind = link.kind.toLowerCase();
		if (
			(prov.includes("gmail") || prov.includes("google")) &&
			(kind === "thread" || kind === "gmail_thread" || kind === "email")
		) {
			threadId = link.external_id;
			if (prov.includes("work")) account = "work";
			break;
		}
	}

	// 2. Check processing metadata
	if (!threadId && artifact.processing_metadata) {
		const meta = artifact.processing_metadata;
		const gmailMeta = (meta.gmail ?? meta.email) as Record<string, unknown> | undefined;
		if (gmailMeta && typeof gmailMeta.thread_id === "string") {
			threadId = gmailMeta.thread_id;
			if (gmailMeta.account === "work") account = "work";
		} else if (typeof meta.thread_id === "string") {
			threadId = meta.thread_id;
		} else if (typeof meta.gmail_thread_id === "string") {
			threadId = meta.gmail_thread_id;
		}
	}

	// 3. Check source_url
	if (!threadId && artifact.source_url) {
		const url = artifact.source_url;
		if (url.includes("mail.google.com")) {
			if (url.includes("/u/1/")) account = "work";
			// Match patterns like /#inbox/18f12345678 or /#all/18f12345678 or th=18f12345678
			const hashMatch = url.match(/#[^/]+\/([a-fA-F0-9]{12,})/);
			if (hashMatch) {
				threadId = hashMatch[1];
			} else {
				const paramMatch = url.match(/[?&]th=([a-fA-F0-9]{12,})/);
				if (paramMatch) threadId = paramMatch[1];
			}
		}
	}

	// 4. Check text content
	if (!threadId && artifact.text) {
		const textMatch = artifact.text.match(/Thread:\s*([a-fA-F0-9]{12,})/i);
		if (textMatch) {
			threadId = textMatch[1];
		}
	}

	if (!threadId) return null;
	return { threadId, account };
}
