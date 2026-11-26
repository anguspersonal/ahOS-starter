/**
 * Old tool name -> new tool name, the whole of #1061's rename in one table.
 *
 * The grammar the new names follow is `docs/design/mcp-tool-surface-revamp.md`
 * decision 1: a vendor prefix means the tool is a raw wrapper over a rented API
 * (`notion_page_get`, `drive_read_file`), and no vendor prefix means the tool
 * encodes an opinion about Angus's own knowledge (`task_create`, `capture`).
 * Object then verb, singular nouns.
 *
 * Runtime registration of these #1061 aliases on `McpServer` was retired in
 * #1402 after the 2026-10-15 deprecation window closed with zero hits across
 * both the repo and the live capability registry (`docs/design/mcp-tool-layer.md`).
 *
 * This static catalogue stays in place so `scripts/sweep-tool-names.js` and
 * instruction-hygiene tests continue catching any regression to a retired name;
 * future action-level renames use `action.formerIds` (ADR-105).
 */
export const TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
	// --- store ---
	search_knowledge: "knowledge_search",
	get_artifact: "artifact_get",
	get_artifact_and_file: "artifact_get_file",
	extract_text: "artifact_extract_text",
	backfill_embeddings: "artifact_embed_backfill",
	describe_schema: "store_schema",
	create_external_link: "external_link_create",

	// --- graph ---
	entities_create: "entity_create",
	entities_delete: "entity_delete",
	entities_get: "entity_get",
	entities_query: "entity_query",
	entities_update: "entity_update",
	entities_upsert: "entity_upsert",
	entities_unmerge: "entity_unmerge",
	unmerge_entities: "entity_unmerge",
	relate_entities: "entity_relate",
	promote_edge_to_node: "entity_promote_edge",
	people_create: "person_create",
	people_delete: "person_delete",
	people_get: "person_get",
	people_match: "person_match",
	people_query: "person_query",
	people_update: "person_update",
	people_upsert: "person_upsert",
	get_self_entity: "person_self",
	artifact_entity_link_create: "link_create",
	artifact_entity_link_delete: "link_delete",
	artifact_entity_link_get: "link_get",
	artifact_entity_link_query: "link_query",
	artifact_entity_link_upsert: "link_upsert",
	artifact_entity_sync: "artifact_sync_entities",
	export_rdf: "graph_export_rdf",

	// --- ingest ---
	discover: "ingest_discover",
	enrich_next: "ingest_enrich_next",
	github_ingest: "ingest_github",
	slack_ingest: "ingest_slack",
	drive_ingest: "ingest_drive",
	meeting_notes_detect: "ingest_meeting_notes_detect",
	meeting_notes_ingest: "ingest_meeting_notes",

	// --- capability registry ---
	get_capabilities: "capability_get",
	register_capability: "capability_register",
	resolve_capability: "capability_resolve",

	// --- config ---
	get_integrations: "integration_list",
	set_integration_config: "integration_set",
	get_capture_config: "config_capture_get",
	get_user_preferences: "config_preferences_get",
	update_user_preferences: "config_preferences_update",
	create_binding: "binding_create",
	update_binding: "binding_update",
	delete_binding: "binding_delete",
	list_bindings: "binding_list",

	// --- ritual (dos) ---
	get_dos_config: "dos_config_get",
	check_dos_config_drift: "dos_config_drift",
	get_daily_log_queue: "dos_daily_log_queue",
	get_synthesis_coverage: "dos_synthesis_coverage",

	// --- Notion, raw surface ---
	search_notion: "notion_search",
	read_notion_page: "notion_page_get",
	query_notion_database: "notion_database_query",
	get_notion_config: "notion_config_get",
	update_notion_page: "notion_page_update",

	// --- opinionated surface ---
	create_task: "task_create",
	create_communication: "communication_create",
	create_daily_log_entry: "daily_log_create",
	update_state_doc: "state_doc_update",
	create_event: "event_create",
	post_linkedin: "linkedin_post",
});

/**
 * Tools that have been retired rather than aliased: their replacements take a
 * different shape or superseded them outright (#1568). Retained so
 * `scripts/sweep-tool-names.js` keeps sweeping for straggling callers.
 */
export const TOOL_SUPERSEDED: Readonly<Record<string, string>> = Object.freeze({
	artifact_people_sync: "artifact_sync_entities",
	artifact_sync_people: "artifact_sync_entities",
	get_notion_tasks_schema: "notion_database_get",
});

/** The deprecation sentence that fronts an old name's description. */
export function deprecationNotice(replacement: string): string {
	return `Deprecated, use ${replacement}.`;
}

