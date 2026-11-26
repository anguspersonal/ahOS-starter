// Lookups `gmail_reconcile` runs before deciding per-thread label changes (#2340,
// packet 2 of 5 moving the tool into core per ADR-101 section 1 and ADR-100).
//
// Each function accepts a narrow `Pick` of its core port; no SDK or env var.

import type { Domain } from "../../domain/domains.js";
import type { GmailAccount, GmailLabel, GmailPort } from "../../ports/gmail.js";
import type { GmailReconcileStore } from "../../ports/gmailReconcile.js";
import type { NotionApiError, NotionPort } from "../../ports/notion.js";
import { CLOSED_STATUS_NAMES } from "../tasks/createTaskRules.js";
import {
	extractThreadReference,
	GMAIL_RECONCILE_LABEL_NAMES,
	GMAIL_RECONCILE_PERSONAL_LABEL_IDS,
	type GmailReconcileLabels,
	isTaskWaitingOn,
} from "./reconcileRules.js";

function isNotionNotFoundError(err: unknown): boolean {
	return err instanceof Error && err.name === "NotionApiError" && (err as NotionApiError).status === 404;
}

/** Check whether a linked Notion task page is still open and whether it is waiting on someone. */
export async function checkNotionTaskStatus(
	notion: Pick<NotionPort, "retrievePage">,
	pageId: string,
	workspace: string,
): Promise<{ isOpen: boolean; isWaitingOn: boolean }> {
	const domain: Domain = workspace === "notion_personal" ? "angus" : "work";
	try {
		const page = await notion.retrievePage({ workspace: domain, pageId });
		if (page.archived) return { isOpen: false, isWaitingOn: false };

		let statusName: string | undefined;
		for (const prop of Object.values(page.properties ?? {})) {
			const p = prop as { type?: string; status?: { name?: string }; select?: { name?: string } };
			if (p?.type === "status" && p.status?.name) {
				statusName = p.status.name;
				break;
			}
			if (p?.type === "select" && p.select?.name) {
				statusName = p.select.name;
				break;
			}
		}

		if (!statusName) {
			return { isOpen: true, isWaitingOn: false };
		}

		const trimmed = statusName.trim().toLowerCase();
		if (CLOSED_STATUS_NAMES.has(trimmed)) {
			return { isOpen: false, isWaitingOn: false };
		}

		return {
			isOpen: true,
			isWaitingOn: isTaskWaitingOn(statusName),
		};
	} catch (err) {
		if (isNotionNotFoundError(err)) {
			return { isOpen: false, isWaitingOn: false };
		}
		// On unexpected error, default to open to avoid premature archive
		return { isOpen: true, isWaitingOn: false };
	}
}

/** Resolve the four workflow label IDs for a Gmail account, creating any missing labels. */
export async function resolveWorkflowLabels(
	gmail: Pick<GmailPort, "listLabels" | "ensureLabel">,
	account: GmailAccount,
): Promise<GmailReconcileLabels> {
	const domain: Domain = account === "personal" ? "angus" : "work";
	let labels: GmailLabel[] = [];
	try {
		labels = await gmail.listLabels({ domain });
	} catch (err) {
		console.warn(`[GmailWorkflow] listLabels failed for ${account}:`, err);
	}

	const findIdByName = (name: string): string | undefined => {
		const target = name.toLowerCase();
		return labels.find((l) => l.name.toLowerCase() === target)?.id;
	};

	let ahosId = findIdByName(GMAIL_RECONCILE_LABEL_NAMES.AHOS);
	let ahosProcessedId = findIdByName(GMAIL_RECONCILE_LABEL_NAMES.AHOS_PROCESSED);
	let pendingActionId = findIdByName(GMAIL_RECONCILE_LABEL_NAMES.PENDING_ACTION);
	let awaitingReplyId =
		findIdByName(GMAIL_RECONCILE_LABEL_NAMES.AWAITING_REPLY) ||
		findIdByName("waiting on") ||
		findIdByName("awaiting reply");

	if (account === "personal") {
		if (!ahosId && labels.some((l) => l.id === GMAIL_RECONCILE_PERSONAL_LABEL_IDS.AHOS)) {
			ahosId = GMAIL_RECONCILE_PERSONAL_LABEL_IDS.AHOS;
		}
		if (!ahosProcessedId && labels.some((l) => l.id === GMAIL_RECONCILE_PERSONAL_LABEL_IDS.AHOS_PROCESSED)) {
			ahosProcessedId = GMAIL_RECONCILE_PERSONAL_LABEL_IDS.AHOS_PROCESSED;
		}
		if (!pendingActionId && labels.some((l) => l.id === GMAIL_RECONCILE_PERSONAL_LABEL_IDS.PENDING_ACTION)) {
			pendingActionId = GMAIL_RECONCILE_PERSONAL_LABEL_IDS.PENDING_ACTION;
		}
		if (!awaitingReplyId && labels.some((l) => l.id === GMAIL_RECONCILE_PERSONAL_LABEL_IDS.AWAITING_REPLY)) {
			awaitingReplyId = GMAIL_RECONCILE_PERSONAL_LABEL_IDS.AWAITING_REPLY;
		}
	}

	if (!ahosId) {
		ahosId = (await gmail.ensureLabel({ domain, name: GMAIL_RECONCILE_LABEL_NAMES.AHOS })).label.id;
	}
	if (!ahosProcessedId) {
		ahosProcessedId = (await gmail.ensureLabel({ domain, name: GMAIL_RECONCILE_LABEL_NAMES.AHOS_PROCESSED })).label.id;
	}
	if (!pendingActionId) {
		pendingActionId = (await gmail.ensureLabel({ domain, name: GMAIL_RECONCILE_LABEL_NAMES.PENDING_ACTION })).label.id;
	}
	if (!awaitingReplyId) {
		awaitingReplyId = (await gmail.ensureLabel({ domain, name: GMAIL_RECONCILE_LABEL_NAMES.AWAITING_REPLY })).label.id;
	}

	return { ahosId, ahosProcessedId, pendingActionId, awaitingReplyId };
}

/** Discover captured Gmail threads from candidate artifacts and external links, in artifact row order. */
export async function findCapturedGmailThreads(
	store: Pick<GmailReconcileStore, "listCandidateGmailArtifacts" | "listCandidateGmailExternalLinks">,
	userId?: string,
): Promise<Map<string, { threadId: string; account: GmailAccount; artifactIds: string[] }>> {
	const [artifacts, externalLinks] = await Promise.all([
		store.listCandidateGmailArtifacts(userId),
		store.listCandidateGmailExternalLinks(userId),
	]);

	const threadMap = new Map<string, { threadId: string; account: GmailAccount; artifactIds: string[] }>();
	for (const artifact of artifacts) {
		const ref = extractThreadReference(artifact, externalLinks);
		if (!ref) continue;

		const existing = threadMap.get(ref.threadId);
		if (existing) {
			if (!existing.artifactIds.includes(artifact.id)) {
				existing.artifactIds.push(artifact.id);
			}
		} else {
			threadMap.set(ref.threadId, {
				threadId: ref.threadId,
				account: ref.account,
				artifactIds: [artifact.id],
			});
		}
	}

	return threadMap;
}
