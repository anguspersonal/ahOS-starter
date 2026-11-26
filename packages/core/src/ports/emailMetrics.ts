/**
 * @ahkms/core/ports - emailMetrics.ts
 *
 * Read and write ports for the email pipeline's dashboard series (ADR-118 §9, ADR-110 §1).
 * Pure types only.
 */

import type { EmailDecisionFact, EmailMailboxSnapshot } from "../domain/emailMetricsSeries.js";
import type { EmailOwnerCorrectionExample } from "./emailReasoner.js";

export interface GmailTriageMetricsPort {
	/** Pipeline decision rows created at or after `sinceIso`, narrowed to the fields the series reads. */
	listDecisionFacts(sinceIso: string, userId?: string): Promise<EmailDecisionFact[]>;
	/** Daily mailbox snapshots observed at or after `sinceIso`. */
	listMailboxSnapshots(sinceIso: string, userId?: string): Promise<EmailMailboxSnapshot[]>;
	/** Recent owner-corrected decisions (`status in ('modified', 'rejected')`) as worked few-shot examples. */
	listOwnerCorrections?(limit?: number, userId?: string): Promise<EmailOwnerCorrectionExample[]>;
}
