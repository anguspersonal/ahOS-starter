import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { DOMAIN_LEGACY_SCOPE, reconcileDomain } from "../../domain/domains.js";
import type { GmailAccount, GmailPort } from "../../ports/gmail.js";
import type { GmailReconcileStore } from "../../ports/gmailReconcile.js";
import type { NotionPort } from "../../ports/notion.js";
import { defineAction } from "../defineAction.js";
import { findCapturedGmailThreads, resolveWorkflowLabels } from "./reconcileLookups.js";
import type { GmailReconcileLabels, GmailReconcileSummary } from "./reconcileRules.js";
import { reconcileGmailThread } from "./reconcileThread.js";

export const gmailReconcileInput = {
	account: z
		.enum(["personal", "work"])
		.optional()
		.describe(
			"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		),
	domain: optionalDomainInput,
	thread_id: z
		.string()
		.optional()
		.describe("Specific Gmail thread ID to reconcile. If omitted, reconciles all threads with captured artifacts."),
	dry_run: z
		.boolean()
		.optional()
		.default(false)
		.describe("If true, preview decisions and label changes without modifying Gmail labels or archiving threads."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.default(50)
		.describe("Maximum number of threads to inspect and reconcile in this sweep."),
};

export const gmailReconcileInputSchema = z.object(gmailReconcileInput);
export type GmailReconcileInput = z.infer<typeof gmailReconcileInputSchema>;

export interface GmailReconcilePorts {
	gmail: Pick<GmailPort, "listLabels" | "ensureLabel" | "getThread" | "modifyLabels">;
	notion: Pick<NotionPort, "retrievePage">;
	store: Pick<
		GmailReconcileStore,
		| "listCandidateGmailArtifacts"
		| "listCandidateGmailExternalLinks"
		| "hasEntityLinksForArtifacts"
		| "listTaskExternalLinksForArtifacts"
	>;
}

export function formatGmailReconcileMcp(summary: GmailReconcileSummary): string {
	const mode = summary.dryRun ? "[DRY RUN] " : "";
	const lines = [
		`${mode}Gmail workflow reconciliation complete:`,
		`• Scanned: ${summary.scanned} thread(s)`,
		`• Updated: ${summary.updated}`,
		`• Unchanged: ${summary.unchanged}`,
		`• Archived & marked read: ${summary.archived}`,
		`• Pending Action (Angus owes move): ${summary.pendingAction}`,
		`• Awaiting Reply (waiting on someone else): ${summary.awaitingReply}`,
		`• Captured only (not yet processed): ${summary.capturedOnly}`,
		`• Errors: ${summary.errors}`,
	];

	if (summary.details.length > 0) {
		lines.push("", "Details:");
		for (const d of summary.details) {
			const err = d.error ? ` (error: ${d.error})` : "";
			const changes: string[] = [];
			if (d.addLabelIds.length > 0) changes.push(`+labels: ${d.addLabelIds.join(", ")}`);
			if (d.removeLabelIds.length > 0) changes.push(`-labels: ${d.removeLabelIds.join(", ")}`);
			const changeStr = changes.length > 0 ? ` [${changes.join("; ")}]` : " [no label changes]";
			lines.push(`• Thread ${d.threadId} (${d.account}): ${d.decision}${changeStr}${err}`);
		}
	}

	return lines.join("\n");
}

export function createGmailReconcileAction(ports: GmailReconcilePorts) {
	return defineAction<typeof gmailReconcileInputSchema, GmailReconcileSummary>({
		id: "gmail_reconcile",
		domain: "integrations",
		description:
			"Reconcile Gmail labels for threads captured into ahOS (issue #356). " +
			"Applies AhOS on capture, AhOSProcessed on entity sync, and evaluates linked tasks: " +
			"archives and marks read when no open tasks exist; applies 'Pending Action' if the next move is on Angus; " +
			"or applies '6: awaiting reply' if waiting on someone else. Supports dry_run preview.",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		expose: {
			http: false,
			ui_agent: false,
			reason: "owner_decision_pending",
			note: "http and ui_agent off: it archives threads and marks them read; widening is a separate owner decision (ruling of 21 Nov 2026 on #1338)",
		},
		schema: gmailReconcileInputSchema,
		formatMcp: formatGmailReconcileMcp,
		async run(input, ctx) {
			const dryRun = input.dry_run ?? false;
			const limit = input.limit ?? 50;
			const resolvedDomain = reconcileDomain(input.domain, input.account, "account");
			const accountFilter =
				resolvedDomain === undefined ? undefined : (DOMAIN_LEGACY_SCOPE[resolvedDomain] as GmailAccount);

			const summary: GmailReconcileSummary = {
				scanned: 0,
				updated: 0,
				archived: 0,
				pendingAction: 0,
				awaitingReply: 0,
				capturedOnly: 0,
				unchanged: 0,
				errors: 0,
				dryRun,
				details: [],
			};

			const labelsCache = new Map<GmailAccount, GmailReconcileLabels>();
			const getLabels = async (acc: GmailAccount): Promise<GmailReconcileLabels> => {
				let cached = labelsCache.get(acc);
				if (!cached) {
					cached = await resolveWorkflowLabels(ports.gmail, acc);
					labelsCache.set(acc, cached);
				}
				return cached;
			};

			let threadEntries: Array<{ threadId: string; account: GmailAccount; artifactIds: string[] }> = [];
			if (input.thread_id) {
				threadEntries = [{ threadId: input.thread_id, account: accountFilter ?? "personal", artifactIds: [] }];
			} else {
				const threadMap = await findCapturedGmailThreads(ports.store, ctx.userId);
				for (const entry of threadMap.values()) {
					if (accountFilter && entry.account !== accountFilter) continue;
					threadEntries.push(entry);
				}
			}

			if (limit > 0 && threadEntries.length > limit) {
				threadEntries = threadEntries.slice(0, limit);
			}

			for (const entry of threadEntries) {
				summary.scanned++;
				try {
					const labels = await getLabels(entry.account);
					const result = await reconcileGmailThread(ports, {
						threadId: entry.threadId,
						account: entry.account,
						artifactIds: entry.artifactIds,
						labels,
						dryRun,
					});
					summary.details.push(result);

					if (result.error) {
						summary.errors++;
					} else {
						if (result.addLabelIds.length > 0 || result.removeLabelIds.length > 0) {
							summary.updated++;
						} else {
							summary.unchanged++;
						}

						if (result.decision === "archive_read") summary.archived++;
						else if (result.decision === "pending_action") summary.pendingAction++;
						else if (result.decision === "awaiting_reply") summary.awaitingReply++;
						else if (result.decision === "captured_only") summary.capturedOnly++;
					}
				} catch (err) {
					summary.errors++;
					summary.details.push({
						threadId: entry.threadId,
						account: entry.account,
						decision: "captured_only",
						addLabelIds: [],
						removeLabelIds: [],
						applied: false,
						hasEntityLinks: false,
						hasOpenTask: false,
						lastMessageFromAngus: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			return summary;
		},
	});
}
