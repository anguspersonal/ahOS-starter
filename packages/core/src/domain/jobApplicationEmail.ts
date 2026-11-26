// Deterministic Job Application Email Classifier (ADR-120 Phase 2, #2452).
// Isomorphic and browser-safe: zero Node imports.

import type { ApplicationChannel, JobApplicationStage } from "./jobApplications.js";

export const JOB_APPLICATION_GMAIL_LABEL = "ahOS/job-hunt" as const;
export const JOB_APPLICATION_DECISION_TYPE = "job_application_update" as const;
export const JOB_APPLICATION_EMAIL_EXTRACTOR_MIN_CONFIDENCE = 0.7 as const;

export interface JobEmailInput {
	message_id: string;
	thread_id: string;
	from: string;
	to?: readonly string[];
	cc?: readonly string[];
	subject: string;
	body: string;
	snippet?: string;
	received_at?: string;
	is_sent?: boolean;
	label_ids?: readonly string[];
}

export interface JobEmailClassificationContext {
	owner_addresses?: readonly string[];
	linked_contact_emails?: readonly string[];
	linked_thread_ids?: readonly string[];
}

export interface JobEmailHiringContact {
	name?: string;
	email?: string;
}

export interface JobEmailApplicationUpdate {
	item_key: string;
	organisation: string;
	role_title: string;
	stage: JobApplicationStage;
	channel: ApplicationChannel;
	ats: string | null;
	job_site?: string | null;
	platform_ref?: string | null;
	salary_band?: string | null;
	salary_expectation_submitted?: number | null;
	hiring_contact?: JobEmailHiringContact | null;
	needs_review: boolean;
	conflict_detected: boolean;
	confidence: number;
	rule_id: string;
	stage_note?: string;
}

export interface JobEmailTaskOnly {
	task_title: string;
	priority_level: number;
	source: "email_triage";
	organisation?: string | null;
	person_name?: string | null;
	person_title?: string | null;
	channel?: ApplicationChannel;
	job_site?: string | null;
	rule_id: string;
	confidence: number;
}

export type JobEmailEvidenceSubtype =
	| "dex_screening_briefing"
	| "inbound_human_reply"
	| "owner_sent_reply";

export interface JobEmailEvidenceOnly {
	subtype: JobEmailEvidenceSubtype;
	organisation?: string | null;
	person_name?: string | null;
	updates_last_inbound_at: boolean;
	direction: "inbound" | "outbound";
	rule_id: string;
	confidence: number;
}

export type JobEmailClassificationResult =
	| {
			kind: "ignore";
			reason: string;
			rule_id: string;
	  }
	| {
			kind: "application_updates";
			updates: JobEmailApplicationUpdate[];
	  }
	| {
			kind: "task_only";
			task: JobEmailTaskOnly;
	  }
	| {
			kind: "evidence_only";
			evidence: JobEmailEvidenceOnly;
	  };

/**
 * Extract the canonical lowercase email address from an RFC 5322 mailbox header,
 * anchoring angle-bracketed addr-specs to the end so display names containing
 * `<...>` cannot spoof the sender.
 */
export function extractEmailAddress(raw: string): string {
	const trimmed = raw.trim();
	const bracketMatch = /<([^<>@\s]+@[^<>@\s]+)>\s*$/.exec(trimmed);
	if (bracketMatch) return bracketMatch[1].toLowerCase();
	const plainMatch = /([^\s,;<>]+@[^\s,;<>]+)/.exec(trimmed);
	return plainMatch ? plainMatch[1].toLowerCase() : trimmed.toLowerCase();
}

/**
 * Split an RFC 5322 address list header (`To` / `Cc`) on top-level commas while
 * preserving commas inside quoted display names (e.g. `"Taylor, Sam" <jack@example.com>`)
 * and angle-bracketed addr-specs.
 */
export function parseEmailAddressList(header: string | undefined): string[] {
	if (!header) return [];
	const results: string[] = [];
	let current = "";
	let inQuotes = false;
	let angleDepth = 0;
	let escaped = false;
	for (let i = 0; i < header.length; i += 1) {
		const ch = header[i];
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && inQuotes) {
			current += ch;
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inQuotes = !inQuotes;
			current += ch;
			continue;
		}
		if (!inQuotes) {
			if (ch === "<") {
				angleDepth += 1;
			} else if (ch === ">" && angleDepth > 0) {
				angleDepth -= 1;
			} else if (ch === "," && angleDepth === 0) {
				const trimmed = current.trim();
				if (trimmed) results.push(trimmed);
				current = "";
				continue;
			}
		}
		current += ch;
	}
	const tail = current.trim();
	if (tail) results.push(tail);
	return results;
}

function matchesEmailDomain(email: string, targetDomain: string): boolean {
	const atIdx = email.lastIndexOf("@");
	if (atIdx < 0) return false;
	const host = email.slice(atIdx + 1).toLowerCase();
	const target = targetDomain.toLowerCase();
	return host === target || host.endsWith(`.${target}`);
}

function extractDisplayNameAndEmail(raw: string): { name?: string; email?: string } {
	const trimmed = raw.trim();
	const bracketMatch = /^(.*?)\s*<([^<>@\s]+@[^<>@\s]+)>\s*$/.exec(trimmed);
	if (bracketMatch) {
		const name = bracketMatch[1].replace(/^["']|["']$/g, "").trim();
		return {
			...(name ? { name } : {}),
			email: bracketMatch[2].toLowerCase(),
		};
	}
	const email = extractEmailAddress(trimmed);
	return email.includes("@") ? { email } : { name: trimmed };
}

function cleanText(value: string | undefined): string {
	return (value ?? "").replace(/\r\n/g, "\n").trim();
}

function makeItemKey(index: number, org: string, role: string): string {
	const slug = `${org}-${role}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug ? `${index}:${slug}` : String(index);
}

function parseSalaryExpectation(body: string): number | null {
	const match =
		/(?:salary\s+expectation|expected\s+salary|desired\s+salary)[^£$\d]{0,25}[£$]\s*([\d,]+)(?:\s*(k))?/i.exec(
			body,
		);
	if (!match) return null;
	const base = Number(match[1].replace(/,/g, ""));
	if (!Number.isFinite(base)) return null;
	return match[2] ? base * 1000 : base;
}

function extractRoleFromBody(body: string): string {
	const patterns = [
		/Position:\s*([^\n\r]+)/i,
		/Your application for the\s+(.+?)\s+job\s+was\s+submitted/i,
		/will not be moving forward with your application for\s+(?:the\s+)?(.+?)(?:\s+position|\s+role|\.\s|\.$|\n|$)/i,
		/not to move forward with your application for\s+(?:the\s+)?(.+?)(?:\s+position|\s+role|\.\s|\.$|\n|$)/i,
		/application for the\s+(.+?)\s+position/i,
		/applied\s+(?:for|to)\s+(?:the\s+)?(.+?)\s+(?:position|role|at\s+)/i,
		/(?:for|regarding|about)\s+the\s+(.+?)\s+(?:role|position)\b/i,
		/Role:\s*([^\n\r]+)/i,
	];
	for (const pattern of patterns) {
		const m = pattern.exec(body);
		if (m?.[1]?.trim()) {
			return m[1].trim().replace(/[.!]+$/, "");
		}
	}
	return "";
}

function parseDexThanksForApplying(body: string): Array<{ role_title: string; organisation: string }> {
	const pairs: Array<{ role_title: string; organisation: string }> = [];
	const seen = new Set<string>();
	const lines = body.split("\n");
	for (const rawLine of lines) {
		const line = rawLine.replace(/^[\s•\-*]+/, "").trim();
		if (!line) continue;
		// Matches "Forward Deployed Engineer / Augur" or "Forward Deployed Engineer at Augur"
		const slashMatch = /^([^/\n]{2,100}?)\s+\/\s+([^/\n]{2,80})$/.exec(line);
		if (slashMatch) {
			const role_title = slashMatch[1].trim();
			const organisation = slashMatch[2].trim();
			const key = `${organisation.toLowerCase()}::${role_title.toLowerCase()}`;
			if (!seen.has(key)) {
				seen.add(key);
				pairs.push({ role_title, organisation });
			}
			continue;
		}
		const atMatch = /^(.{2,100}?)\s+@\s+(.{2,80})$/.exec(line);
		if (atMatch) {
			const role_title = atMatch[1].trim();
			const organisation = atMatch[2].trim();
			const key = `${organisation.toLowerCase()}::${role_title.toLowerCase()}`;
			if (!seen.has(key)) {
				seen.add(key);
				pairs.push({ role_title, organisation });
			}
		}
	}
	return pairs;
}

function parseJackAndJillDigest(
	body: string,
): Array<{ role_title: string; organisation: string; salary_band: string | null }> {
	const items: Array<{ role_title: string; organisation: string; salary_band: string | null }> = [];
	const seen = new Set<string>();
	const lines = body.split("\n");
	for (const rawLine of lines) {
		const line = rawLine.replace(/^[\s•\-*\d.)]+/, "").trim();
		if (!line) continue;
		// Pattern: "Role Title at Org (£80k-£100k)" or "Role Title @ Org - £80k-£100k" or "Role Title / Org (£90k)"
		const match =
			/^(.{2,100}?)\s+(?:at|@|\/)\s+([A-Z0-9][^()\n—–-]{1,70}?)(?:\s*(?:[-—–|]|\()\s*([£$€][^)\n]+)\)?)?$/.exec(
				line,
			);
		if (match) {
			const role_title = match[1].trim();
			const organisation = match[2].trim();
			const salary_band = match[3] ? match[3].replace(/\)$/, "").trim() : null;
			const key = `${organisation.toLowerCase()}::${role_title.toLowerCase()}`;
			if (!seen.has(key)) {
				seen.add(key);
				items.push({ role_title, organisation, salary_band });
			}
		}
	}
	return items;
}

function isRejectionBody(bodyLower: string): boolean {
	return (
		bodyLower.includes("decided not to move forward") ||
		bodyLower.includes("will not be moving forward") ||
		bodyLower.includes("not be moving forward") ||
		bodyLower.includes("unfortunately") && bodyLower.includes("not moving forward") ||
		bodyLower.includes("decided not to proceed")
	);
}

const AUTOMATED_SENDER_LOCAL_PARTS = new Set([
	"no-reply",
	"noreply",
	"notifications",
	"notify",
	"update",
	"updates",
	"matchmaking",
	"applications",
	"hello",
	"dex",
	"jack",
]);

const AUTOMATED_SENDER_DOMAINS = [
	"greenhouse-mail.io",
	"hire.lever.co",
	"ashbyhq.com",
	"workablemail.com",
	"ats.rippling.com",
	"firststage.co",
	"meetdex.ai",
	"getdex.com",
	"jackandjill.ai",
	"cord.co",
	"mkt.careers.example.com",
] as const;

function isAutomatedSender(email: string): boolean {
	const atIdx = email.lastIndexOf("@");
	if (atIdx <= 0) return false;
	const local = email.slice(0, atIdx).toLowerCase();
	const domain = email.slice(atIdx + 1).toLowerCase();
	if (!local || !domain) return false;
	if (AUTOMATED_SENDER_LOCAL_PARTS.has(local)) return true;
	if (domain.endsWith(".teamtailor-mail.com")) return true;
	return AUTOMATED_SENDER_DOMAINS.some((d) => matchesEmailDomain(email, d));
}

const TEAMTAILOR_GENERIC_SUBDOMAINS = new Set([
	"mail",
	"careers",
	"jobs",
	"team",
	"hr",
	"recruiting",
	"talent",
	"apply",
	"noreply",
]);

function extractTeamtailorOrg(fromEmail: string, body: string): string {
	// 1. Check Teamtailor sender subdomain first (e.g. example-co.teamtailor-mail.com -> EWOR)
	const atIdx = fromEmail.lastIndexOf("@");
	const domain = atIdx >= 0 ? fromEmail.slice(atIdx + 1).toLowerCase() : "";
	const suffix = ".teamtailor-mail.com";
	let subdomainCandidate: string | null = null;
	if (domain.endsWith(suffix)) {
		const rawSub = domain.slice(0, -suffix.length);
		if (/^ewor(?:gmbh|ltd|limited|inc)?$/i.test(rawSub)) {
			return "EWOR";
		}
		if (rawSub && !TEAMTAILOR_GENERIC_SUBDOMAINS.has(rawSub)) {
			const stripped = rawSub
				.replace(/(?:gmbh|ltd|limited|inc|corp|llc|ag|bv|sas|ab|oy)$/i, "")
				.replace(/[-_]+/g, " ")
				.trim();
			if (stripped) {
				subdomainCandidate = stripped
					.split(/\s+/)
					.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
					.join(" ");
			}
		}
	}

	// 2. Tightened body capture stopping before prepositions ("for", "on", etc.) or punctuation
	const orgToken =
		"([A-Z][A-Za-z0-9&.-]*(?:\\s+(?!(?:for|on|as|in|about|regarding|with|via|to|at|through)\\b)[A-Za-z0-9&.-]+){0,4})";
	const directToAt = new RegExp(`\\bapplying\\s+(?:to|at)\\s+${orgToken}`).exec(body);
	const forRoleAt = new RegExp(
		`\\bapplying\\s+for\\s+(?:the\\s+)?[^.!?\\n]{1,80}?\\s+(?:at|with)\\s+${orgToken}`,
	).exec(body);
	const bodyOrg = (directToAt?.[1] ?? forRoleAt?.[1] ?? "")
		.replace(/[.!,;:]+$/, "")
		.trim();

	if (bodyOrg) return bodyOrg;
	if (subdomainCandidate) return subdomainCandidate;
	if (/\bewor\b/i.test(body)) return "EWOR";
	return "Unknown";
}

/**
 * Classify a single Gmail message deterministically (System 1, ADR-120 Phase 2).
 */
export function classifyJobEmail(
	email: JobEmailInput,
	ctx?: JobEmailClassificationContext,
): JobEmailClassificationResult {
	const fromEmail = extractEmailAddress(email.from);
	const subject = cleanText(email.subject);
	const body = cleanText(email.body || email.snippet);
	const bodyLower = body.toLowerCase();
	const subjectLower = subject.toLowerCase();

	const ownerSet = new Set((ctx?.owner_addresses ?? []).map((a) => extractEmailAddress(a)));
	const linkedContactSet = new Set(
		(ctx?.linked_contact_emails ?? []).map((a) => extractEmailAddress(a)),
	);
	const linkedThreadSet = new Set(ctx?.linked_thread_ids ?? []);

	// -----------------------------------------------------------------------
	// 0. Explicit negatives (must never become job applications)
	// -----------------------------------------------------------------------
	if (fromEmail === "noreply@github.com" || subjectLower.includes("oauth application")) {
		return { kind: "ignore", reason: "GitHub OAuth / non-job notification", rule_id: "neg_github_oauth" };
	}
	if (fromEmail === "permits@council.example.com" || subjectLower.includes("trader application")) {
		return { kind: "ignore", reason: "Council permit / non-job application", rule_id: "neg_council_permit" };
	}
	if (fromEmail === "applications@careers.example.com" && subjectLower.includes("jumpstart application")) {
		return { kind: "ignore", reason: "Jumpstart platform onboarding", rule_id: "neg_jumpstart_onboarding" };
	}
	if (matchesEmailDomain(fromEmail, "careers.example.com") && subjectLower.includes("senior operator stream")) {
		return { kind: "ignore", reason: "Jumpstart stream welcome", rule_id: "neg_jumpstart_stream_welcome" };
	}
	if (
		fromEmail === "hello@mkt.careers.example.com" &&
		(subjectLower.includes("how to nail") || subjectLower.includes("first stage interview"))
	) {
		return { kind: "ignore", reason: "Jumpstart marketing newsletter", rule_id: "neg_jumpstart_marketing" };
	}
	if (fromEmail === "digest@jobs.example.com" && subjectLower.startsWith("new matches picked for you")) {
		return { kind: "ignore", reason: "Dex jobs new matches digest ignored in v1", rule_id: "neg_dex_new_matches" };
	}

	// -----------------------------------------------------------------------
	// 1. Dex CRM (notify@updates.jobs.example.com): Screening briefing = evidence; else ignore
	// -----------------------------------------------------------------------
	if (fromEmail === "notify@updates.jobs.example.com") {
		const briefingMatch = /^Briefing:\s+(.+?)\s+Screening\s+\((.+?)\)$/i.exec(subject);
		if (briefingMatch) {
			return {
				kind: "evidence_only",
				evidence: {
					subtype: "dex_screening_briefing",
					organisation: briefingMatch[1].trim(),
					person_name: briefingMatch[2].trim(),
					updates_last_inbound_at: false,
					direction: "inbound",
					rule_id: "dex_crm_screening_briefing",
					confidence: 0.95,
				},
			};
		}
		return { kind: "ignore", reason: "Non-screening Dex CRM digest", rule_id: "neg_dex_crm_digest" };
	}

	// -----------------------------------------------------------------------
	// 2. Owner sent mail (in:sent) -> evidence_only (never updates last_inbound_at)
	// -----------------------------------------------------------------------
	const isOwnerSender = email.is_sent === true || ownerSet.has(fromEmail);
	if (isOwnerSender) {
		const recipientEmails = [...(email.to ?? []), ...(email.cc ?? [])].map(extractEmailAddress);
		const touchesLinkedContact = recipientEmails.some((r) => linkedContactSet.has(r));
		const touchesLinkedThread = linkedThreadSet.has(email.thread_id);
		if (touchesLinkedContact || touchesLinkedThread) {
			return {
				kind: "evidence_only",
				evidence: {
					subtype: "owner_sent_reply",
					updates_last_inbound_at: false,
					direction: "outbound",
					rule_id: "owner_sent_reply",
					confidence: 0.95,
				},
			};
		}
		return { kind: "ignore", reason: "Owner sent mail not linked to a tracked application", rule_id: "neg_unlinked_sent" };
	}

	// -----------------------------------------------------------------------
	// 3. Lever (no-reply@example.com)
	// -----------------------------------------------------------------------
	if (fromEmail === "no-reply@example.com") {
		const appliedMatch = /^Thank you for applying for\s+(.+?)\s+at\s+(.+)$/i.exec(subject);
		if (appliedMatch) {
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						role_title: appliedMatch[1].trim(),
						organisation: appliedMatch[2].trim(),
						stage: "applied",
						channel: "company_site",
						ats: "lever",
						needs_review: false,
						conflict_detected: false,
						confidence: 0.96,
						rule_id: "lever_applied",
					},
				],
			};
		}
		const updateMatch = /^Update on Your Application at\s+(.+)$/i.exec(subject);
		if (updateMatch && isRejectionBody(bodyLower)) {
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						organisation: updateMatch[1].trim(),
						role_title: extractRoleFromBody(body),
						stage: "rejected",
						channel: "company_site",
						ats: "lever",
						needs_review: false,
						conflict_detected: false,
						confidence: 0.94,
						rule_id: "lever_rejected",
					},
				],
			};
		}
	}

	// -----------------------------------------------------------------------
	// 4. Greenhouse (no-reply@example.com / greenhouse-mail.io)
	// -----------------------------------------------------------------------
	if (matchesEmailDomain(fromEmail, "greenhouse-mail.io")) {
		const appliedMatch = /^Thank you for applying to\s+(.+?)[.!]*$/i.exec(subject);
		if (appliedMatch) {
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						organisation: appliedMatch[1].trim(),
						role_title: extractRoleFromBody(body),
						stage: "applied",
						channel: "company_site",
						ats: "greenhouse",
						needs_review: false,
						conflict_detected: false,
						confidence: 0.93,
						rule_id: "greenhouse_applied",
					},
				],
			};
		}
	}

	// -----------------------------------------------------------------------
	// 5. Rippling (no-reply@example.com)
	// -----------------------------------------------------------------------
	if (fromEmail === "no-reply@example.com") {
		const rejectedMatch = /^Thank you for your application to\s+(.+?)[.!]*$/i.exec(subject);
		if (rejectedMatch && isRejectionBody(bodyLower)) {
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						organisation: rejectedMatch[1].trim(),
						role_title: extractRoleFromBody(body),
						stage: "rejected",
						channel: "company_site",
						ats: "rippling",
						needs_review: false,
						conflict_detected: false,
						confidence: 0.94,
						rule_id: "rippling_rejected",
					},
				],
			};
		}
		const appliedMatch = /^Thank you for applying to\s+(.+?)[.!]*$/i.exec(subject);
		if (appliedMatch) {
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						organisation: appliedMatch[1].trim(),
						role_title: extractRoleFromBody(body),
						stage: "applied",
						channel: "company_site",
						ats: "rippling",
						needs_review: false,
						conflict_detected: false,
						confidence: 0.95,
						rule_id: "rippling_applied",
					},
				],
			};
		}
	}

	// -----------------------------------------------------------------------
	// 6. Ashby (no-reply@example.com)
	// -----------------------------------------------------------------------
	if (fromEmail === "no-reply@example.com") {
		const appliedMatch = /^Thanks for applying to\s+(.+?)[.!]*$/i.exec(subject);
		if (appliedMatch) {
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						organisation: appliedMatch[1].trim(),
						role_title: extractRoleFromBody(body),
						stage: "applied",
						channel: "company_site",
						ats: "ashby",
						needs_review: false,
						conflict_detected: false,
						confidence: 0.94,
						rule_id: "ashby_applied",
					},
				],
			};
		}
	}

	// -----------------------------------------------------------------------
	// 7. Workable (noreply@example.com)
	// -----------------------------------------------------------------------
	if (fromEmail === "noreply@example.com") {
		const appliedMatch = /^Thanks for applying to\s+(.+?)[.!]*$/i.exec(subject);
		if (appliedMatch) {
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						organisation: appliedMatch[1].trim(),
						role_title: extractRoleFromBody(body),
						stage: "applied",
						channel: "company_site",
						ats: "workable",
						salary_expectation_submitted: parseSalaryExpectation(body),
						needs_review: false,
						conflict_detected: false,
						confidence: 0.95,
						rule_id: "workable_applied",
					},
				],
			};
		}
	}

	// -----------------------------------------------------------------------
	// 8. UCL portal (noreply@university.example.com)
	// -----------------------------------------------------------------------
	if (fromEmail === "noreply@university.example.com") {
		const uclMatch = /^(.+?)\s+-\s+(.+?)\s+\(([A-Z0-9-]+)\)\s+-\s+Application Received$/i.exec(
			subject,
		);
		if (uclMatch) {
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						organisation: uclMatch[1].trim(),
						role_title: uclMatch[2].trim(),
						platform_ref: uclMatch[3].trim(),
						stage: "applied",
						channel: "company_site",
						ats: "ucl_portal",
						needs_review: false,
						conflict_detected: false,
						confidence: 0.97,
						rule_id: "ucl_applied",
					},
				],
			};
		}
	}

	// -----------------------------------------------------------------------
	// 9. Teamtailor (*@*.teamtailor-mail.com) + EWOR reminder
	// -----------------------------------------------------------------------
	if (fromEmail.endsWith(".teamtailor-mail.com")) {
		if (/^We have received your application!?$/i.test(subject)) {
			const orgFromEmail = extractTeamtailorOrg(fromEmail, body);
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						organisation: orgFromEmail,
						role_title: extractRoleFromBody(body),
						stage: "applied",
						channel: "company_site",
						ats: "teamtailor",
						needs_review: false,
						conflict_detected: false,
						confidence: 0.9,
						rule_id: "teamtailor_applied",
					},
				],
			};
		}
	}
	if (fromEmail === "applications@fellowship.example.com") {
		const eworMatch = /^Complete your application for\s+(?:the\s+)?(.+?)[.!]*$/i.exec(subject);
		if (eworMatch) {
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						organisation: "EWOR",
						role_title: eworMatch[1].trim(),
						stage: "drafting",
						channel: "company_site",
						ats: "teamtailor",
						needs_review: true,
						conflict_detected: true,
						confidence: 0.65,
						rule_id: "ewor_complete_application_conflict",
						stage_note: "Incomplete application reminder conflicts with receipt; parked for review.",
					},
				],
			};
		}
	}

	// -----------------------------------------------------------------------
	// 10. Dex jobs (digest@jobs.example.com) - Thanks for applying (multi-role pairs)
	// -----------------------------------------------------------------------
	if (fromEmail === "digest@jobs.example.com" && /^Thanks for applying/i.test(subject)) {
		const pairs = parseDexThanksForApplying(body);
		if (pairs.length > 0) {
			return {
				kind: "application_updates",
				updates: pairs.map((pair, idx) => ({
					item_key: makeItemKey(idx, pair.organisation, pair.role_title),
					organisation: pair.organisation,
					role_title: pair.role_title,
					stage: "applied",
					channel: "dex_jobs",
					ats: null,
					job_site: "Dex jobs",
					needs_review: false,
					conflict_detected: false,
					confidence: 0.93,
					rule_id: "dex_thanks_for_applying",
				})),
			};
		}
	}

	// -----------------------------------------------------------------------
	// 11. Jumpstart (hello@mkt.careers.example.com & matchmaking@careers.example.com)
	// -----------------------------------------------------------------------
	if (fromEmail === "hello@mkt.careers.example.com") {
		const rejMatch = /^(.+?)\s+has decided not to interview you$/i.exec(subject);
		if (rejMatch) {
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						organisation: rejMatch[1].trim(),
						role_title: extractRoleFromBody(body),
						stage: "rejected",
						channel: "jumpstart",
						ats: null,
						job_site: "Jumpstart",
						needs_review: false,
						conflict_detected: false,
						confidence: 0.94,
						rule_id: "jumpstart_rejected",
					},
				],
			};
		}

		const inviteMatch = /^Interview Request:\s+(.+?)\s+is keen to have a chat!?$/i.exec(subject);
		if (inviteMatch) {
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						organisation: inviteMatch[1].trim(),
						role_title: extractRoleFromBody(body),
						stage: "screening",
						channel: "jumpstart",
						ats: null,
						job_site: "Jumpstart",
						needs_review: false,
						conflict_detected: false,
						confidence: 0.93,
						rule_id: "jumpstart_interview_request",
					},
				],
			};
		}

		const introMatch =
			/^.+?\s*@\s*Jumpstart\s*<>\s*(.+?)\s*@\s*(.+?)\s*-\s*interview introduction!?$/i.exec(
				subject,
			);
		if (introMatch) {
			const personFirst = introMatch[1].trim();
			const org = introMatch[2].trim();
			const allRecipients = [...(email.to ?? []), ...(email.cc ?? [])]
				.map(extractDisplayNameAndEmail)
				.filter(
					(r) =>
						r.email &&
						!ownerSet.has(r.email) &&
						!matchesEmailDomain(r.email, "careers.example.com"),
				);
			const contact = allRecipients[0]
				? {
						name: allRecipients[0].name ?? personFirst,
						email: allRecipients[0].email,
					}
				: { name: personFirst };
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						organisation: org,
						role_title: extractRoleFromBody(body),
						stage: "screening",
						channel: "jumpstart",
						ats: null,
						job_site: "Jumpstart",
						hiring_contact: contact,
						needs_review: false,
						conflict_detected: false,
						confidence: 0.95,
						rule_id: "jumpstart_interview_intro",
					},
				],
			};
		}

		const liveMatch = /^(.+?)\s+@\s+(.+?)\s+just went live and it's a strong match for you$/i.exec(
			subject,
		);
		if (liveMatch) {
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						role_title: liveMatch[1].trim(),
						organisation: liveMatch[2].trim(),
						stage: "matched",
						channel: "jumpstart",
						ats: null,
						job_site: "Jumpstart",
						needs_review: false,
						conflict_detected: false,
						confidence: 0.95,
						rule_id: "jumpstart_live_match",
					},
				],
			};
		}
	}

	if (
		fromEmail === "matchmaking@careers.example.com" &&
		/please respond to your match request/i.test(subject)
	) {
		return {
			kind: "task_only",
			task: {
				task_title: "Respond to Jumpstart match request",
				priority_level: 6,
				source: "email_triage",
				channel: "jumpstart",
				job_site: "Jumpstart",
				rule_id: "jumpstart_match_response_task",
				confidence: 0.96,
			},
		};
	}

	// -----------------------------------------------------------------------
	// 12. Cord (update@hiring.example.com) - task only
	// -----------------------------------------------------------------------
	if (fromEmail === "update@hiring.example.com") {
		const cordMatch = /^New message from\s+([^,]+?),\s+(.+?)\s+at\s+(.+)$/i.exec(subject);
		if (cordMatch) {
			const person = cordMatch[1].trim();
			const title = cordMatch[2].trim();
			const org = cordMatch[3].trim();
			return {
				kind: "task_only",
				task: {
					task_title: `Read Cord message from ${person} (${org})`,
					priority_level: 5,
					source: "email_triage",
					organisation: org,
					person_name: person,
					person_title: title,
					channel: "cord",
					job_site: "Cord",
					rule_id: "cord_new_message_task",
					confidence: 0.95,
				},
			};
		}
	}

	// -----------------------------------------------------------------------
	// 13. Firststage (notifications@ats.example.com)
	// -----------------------------------------------------------------------
	if (fromEmail === "notifications@ats.example.com") {
		const finishMatch = /^Finish your application for\s+(.+?)\s+at\s+(.+)$/i.exec(subject);
		if (finishMatch) {
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						role_title: finishMatch[1].trim(),
						organisation: finishMatch[2].trim(),
						stage: "drafting",
						channel: "company_site",
						ats: "firststage",
						needs_review: false,
						conflict_detected: false,
						confidence: 0.95,
						rule_id: "firststage_drafting",
					},
				],
			};
		}
		const pausedMatch = /^Application paused for\s+(.+?)\s+at\s+(.+)$/i.exec(subject);
		if (pausedMatch) {
			return {
				kind: "application_updates",
				updates: [
					{
						item_key: "primary",
						role_title: pausedMatch[1].trim(),
						organisation: pausedMatch[2].trim(),
						stage: "withdrawn",
						channel: "company_site",
						ats: "firststage",
						needs_review: true,
						conflict_detected: false,
						confidence: 0.7,
						rule_id: "firststage_paused_propose_withdrawn",
						stage_note: "Application paused on Firststage; propose withdrawn for owner review.",
					},
				],
			};
		}
	}

	// -----------------------------------------------------------------------
	// 14. Jack & Jill (recruiter@talent.example.com) - multi-role digest
	// -----------------------------------------------------------------------
	if (fromEmail === "recruiter@talent.example.com") {
		const items = parseJackAndJillDigest(body);
		if (items.length > 0) {
			return {
				kind: "application_updates",
				updates: items.map((item, idx) => ({
					item_key: makeItemKey(idx, item.organisation, item.role_title),
					organisation: item.organisation,
					role_title: item.role_title,
					salary_band: item.salary_band,
					stage: "matched",
					channel: "jack_and_jill",
					ats: null,
					job_site: "Jack & Jill",
					needs_review: false,
					conflict_detected: false,
					confidence: 0.9,
					rule_id: "jack_and_jill_digest",
				})),
			};
		}
	}

	// -----------------------------------------------------------------------
	// 15. Company's own domain rejection ("Update on your {org} application")
	// -----------------------------------------------------------------------
	const companyRejectionMatch = /^Update on your\s+(.+?)\s+application$/i.exec(subject);
	if (companyRejectionMatch && isRejectionBody(bodyLower)) {
		return {
			kind: "application_updates",
			updates: [
				{
					item_key: "primary",
					organisation: companyRejectionMatch[1].trim(),
					role_title: extractRoleFromBody(body),
					stage: "rejected",
					channel: "company_site",
					ats: null,
					needs_review: false,
					conflict_detected: false,
					confidence: 0.92,
					rule_id: "company_domain_rejected",
				},
			],
		};
	}

	// -----------------------------------------------------------------------
	// 16. Inbound human reply from linked contact / on linked thread -> evidence_only
	// -----------------------------------------------------------------------
	if (
		!isAutomatedSender(fromEmail) &&
		(linkedContactSet.has(fromEmail) || linkedThreadSet.has(email.thread_id))
	) {
		return {
			kind: "evidence_only",
			evidence: {
				subtype: "inbound_human_reply",
				updates_last_inbound_at: true,
				direction: "inbound",
				rule_id: "inbound_human_reply",
				confidence: 0.9,
			},
		};
	}

	return { kind: "ignore", reason: "No matching job application rule", rule_id: "unmatched" };
}

/**
 * Reconcile thread-level conflicts across a batch of classified emails (e.g.
 * Teamtailor "We have received your application!" followed by EWOR
 * "Complete your application for the EWOR Fellowship" resolves to drafting + review).
 */
export function resolveThreadConflicts(
	entries: ReadonlyArray<{ email: JobEmailInput; result: JobEmailClassificationResult }>,
): Array<{ email: JobEmailInput; result: JobEmailClassificationResult }> {
	const eworConflictOrgs = new Set<string>();
	for (const entry of entries) {
		if (entry.result.kind === "application_updates") {
			for (const u of entry.result.updates) {
				if (u.conflict_detected) {
					eworConflictOrgs.add(u.organisation.toLowerCase());
				}
			}
		}
	}

	if (eworConflictOrgs.size === 0) return [...entries];

	return entries.map((entry) => {
		if (entry.result.kind !== "application_updates") return entry;
		const updated = entry.result.updates.map((u) => {
			if (
				!u.conflict_detected &&
				u.rule_id === "teamtailor_applied" &&
				eworConflictOrgs.has(u.organisation.toLowerCase())
			) {
				return {
					...u,
					stage: "drafting" as const,
					needs_review: true,
					conflict_detected: true,
					confidence: 0.65,
					stage_note:
						"Teamtailor application receipt conflicts with incomplete application reminder; resolved to drafting for review.",
				};
			}
			return u;
		});
		return {
			email: entry.email,
			result: { kind: "application_updates", updates: updated },
		};
	});
}
