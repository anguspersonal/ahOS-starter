// Per-thread decision of `gmail_reconcile` over core ports (#2341, packet 3 of 5
// moving the tool into core per ADR-101 section 1 and ADR-100).
//
// No SDK, no environment variable, no direct database or HTTP client.

import type { Domain } from "../../domain/domains.js";
import { type GmailAccount, type GmailPort, LABEL_INBOX, LABEL_UNREAD } from "../../ports/gmail.js";
import type { GmailReconcileStore } from "../../ports/gmailReconcile.js";
import type { NotionPort } from "../../ports/notion.js";
import { checkNotionTaskStatus } from "./reconcileLookups.js";
import {
	type GmailReconcileDecision,
	type GmailReconcileLabels,
	type GmailReconcileThreadResult,
	isSentByAngus,
} from "./reconcileRules.js";

export interface ReconcileGmailThreadPorts {
	gmail: Pick<GmailPort, "getThread" | "modifyLabels">;
	notion: Pick<NotionPort, "retrievePage">;
	store: Pick<GmailReconcileStore, "hasEntityLinksForArtifacts" | "listTaskExternalLinksForArtifacts">;
}

export interface ReconcileGmailThreadInput {
	threadId: string;
	account: GmailAccount;
	artifactIds: string[];
	labels: GmailReconcileLabels;
	dryRun?: boolean;
}

function errorResult(threadId: string, account: GmailAccount, error: string): GmailReconcileThreadResult {
	return {
		threadId,
		account,
		decision: "captured_only",
		addLabelIds: [],
		removeLabelIds: [],
		applied: false,
		hasEntityLinks: false,
		hasOpenTask: false,
		lastMessageFromAngus: false,
		error,
	};
}

/**
 * Read one Gmail thread, inspect entity and Notion task links for its captured
 * artifacts, choose the reconcile decision, and apply the label delta unless
 * `dryRun` is true or no labels need changing. Never throws.
 */
export async function reconcileGmailThread(
	ports: ReconcileGmailThreadPorts,
	input: ReconcileGmailThreadInput,
): Promise<GmailReconcileThreadResult> {
	const { threadId, account, artifactIds, labels } = input;
	const dryRun = input.dryRun ?? false;
	const domain: Domain = account === "personal" ? "angus" : "work";

	try {
		const messages = await ports.gmail.getThread({ domain, threadId });
		if (!messages || messages.length === 0) {
			return errorResult(threadId, account, "Thread returned no messages");
		}

		const currentLabelIds = new Set<string>(messages.flatMap((m) => m.labelIds ?? []));
		const lastMessage = messages[messages.length - 1];
		const lastMessageFromAngus = isSentByAngus(lastMessage?.from);

		const hasEntityLinks = artifactIds.length > 0 ? await ports.store.hasEntityLinksForArtifacts(artifactIds) : false;
		const taskLinks = artifactIds.length > 0 ? await ports.store.listTaskExternalLinksForArtifacts(artifactIds) : [];

		let hasOpenTask = false;
		let anyTaskWaitingOn = false;
		for (const taskLink of taskLinks) {
			const status = await checkNotionTaskStatus(ports.notion, taskLink.external_id, taskLink.provider);
			if (status.isOpen) {
				hasOpenTask = true;
				if (status.isWaitingOn) anyTaskWaitingOn = true;
			}
		}

		let decision: GmailReconcileDecision;
		const desiredAdd: string[] = [labels.ahosId];
		const desiredRemove: string[] = [];

		if (!hasEntityLinks) {
			decision = "captured_only";
		} else if (!hasOpenTask) {
			decision = "archive_read";
			desiredAdd.push(labels.ahosProcessedId);
			desiredRemove.push(LABEL_INBOX, LABEL_UNREAD, labels.pendingActionId, labels.awaitingReplyId);
		} else {
			desiredAdd.push(labels.ahosProcessedId);
			if (anyTaskWaitingOn || !lastMessageFromAngus) {
				decision = "awaiting_reply";
				desiredAdd.push(labels.awaitingReplyId);
				desiredRemove.push(labels.pendingActionId);
			} else {
				decision = "pending_action";
				desiredAdd.push(labels.pendingActionId);
				desiredRemove.push(labels.awaitingReplyId);
			}
		}

		const addLabelIds = desiredAdd.filter((id) => !currentLabelIds.has(id));
		const removeLabelIds = desiredRemove.filter((id) => currentLabelIds.has(id));

		let applied = false;
		if (!dryRun && (addLabelIds.length > 0 || removeLabelIds.length > 0)) {
			await ports.gmail.modifyLabels({ domain, target: { kind: "thread", id: threadId }, addLabelIds, removeLabelIds });
			applied = true;
		}

		return { threadId, account, decision, addLabelIds, removeLabelIds, applied, hasEntityLinks, hasOpenTask, lastMessageFromAngus };
	} catch (err) {
		return errorResult(threadId, account, err instanceof Error ? err.message : String(err));
	}
}
