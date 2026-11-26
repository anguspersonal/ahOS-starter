import { DOMAIN_PROVIDER, type Domain } from "../../domain/domains.js";

// Per-domain integration config key table and unwired error for Meetings, Contacts, and Investor CRM (#1059, #1576).
// `private_meetings_source_data_source_id` is read-but-never-projected (#617, ADR-053 §6) and never a write target.

export const RECORD_KINDS = ["meetings", "contacts", "investor_crm"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export type RecordTargetPointer = { key: string; what: string };

/** The config key each (kind, domain) pair reads, and how to describe it in an error. */
export const POINTERS: Record<RecordKind, Record<Domain, RecordTargetPointer>> = {
	meetings: {
		work: { key: "meetings_source_data_source_id", what: "the Work Meetings database" },
		angus: { key: "meeting_notes_data_source_id", what: "the personal Meeting Notes database" },
	},
	contacts: {
		work: { key: "contacts_data_source_id", what: "the Work Contacts database" },
		angus: { key: "people_data_source_id", what: "the personal People database" },
	},
	investor_crm: {
		work: { key: "investor_crm_data_source_id", what: "the Work Investor CRM database" },
		angus: { key: "investor_crm_data_source_id", what: "the personal Investor CRM database" },
	},
};

export const RECORD_TARGET_KEYS = POINTERS;

export function unwiredRecordTargetError(
	kind: RecordKind,
	domain: Domain,
	provider: string = DOMAIN_PROVIDER[domain],
): Error {
	const pointer = POINTERS[kind][domain];
	return new Error(
		[
			`No ${pointer.key} for domain '${domain}' — ${pointer.what} is unwired, so nothing was written.`,
			"Wire it in two steps:",
			`1. integration_set({ provider: '${provider}', config: { ${pointer.key}: '<the data source id>' } })`,
			"2. In Notion, open that database → ⋯ → Connections → ahKMS, and do the same for its parent page. Notion exposes no page-sharing API, so without this step every configured pointer 404s (#355, #655).",
			"notion_config_get prints what is currently wired; notion_database_get confirms ahKMS can actually see it.",
		].join("\n"),
	);
}

export const unwiredError = unwiredRecordTargetError;

export function resolveRecordDataSourceId(
	kind: RecordKind,
	domain: Domain,
	config: Record<string, unknown> | null | undefined,
	provider: string = DOMAIN_PROVIDER[domain],
): string {
	const dataSourceId = config?.[POINTERS[kind][domain].key];
	if (typeof dataSourceId !== "string" || !dataSourceId) {
		throw unwiredRecordTargetError(kind, domain, provider);
	}
	return dataSourceId;
}
