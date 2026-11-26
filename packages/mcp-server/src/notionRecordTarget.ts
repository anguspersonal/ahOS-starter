import {
	POINTERS,
	RECORD_TARGET_KEYS,
	resolveRecordDataSourceId,
	unwiredError,
	unwiredRecordTargetError,
	type RecordKind,
} from "@ahkms/core";
import { getCredential, type CredentialProvider } from "./credentials.js";
import { DOMAIN_PROVIDER, type Domain } from "./domains.js";
import {
	loadIntegrationConfig,
	notionConfigSchema,
	notionPersonalConfigSchema,
} from "./integrations.js";
import { retrieveDataSourceDatabaseId } from "./notion.js";

// Where a domain's Meetings and Contacts live (#1059), following dailyLogTarget.ts —
// the same shape for the same reason: one resolver, so the writer and anything that
// later verifies the wiring cannot open different databases.
//
// The config keys are NOT symmetric across domains, and that is deliberate rather than
// untidy. #1059 proposed adding `meetings_data_source_id` and `people_data_source_id`
// to the personal workspace; both already exist under the names the personal schema has
// used since #424 (`meeting_notes_data_source_id`, `people_data_source_id`), and the
// work schema's meetings pointer is `meetings_source_data_source_id`, which also serves
// as dos's read source. Renaming live config keys to make a table look neat would break
// every row already written. So the asymmetry is mapped here, once.
//
// `private_meetings_source_data_source_id` is deliberately NOT a destination. It is
// read-but-never-projected (#617, ADR-053 §6), and a capture tool that could write to
// it would be the first thing to put private meeting content somewhere a projection
// might later read.

export {
	POINTERS,
	RECORD_TARGET_KEYS,
	resolveRecordDataSourceId,
	unwiredError,
	unwiredRecordTargetError,
	type RecordKind,
};

export type NotionRecordTarget = {
	dataSourceId: string;
	/** Resolved lazily: the 2022-06-28 write pin takes a database_id, not a data source. */
	databaseId: string;
	token: string;
	provider: CredentialProvider;
};

/**
 * Resolve a domain + record kind to its data source, its database, and that domain's own
 * Notion credential.
 *
 * An unwired domain fails loudly, naming the exact call that wires it. Falling back to
 * the other domain's workspace, or to a default, is the defect ADR-054 §6 names: a
 * routing feature that reads as configured and writes nowhere.
 */
export async function resolveRecordTarget(
	kind: RecordKind,
	domain: Domain,
): Promise<NotionRecordTarget> {
	const provider = DOMAIN_PROVIDER[domain];

	const config =
		domain === "work"
			? await loadIntegrationConfig(provider, notionConfigSchema)
			: await loadIntegrationConfig(provider, notionPersonalConfigSchema);

	const dataSourceId = resolveRecordDataSourceId(kind, domain, config, provider);

	// Per domain, never a shared default: authenticating a personal write with the work
	// token is the #424 defect-1 failure mode, and it surfaces as an opaque Notion 404.
	const token = await getCredential(provider);
	const databaseId = await retrieveDataSourceDatabaseId(dataSourceId, token);

	return { dataSourceId, databaseId, token, provider };
}
