/**
 * @ahkms/core/domain - emailGoldenExamples.ts
 *
 * Sanitized placeholder for the public snapshot. Real owner email threads
 * are intentionally omitted; populate with your own fixtures when running
 * local email triage evaluations.
 *
 * Isomorphic: zero Node imports.
 */
import type { EmailContextProbeKind, EmailHop2ProbeEvidence } from "./emailFastPath.js";
import type { EmailEnvelopeInput, EmailSignalOptions } from "./emailSignals.js";

export interface EmailGoldenExample {
	id: string;
	account: "personal" | "work";
	thread_id: string;
	envelope: EmailEnvelopeInput;
	facts: Omit<EmailSignalOptions, "ownerAddresses">;
	probe_evidence?: EmailHop2ProbeEvidence;
	owner_ruling: string;
	expect: {
		worth_analysis?: boolean;
		needs_reply?: boolean;
		has_owner_commitment?: boolean;
		has_fact_to_persist?: boolean;
		is_new_contact?: boolean;
		needs_contact_email_backfill?: boolean;
		probes_include?: readonly EmailContextProbeKind[];
		commitment_already_satisfied?: boolean;
		adds_info_to_existing_item?: boolean;
		needs_owner_escalation?: boolean;
		route?: string;
	};
}

export const EMAIL_GOLDEN_EXAMPLES: readonly EmailGoldenExample[] = Object.freeze([]);
