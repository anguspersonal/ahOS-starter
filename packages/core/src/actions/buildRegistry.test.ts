import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildRegistry, AdapterUnavailableError } from "./buildRegistry.js";
import { executeAction } from "./adapters/direct.js";
import { defineAction } from "./defineAction.js";
import type { NotionPort } from "../ports/notion.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(__dirname, "../../..");

function findSourceFiles(dir: string): string[] {
	const files: string[] = [];
	if (!fs.existsSync(dir)) return files;
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (["node_modules", "dist", "build", ".turbo", "__tests__"].includes(entry.name)) continue;
			files.push(...findSourceFiles(fullPath));
		} else if (entry.isFile()) {
			if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) continue;
			if (entry.name.endsWith(".ts") || entry.name.endsWith(".js") || entry.name.endsWith(".tsx")) {
				files.push(fullPath);
			}
		}
	}
	return files;
}

describe("buildRegistry (ADR-101 §3, ADR-105 R2)", () => {
	it("case 1: buildRegistry({}).list().map(a => a.id).sort() matches exactly all core action IDs", () => {
		const registry = buildRegistry({});
		const ids = registry.list().map((a) => a.id).sort();

		expect(ids).toEqual([
			"ahos_doctor",
			"approval_approve",
			"approval_list",
			"approval_reject",
			"appsscript_create_deployment",
			"appsscript_create_project",
			"appsscript_create_version",
			"appsscript_get_content",
			"appsscript_get_project",
			"appsscript_list_deployments",
			"appsscript_list_projects",
			"appsscript_list_versions",
			"appsscript_run_function",
			"appsscript_update_content",
			"artifact_delete",
			"artifact_embed_backfill",
			"artifact_extract_text",
			"artifact_get",
			"artifact_get_file",
			"artifact_sync_entities",
			"artifact_update",
			"bigquery_query",
			"binding_create",
			"binding_delete",
			"binding_list",
			"binding_update",
			"brevo_call_tool",
			"brevo_list_tools",
			"calendar_delete_event",
			"calendar_get_event",
			"calendar_list_events",
			"calendar_respond_to_event",
			"calendar_update_event",
			"capability_get",
			"capability_register",
			"capability_resolve",
			"capture",
			"clean_state_check",
			"client_action_record",
			"communication_create",
			"config_capture_get",
			"config_preferences_get",
			"config_preferences_update",
			"contact_create",
			"daily_log_create",
			"decision_review",
			"dex_call_tool",
			"dex_list_tools",
			"docs_append",
			"docs_batch_update",
			"docs_comments",
			"docs_find_text",
			"docs_get",
			"docs_replace_text",
			"document_duplicates",
			"document_resolve",
			"dos_config_drift",
			"dos_config_get",
			"dos_daily_log_queue",
			"dos_evidence_aggregate",
			"dos_synthesis_coverage",
			"drive_about",
			"drive_changes_list",
			"drive_comment_create",
			"drive_comment_delete",
			"drive_comment_get",
			"drive_comment_list",
			"drive_comment_reply",
			"drive_comment_update",
			"drive_copy",
			"drive_create_folder",
			"drive_delete",
			"drive_discover_sweep",
			"drive_export",
			"drive_folder_collision_audit",
			"drive_get_metadata",
			"drive_hygiene_heal",
			"drive_import_file",
			"drive_list",
			"drive_list_permissions",
			"drive_move",
			"drive_read_file",
			"drive_rename",
			"drive_revision_delete",
			"drive_revision_get",
			"drive_revision_keep",
			"drive_revision_list",
			"drive_search",
			"drive_share",
			"drive_trash",
			"drive_unshare",
			"drive_update_content",
			"drive_upload_file",
			"drive_watch_renew",
			"entity_bulk_delete",
			"entity_create",
			"entity_crud",
			"entity_delete",
			"entity_derive",
			"entity_derive_next",
			"entity_derive_sweep",
			"entity_get",
			"entity_neighbourhood",
			"entity_path",
			"entity_promote_edge",
			"entity_query",
			"entity_relate",
			"entity_synthesize",
			"entity_unmerge",
			"entity_update",
			"entity_upsert",
			"event_create",
			"external_link_create",
			"gdrive_copy_to_onedrive",
			"github_branch_delete",
			"github_branch_get",
			"github_comment_create",
			"github_dir_list",
			"github_file_get",
			"github_issue_comment_list",
			"github_issue_create",
			"github_issue_get",
			"github_issue_search",
			"github_issue_timeline",
			"github_job_log_get",
			"github_label_add",
			"github_label_remove",
			"github_pr_close",
			"github_pr_commit_list",
			"github_pr_create",
			"github_pr_diff",
			"github_pr_file_list",
			"github_pr_get",
			"github_pr_list",
			"github_pr_mergeability",
			"github_pr_review_list",
			"github_pr_update",
			"github_repo_get",
			"github_review_create",
			"github_run_job_list",
			"github_run_list",
			"gmail_attachment_to_drive",
			"gmail_draft",
			"gmail_labels",
			"gmail_modify",
			"gmail_priority_triage",
			"gmail_read",
			"gmail_reconcile",
			"gmail_search",
			"gmail_send_draft",
			"gmail_triage_metrics",
			"gmail_unsubscribe_batch",
			"graph_export_rdf",
			"graph_filter",
			"graph_node_level",
			"hot_tier_candidates",
			"ingest_discover",
			"ingest_drive",
			"ingest_github",
			"ingest_meeting_notes",
			"ingest_meeting_notes_detect",
			"ingest_slack",
			"instructions_get",
			"instructions_mark_pasted",
			"integration_list",
			"integration_set",
			"job_application_upsert",
			"job_hunt_gmail_ingest",
			"job_list",
			"job_pipeline_read",
			"knowledge_search",
			"ledger_query",
			"link_create",
			"link_delete",
			"link_get",
			"link_query",
			"link_upsert",
			"linkedin_post",
			"mcp_result_probe",
			"meeting_create",
			"meta_ads_call_tool",
			"meta_ads_list_tools",
			"notion_block_delete",
			"notion_comment_create",
			"notion_comment_list",
			"notion_completed_at_stamp",
			"notion_config_get",
			"notion_database_get",
			"notion_database_query",
			"notion_page_create",
			"notion_page_get",
			"notion_page_update",
			"notion_search",
			"notion_user_list",
			"onedrive_audit_vs_gdrive",
			"onedrive_copy_to_gdrive",
			"onedrive_create_folder",
			"onedrive_delete",
			"onedrive_get_metadata",
			"onedrive_get_quota",
			"onedrive_list",
			"onedrive_move",
			"onedrive_read_file",
			"onedrive_rename",
			"onedrive_search",
			"onedrive_upload_file",
			"person_create",
			"person_delete",
			"person_get",
			"person_match",
			"person_query",
			"person_self",
			"person_update",
			"person_upsert",
			"planning_edit",
			"planning_read",
			"posthog_connections",
			"posthog_project_filter",
			"posthog_query",
			"posthog_query_debug",
			"posthog_write",
			"relationship_crud",
			"revenuecat_get_metrics",
			"review_lesson_record",
			"review_list",
			"review_resolve",
			"sheets_read",
			"sheets_write",
			"slack_message_delete",
			"slack_message_update",
			"slack_post",
			"slack_reaction_add",
			"slack_read_channel",
			"slack_read_thread",
			"slack_search",
			"state_doc_update",
			"store_schema",
			"task_create",
			"task_crud",
			"view_screen",
			"weekly_kpi_snapshot",
			"whatsapp_ingest",
			"whatsapp_list_chats",
			"whatsapp_read_messages",
			"whatsapp_status",
		]);
	});

	it("case 2: two calls return two distinct registries; registering into one leaves the other unchanged", () => {
		const reg1 = buildRegistry({});
		const reg2 = buildRegistry({});

		const base = buildRegistry({}).size;

		expect(reg1).not.toBe(reg2);
		expect(reg1.size).toBe(base);
		expect(reg2.size).toBe(base);

		const extraAction = defineAction({
			id: "extra_temp_action",
			description: "Extra action for isolation test",
			schema: z.object({}),
			run: async () => ({ ok: true }),
		});

		reg1.register(extraAction);
		expect(reg1.has("extra_temp_action")).toBe(true);
		expect(reg1.size).toBe(base + 1);

		expect(reg2.has("extra_temp_action")).toBe(false);
		expect(reg2.size).toBe(base);
	});


	it("case 3: rejects with AdapterUnavailableError naming notion when unwired, reaches port when wired", async () => {
		const regUnwired = buildRegistry({});
		const action = regUnwired.get("notion_search")!;
		expect(action).toBeDefined();

		await expect(
			executeAction(action, { domain: "angus" }),
		).rejects.toThrowError(AdapterUnavailableError);

		await expect(
			executeAction(action, { domain: "angus" }),
		).rejects.toThrowError(/notion adapter is not wired/i);

		let searchInvoked = false;
		let querySeen = "";
		const fakeNotionPort: NotionPort = {
			resolveToken: async () => "fake-token",
			search: async (params) => {
				searchInvoked = true;
				querySeen = params.query ?? "";
				return { results: [], has_more: false };
			},
		} as any;

		const regWired = buildRegistry({ notion: fakeNotionPort });
		const wiredAction = regWired.get("notion_search")!;
		const res = await executeAction(wiredAction, { domain: "angus", query: "test-query" });

		expect(searchInvoked).toBe(true);
		expect(querySeen).toBe("test-query");
		expect(res).toBeDefined();
	});

	it("case 4: static check: no file under packages/*/src outside core tests imports defaultActionRegistry from core", () => {
		const pkgDirs = fs.readdirSync(packagesDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && fs.existsSync(path.join(packagesDir, e.name, "src")))
			.map((e) => path.join(packagesDir, e.name, "src"));

		const violations: string[] = [];
		const importRegex = /(?:import|export)\s+.*defaultActionRegistry.*from\s+['"]@ahkms\/core(?:\/actions)?(?:\.js)?['"]/;

		for (const srcDir of pkgDirs) {
			const files = findSourceFiles(srcDir);
			for (const file of files) {
				const content = fs.readFileSync(file, "utf8");
				if (importRegex.test(content)) {
					violations.push(file);
				}
			}
		}

		expect(violations).toEqual([]);
	});
});
